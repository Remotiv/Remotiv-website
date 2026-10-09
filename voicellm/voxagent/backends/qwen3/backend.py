"""
Qwen3 backend — llama-cpp-python, text-only (no audio encoder).

Uses ChatML template: <|im_start|>role\ncontent<|im_end|>
"""

import os
import time
from typing import Iterator, Optional
from loguru import logger

os.environ["GGML_CUDA_DISABLE_GRAPHS"] = "1"

import torch
from llama_cpp import Llama

from voxagent.backends.base import LLMBackend, TokenEvent, EvalDetail


class Qwen3Backend(LLMBackend):

    def __init__(self, model_config: dict):
        self._model_config = model_config
        mc = model_config["model"]

        model_path = mc["path"]
        logger.info(f"Loading Qwen3 from {os.path.basename(model_path)}...")
        t0 = time.time()
        self.llm = Llama(
            model_path=model_path,
            n_gpu_layers=mc.get("n_gpu_layers", -1),
            n_ctx=mc.get("context_size", 32768),
            flash_attn=mc.get("flash_attn", True),
            verbose=mc.get("verbose", False),
        )
        logger.info(f"  Loaded in {time.time() - t0:.1f}s, n_batch={self.llm.n_batch}")

        self._kv_seq_rm = self._discover_kv_seq_rm()

        self.eos = self.llm.token_eos()
        im_end_tokens = set(self.llm.tokenize("<|im_end|>".encode(), add_bos=False, special=True))
        endoftext_tokens = set(self.llm.tokenize("<|endoftext|>".encode(), add_bos=False, special=True))
        self.stop_tokens = im_end_tokens | endoftext_tokens
        self.stop_tokens.discard(self.eos)

        gen_cfg = model_config.get("generation", {})
        self._max_tokens = gen_cfg.get("max_tokens", 1536)
        self._soft_limit = gen_cfg.get("soft_limit", 1400)

        self._template = model_config.get("chat_template", {})

        self._tokens_pre = None
        self._tokens_post = None
        self._n_pre = 0
        self._interrupted = False

    def setup_persona(self, persona_config: dict):
        tmpl = self._template
        sys_prefix = tmpl.get("system_prefix", "<|im_start|>system\n")
        sys_suffix = tmpl.get("system_suffix", "<|im_end|>\n<|im_start|>user\n")
        post_user = tmpl.get("post_user", "<|im_end|>\n<|im_start|>assistant\n")

        system_prompt = persona_config.get("system_prompt", "").strip()
        output_instructions = persona_config.get("output_instructions", "").strip()
        if output_instructions:
            system_prompt = system_prompt + "\n\n" + output_instructions

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

        logger.info("Warming up Qwen3 (text, 2 passes)...")
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

        self.llm._ctx.kv_cache_clear()
        self.llm.n_tokens = 0
        self.llm.eval(self._tokens_pre)

    # ── Per-turn operations ──

    def trim_to_persona(self):
        if self._kv_seq_rm is not None:
            self._kv_seq_rm(0, self._n_pre, -1)
            self.llm.n_tokens = self._n_pre
        else:
            self.llm._ctx.kv_cache_clear()
            self.llm.n_tokens = 0
            self.llm.eval(self._tokens_pre)

    def eval_audio(self, wav_bytes: bytes) -> EvalDetail:
        raise NotImplementedError("Qwen3 backend is text-only — no audio encoder")

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
        return False

    def close(self):
        pass

    # ── Private helpers ──

    def _discover_kv_seq_rm(self):
        import llama_cpp
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
