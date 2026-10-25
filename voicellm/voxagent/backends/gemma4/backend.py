"""
Gemma 4 E4B backend — llama-cpp-python + mtmd audio encoder.

Implements LLMBackend so the pipeline never touches llama-cpp internals.
"""

import os
import ctypes
import time
from typing import Iterator, Optional
from loguru import logger

os.environ["GGML_CUDA_DISABLE_GRAPHS"] = "1"

import torch
import llama_cpp
import llama_cpp.mtmd_cpp as mtmd_cpp
from llama_cpp import Llama

from voxagent.backends.base import LLMBackend, TokenEvent, EvalDetail


class Gemma4Backend(LLMBackend):

    def __init__(self, model_config: dict):
        self._model_config = model_config
        mc = model_config["model"]

        # ── Load LLM ──
        model_path = mc["path"]
        logger.info(f"Loading Gemma from {os.path.basename(model_path)}...")
        t0 = time.time()
        self.llm = Llama(
            model_path=model_path,
            n_gpu_layers=mc.get("n_gpu_layers", -1),
            n_ctx=mc.get("context_size", 32768),
            flash_attn=mc.get("flash_attn", False),
            chat_format="gemma",
            verbose=mc.get("verbose", False),
        )
        logger.info(f"  Loaded in {time.time() - t0:.1f}s, n_batch={self.llm.n_batch}")

        # ── Load mtmd (audio encoder) ──
        audio_cfg = model_config.get("audio", {})
        if audio_cfg.get("enabled", False) and audio_cfg.get("mmproj_path"):
            logger.info("Loading mtmd (audio encoder)...")
            self.mtmd_ctx, self.media_marker = self._init_mtmd(audio_cfg["mmproj_path"])
            self._audio_enabled = True
            logger.info(f"  Media marker: '{self.media_marker}'")
        else:
            self.mtmd_ctx = None
            self.media_marker = None
            self._audio_enabled = False
            logger.info("Text-only mode — skipping mtmd")

        # ── KV trim ──
        self._kv_seq_rm = self._discover_kv_seq_rm()

        # ── Stop tokens ──
        self.eos = self.llm.token_eos()
        turn_end = set(self.llm.tokenize("<turn|>".encode(), add_bos=False, special=True))
        self.stop_tokens = {1, 106, 107} | turn_end
        self.stop_tokens.discard(self.eos)

        # ── Generation params ──
        gen_cfg = model_config.get("generation", {})
        self._max_tokens = gen_cfg.get("max_tokens", 1536)
        self._soft_limit = gen_cfg.get("soft_limit", 1400)

        # ── Chat template ──
        self._template = model_config.get("chat_template", {})

        # ── Persona state (set by setup_persona) ──
        self._tokens_pre = None
        self._tokens_post = None
        self._n_pre = 0
        self._interrupted = False

    # =====================================================================
    # Setup
    # =====================================================================

    def setup_persona(self, persona_config: dict):
        tmpl = self._template
        sys_prefix = tmpl.get("system_prefix", "<|turn>system\n")
        sys_suffix = tmpl.get("system_suffix", "<turn|>\n<|turn>user\n")
        post_user = tmpl.get("post_user", "<turn|>\n<|turn>model\n")

        # ── Build system prompt ──
        system_prompt = persona_config.get("system_prompt", "").strip()
        output_instructions = persona_config.get("output_instructions", "").strip()
        if output_instructions:
            system_prompt = system_prompt + "\n\n" + output_instructions

        # ── Load knowledge documents (prefix_cache strategy) ──
        knowledge = persona_config.get("knowledge", [])
        for entry in knowledge:
            if entry.get("strategy") == "prefix_cache":
                doc_path = entry["path"]
                if os.path.isfile(doc_path):
                    with open(doc_path, "r") as f:
                        doc_text = f.read()
                    system_prompt = system_prompt + "\n\n" + doc_text
                    logger.info(f"  Loaded knowledge: {doc_path} ({len(doc_text)} chars)")
                else:
                    logger.warning(f"  Knowledge file not found: {doc_path}")

        # ── Tokenize prefix and post-input tokens ──
        pre_text = f"{sys_prefix}{system_prompt}{sys_suffix}"
        post_text = f"{persona_config.get('post_input_prompt', '')}{post_user}"

        self._tokens_pre = self.llm.tokenize(
            pre_text.encode("utf-8"), add_bos=True, special=True)
        self._tokens_post = self.llm.tokenize(
            post_text.encode("utf-8"), add_bos=False, special=True)
        self._n_pre = len(self._tokens_pre)

        logger.info(f"  Persona prefix: {self._n_pre} tokens, "
                     f"Post-input: {len(self._tokens_post)} tokens")

    def reset_persona_cache(self):
        self.llm._ctx.kv_cache_clear()
        self.llm.n_tokens = 0
        self.llm.eval(self._tokens_pre)
        logger.info(f"Persona cache rebuilt ({self._n_pre} tokens)")

    def warmup(self, warmup_wav_path: Optional[str] = None):
        assert self._tokens_pre is not None, "Call setup_persona() first"

        # ── Text warmup (2 passes for CUDA graphs) ──
        logger.info("Warming up Gemma (text, 2 passes)...")
        t0 = time.perf_counter()
        for _ in range(2):
            list(self.llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user", "content": "Briefly introduce yourself."},
                ],
                max_tokens=32, stream=True,
            ))
        logger.info(f"  Text warmup: {(time.perf_counter() - t0) * 1000:.0f}ms")

        if warmup_wav_path is None or not self._audio_enabled:
            self.llm._ctx.kv_cache_clear()
            self.llm.n_tokens = 0
            self.llm.eval(self._tokens_pre)
            return

        if not os.path.isfile(warmup_wav_path):
            logger.warning(f"Warmup WAV not found: {warmup_wav_path}")
            self.llm._ctx.kv_cache_clear()
            self.llm.n_tokens = 0
            self.llm.eval(self._tokens_pre)
            return

        # ── Audio warmup (cold + warm pass) ──
        logger.info("Warming up audio path...")
        with open(warmup_wav_path, "rb") as f:
            warmup_wav = f.read()

        # Cold pass
        self.llm._ctx.kv_cache_clear()
        self.llm.n_tokens = 0
        t0 = time.perf_counter()
        self.llm.eval(self._tokens_pre)
        logger.info(f"  Persona eval (cold): {(time.perf_counter() - t0) * 1000:.0f}ms "
                     f"({self._n_pre} tokens)")

        t0 = time.perf_counter()
        cold_detail = self.eval_audio(warmup_wav)
        logger.info(f"  Audio eval (cold): {cold_detail.total_ms:.0f}ms")

        t0 = time.perf_counter()
        self.llm.eval(self._tokens_post)
        logger.info(f"  Post eval: {(time.perf_counter() - t0) * 1000:.0f}ms")

        # Warm pass
        self.trim_to_persona()
        t0 = time.perf_counter()
        warm_detail = self.eval_audio(warmup_wav)
        self.llm.eval(self._tokens_post)
        logger.info(f"  Audio+post (warm): {(time.perf_counter() - t0) * 1000:.0f}ms")

        self.trim_to_persona()
        logger.info("Audio warmup done.")

    # =====================================================================
    # Per-turn operations
    # =====================================================================

    def trim_to_persona(self):
        if self._kv_seq_rm is not None:
            self._kv_seq_rm(0, self._n_pre, -1)
            self.llm.n_tokens = self._n_pre
        else:
            self.llm._ctx.kv_cache_clear()
            self.llm.n_tokens = 0
            self.llm.eval(self._tokens_pre)

    def eval_audio(self, wav_bytes: bytes) -> EvalDetail:
        if not self._audio_enabled:
            raise NotImplementedError("Audio not available — mmproj not loaded")

        detail = {}
        t_total = time.perf_counter()

        # ctypes buffer copy
        c_data = (ctypes.c_uint8 * len(wav_bytes)).from_buffer_copy(wav_bytes)

        # Bitmap init (WAV decode → internal PCM)
        t0 = time.perf_counter()
        bitmap = mtmd_cpp.mtmd_helper_bitmap_init_from_buf(
            self.mtmd_ctx, c_data, ctypes.c_size_t(len(wav_bytes)), False)
        detail["bitmap_init_ms"] = round((time.perf_counter() - t0) * 1000, 2)

        # Tokenize (mel + encoder forward → chunk embeddings)
        t0 = time.perf_counter()
        input_text = mtmd_cpp.mtmd_input_text()
        input_text.text = self.media_marker.encode("utf-8")
        input_text.add_special = True
        input_text.parse_special = True
        chunks = mtmd_cpp.mtmd_input_chunks_init()
        bitmap_array = (mtmd_cpp.mtmd_bitmap_p_ctypes * 1)(bitmap)
        mtmd_cpp.mtmd_tokenize(self.mtmd_ctx, chunks, ctypes.byref(input_text), bitmap_array, 1)
        detail["tokenize_ms"] = round((time.perf_counter() - t0) * 1000, 2)

        # Eval audio chunk into LLM KV cache
        n_chunks = mtmd_cpp.mtmd_input_chunks_size(chunks)
        success = False
        detail["chunk_eval_ms"] = 0.0

        for ci in range(n_chunks):
            chunk_ptr = mtmd_cpp.mtmd_input_chunks_get(chunks, ci)
            chunk_type = mtmd_cpp.mtmd_input_chunk_get_type(chunk_ptr)
            if chunk_type == mtmd_cpp.MTMD_INPUT_CHUNK_TYPE_AUDIO:
                new_n_past = ctypes.c_int(0)
                t0 = time.perf_counter()
                ret = mtmd_cpp.mtmd_helper_eval_chunk_single(
                    self.mtmd_ctx, self.llm._ctx.ctx, chunk_ptr,
                    self.llm.n_tokens, 0, self.llm.n_batch, False,
                    ctypes.byref(new_n_past))
                detail["chunk_eval_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                if ret == 0:
                    self.llm.n_tokens = new_n_past.value
                    success = True
                break

        # Cleanup
        mtmd_cpp.mtmd_input_chunks_free(chunks)
        mtmd_cpp.mtmd_bitmap_free(bitmap)

        total_ms = round((time.perf_counter() - t_total) * 1000, 2)

        if not success:
            logger.error("Audio eval failed")

        return EvalDetail(total_ms=total_ms, extra=detail)

    def eval_text(self, user_text: str) -> EvalDetail:
        detail = {}

        t0 = time.perf_counter()
        user_tokens = self.llm.tokenize(
            user_text.encode("utf-8"), add_bos=False, special=True)
        self.llm.eval(user_tokens)
        detail["text_eval_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        detail["text_tokens"] = len(user_tokens)

        t0 = time.perf_counter()
        self.llm.eval(self._tokens_post)
        detail["post_eval_ms"] = round((time.perf_counter() - t0) * 1000, 1)

        total = detail["text_eval_ms"] + detail["post_eval_ms"]
        return EvalDetail(total_ms=round(total, 1), extra=detail)

    def eval_post_input(self) -> float:
        t0 = time.perf_counter()
        self.llm.eval(self._tokens_post)
        return round((time.perf_counter() - t0) * 1000, 1)

    def generate(self) -> Iterator[TokenEvent]:
        if hasattr(self.llm._sampler, 'reset'):
            self.llm._sampler.reset()

        self._interrupted = False
        ntok = 0
        hit_soft = False
        full_text = ""

        for _ in range(self._max_tokens):
            if self._interrupted:
                break

            with self._gpu_guard("llm:decode"):
                token = self.llm._sampler.sample(self.llm._ctx, -1)
                self.llm._sampler.accept(token)

            if token == self.eos or token in self.stop_tokens:
                break

            piece = self.llm.detokenize([token]).decode("utf-8", errors="replace")
            ntok += 1
            full_text += piece

            if ntok >= self._soft_limit and not hit_soft:
                hit_soft = True
            if hit_soft:
                stripped = full_text.rstrip()
                if stripped and stripped[-1] in '.!?':
                    with self._gpu_guard("llm:decode"):
                        self.llm.eval([token])
                    yield TokenEvent(token_id=token, text=piece, is_eos=False)
                    break

            yield TokenEvent(token_id=token, text=piece, is_eos=False)
            with self._gpu_guard("llm:decode"):
                self.llm.eval([token])

    def interrupt(self):
        self._interrupted = True

    @property
    def n_persona_tokens(self) -> int:
        return self._n_pre

    @property
    def supports_audio(self) -> bool:
        return self._audio_enabled

    def close(self):
        if self.mtmd_ctx is not None:
            mtmd_cpp.mtmd_free(self.mtmd_ctx)
            self.mtmd_ctx = None

    # =====================================================================
    # Private helpers
    # =====================================================================

    def _init_mtmd(self, mmproj_path: str):
        ctx_params = mtmd_cpp.mtmd_context_params_default()
        ctx_params.use_gpu = True
        ctx_params.n_threads = 4
        ctx_params.flash_attn_type = llama_cpp.LLAMA_FLASH_ATTN_TYPE_DISABLED
        mtmd_ctx = mtmd_cpp.mtmd_init_from_file(
            mmproj_path.encode("utf-8"), self.llm.model, ctx_params)
        media_marker = mtmd_cpp.mtmd_default_marker().decode("utf-8")
        return mtmd_ctx, media_marker

    def _discover_kv_seq_rm(self):
        for fn_name in ("llama_kv_self_seq_rm", "llama_kv_cache_seq_rm"):
            if hasattr(llama_cpp, fn_name):
                fn = getattr(llama_cpp, fn_name)
                logger.info(f"  KV trim: {fn_name}")
                return lambda seq, p0, p1, _f=fn: _f(self.llm._ctx.ctx, seq, p0, p1)
        for method_name in ("kv_cache_seq_rm",):
            if hasattr(self.llm._ctx, method_name):
                m = getattr(self.llm._ctx, method_name)
                logger.info(f"  KV trim: llm._ctx.{method_name}")
                return m
        logger.warning("  No kv_seq_rm — falling back to full clear")
        return None