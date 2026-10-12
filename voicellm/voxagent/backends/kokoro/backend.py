"""
Kokoro-82M TTS backend — process-isolated with decoder shape bucketing.

Implements TTSBackend so the pipeline never touches Kokoro internals.
"""

import time
import queue
import threading
import multiprocessing as mp
import traceback
from typing import Any, Callable, Optional
import numpy as np
import soundfile as _sf
from loguru import logger
import torch._dynamo
import torch
import types
from kokoro import KPipeline
from voxagent.backends.base import TTSBackend, TTSMetrics
from voxagent.backends.kokoro._patched_forward import make_patched_forward

# ── Sentinels ──
_SENTINEL = object()
_QUESTION_END = object()
_JIT_WARMUP = object()

_SAMPLE_RATE = 24000
_TRIM_FRAME_MS = 25
_TRIM_SILENCE_THRESH = 0.003
_TRIM_MIN_GAP_MS = 150
_TRIM_FADE_MS = 10
_TRIM_MAX_POST_RATIO = 0.25
_GAP_PURE_SILENCE_RATIO = 0.33
_TRIM_DEBUG = True
_MURMUR_RATIO = 0.40
_MURMUR_MIN_TAIL_MS = 100


def _trim_tail_murmur(wav, sr: int = _SAMPLE_RATE) -> np.ndarray:
    """Remove Kokoro tail artifacts: hallucinated repeats and trailing murmur."""
    if not isinstance(wav, np.ndarray):
        wav = np.array(wav, dtype=np.float32)
    frame = int(sr * _TRIM_FRAME_MS / 1000)
    n_frames = len(wav) // frame
    if n_frames < 20:
        return wav
    rms = np.array([
        np.sqrt(np.mean(wav[i * frame:(i + 1) * frame] ** 2))
        for i in range(n_frames)
    ])

    # --- Pass 1: cut hallucinated repeats (speech -> silence gap -> new utterance) ---
    min_gap_frames = max(1, int(_TRIM_MIN_GAP_MS / _TRIM_FRAME_MS))
    is_silent = rms < _TRIM_SILENCE_THRESH
    half = n_frames // 2
    gaps = []
    i = half
    while i < n_frames:
        if is_silent[i]:
            start = i
            while i < n_frames and is_silent[i]:
                i += 1
            if i - start >= min_gap_frames:
                gaps.append((start, i))
        else:
            i += 1
    for gap_start, gap_end in reversed(gaps):
        if gap_end >= n_frames:
            continue
        if not np.any(rms[gap_end:] >= _TRIM_SILENCE_THRESH * 5):
            continue
        pre_energy = float(np.sum(rms[:gap_start] ** 2))
        post_energy = float(np.sum(rms[gap_end:] ** 2))
        if pre_energy < 1e-8:
            continue
        post_ratio = post_energy / (pre_energy + post_energy)
        if post_ratio > _TRIM_MAX_POST_RATIO:
            continue
        cut_frame = gap_start + 1
        if _TRIM_DEBUG:
            logger.info(f"[trim] CUT at {cut_frame * _TRIM_FRAME_MS}ms "
                        f"(ratio={post_ratio:.3f}); removed "
                        f"{(n_frames - cut_frame) * _TRIM_FRAME_MS}ms tail")
        wav = wav[:cut_frame * frame].copy()
        n_frames = cut_frame
        rms = rms[:cut_frame]
        break

    # --- Pass 2: trim trailing murmur (sustained low-energy plateau) ---
    if n_frames < 10:
        return wav
    body_end = n_frames * 2 // 3
    body_rms = np.sqrt(np.mean(rms[:body_end] ** 2))
    if body_rms < 1e-4:
        return wav
    murmur_ceil = body_rms * _MURMUR_RATIO
    murmur_floor = 0.008
    min_tail_frames = max(1, int(_MURMUR_MIN_TAIL_MS / _TRIM_FRAME_MS))
    smooth_w = 4
    if n_frames > smooth_w:
        smoothed = np.convolve(rms, np.ones(smooth_w) / smooth_w, mode='valid')
        offset = smooth_w - 1
        last_strong = n_frames
        for j in range(len(smoothed) - 1, -1, -1):
            if smoothed[j] >= murmur_ceil:
                last_strong = j + offset + 1
                break
        tail_frames = n_frames - last_strong
        if tail_frames >= min_tail_frames:
            tail_avg = float(np.mean(rms[last_strong:n_frames]))
            if tail_avg >= murmur_floor:
                wav = wav[:last_strong * frame].copy()

    fade = int(sr * _TRIM_FADE_MS / 1000)
    if fade > 0 and len(wav) > fade:
        wav[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return wav


# =============================================================================
# Worker process (runs in its own CUDA context)
# =============================================================================
def _kokoro_worker(pipe, voice, lang, device, buckets, chunk0_ps_len, stream_priority):
    try:

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.set_float32_matmul_precision('high')
        torch.backends.cudnn.benchmark = False
        torch._dynamo.reset()
        torch._dynamo.config.disable = True

        logger.info(f"[kokoro-worker] Loading KPipeline (voice={voice}, lang={lang}, device={device})...")
        pipeline = KPipeline(lang_code=lang, device=device)
        cached_pack = pipeline.load_voice(voice).to(pipeline.model.device)

        # ── Monkey-patch bucketed forward ──
        patched_fn = make_patched_forward(device, buckets)
        pipeline.model.forward_with_tokens = types.MethodType(patched_fn, pipeline.model)
        logger.info(f"[kokoro-worker] Patched forward_with_tokens with buckets: {buckets}")

        tts_stream = torch.cuda.Stream(priority=stream_priority)

        # ── Bucket warmup ──
        logger.info(f"[kokoro-worker] Warming up {len(buckets)} bucket sizes...")
        t0 = time.perf_counter()
        warmup_texts = [
            "Hi.", "The system went down.", "We restored full capacity quickly.",
            "Customer credits exceeded our projections for the quarter.",
            "The engineering team responded very quickly to all the monitoring alerts.",
            "Database failover completed within minutes of the initial detection of the cascading failure mode.",
            "Post incident review revealed several key findings about our infrastructure and its resilience under extreme load conditions.",
            "Service level agreements were not fully met during the extended outage window period and we need to investigate the root cause.",
        ]
        for text in warmup_texts:
            for _ in range(2):
                try:
                    for gs, ps, audio in pipeline(text, voice=voice, speed=1.0):
                        pass
                except Exception:
                    pass
        torch.cuda.synchronize()

        # ── Chunk-0 padded warmup ──
        _, tokens = pipeline.g2p("The system restored full capacity.")
        for gs, ps, tks in pipeline.en_tokenize(tokens):
            if ps:
                ps_padded = ps + ' ' * max(0, chunk0_ps_len - len(ps))
                for _ in range(3):
                    KPipeline.infer(pipeline.model, ps_padded, cached_pack, speed=1.0)
                break
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        logger.info(f"[kokoro-worker] Warmup done in {(time.perf_counter() - t0) * 1000:.0f}ms")

        # ── Pre-compute JIT replay phonemes ──
        _warmup_ps = None
        _, _wtokens = pipeline.g2p("The system went down quickly.")
        for gs, ps, tks in pipeline.en_tokenize(_wtokens):
            if ps:
                _warmup_ps = ps + ' ' * max(0, chunk0_ps_len - len(ps))
                break

        pipe.send(("ready",))

        # ── Main command loop ──
        while True:
            msg = pipe.recv()
            cmd = msg[0]

            if cmd == "quit":
                break

            if cmd == "end":
                pipe.send(("end_ack",))
                continue

            if cmd == "warmup":
                torch.cuda.synchronize()
                t_w = time.perf_counter()
                KPipeline.infer(pipeline.model, _warmup_ps, cached_pack, speed=1.0)
                torch.cuda.synchronize()
                pipe.send(("warmup_done", (time.perf_counter() - t_w) * 1000))
                continue

            if cmd == "synth":
                _, text, chunk_idx = msg
                try:
                    t0 = time.perf_counter()
                    audio_parts = []

                    if chunk_idx == 0:
                        with torch.cuda.stream(tts_stream):
                            _, tokens = pipeline.g2p(text)
                            tokenized = list(pipeline.en_tokenize(tokens))
                            for gs, ps, tks in tokenized:
                                if not ps:
                                    continue
                                if len(ps) > 510:
                                    ps = ps[:510]
                                n_pad = 0
                                if len(ps) < chunk0_ps_len:
                                    n_pad = chunk0_ps_len - len(ps)
                                    ps = ps + ' ' * n_pad
                                pipeline.model._n_pad_phonemes = n_pad
                                output = KPipeline.infer(pipeline.model, ps, cached_pack, speed=1.0)
                                if output is not None and output.audio is not None:
                                    audio_parts.append(output.audio)
                        pipeline.model._n_pad_phonemes = 0
                        tts_stream.synchronize()
                    else:
                        for gs, ps, audio in pipeline(text, voice=voice, speed=1.0):
                            audio_parts.append(audio)

                    if audio_parts:
                        wav = np.concatenate(audio_parts) if len(audio_parts) > 1 else audio_parts[0]
                        wav = _trim_tail_murmur(wav)
                    else:
                        wav = np.zeros(0, dtype=np.float32)

                    synth_ms = (time.perf_counter() - t0) * 1000
                    audio_dur = len(wav) / _SAMPLE_RATE
                    rtf = (synth_ms / 1000) / audio_dur if audio_dur > 0 else 0.0
                    pipe.send(("audio", wav, {
                        "chunk_idx": chunk_idx, "text_len": len(text),
                        "synth_ms": round(synth_ms, 1),
                        "audio_dur_sec": round(audio_dur, 3), "rtf": round(rtf, 3),
                    }))

                except Exception as e:
                    logger.error(f"[kokoro-worker] ERROR chunk {chunk_idx}: {traceback.format_exc()}")
                    pipe.send(("error", {
                        "chunk_idx": chunk_idx, "text_len": len(text),
                        "synth_ms": 0, "audio_dur_sec": 0, "rtf": 0, "error": str(e),
                    }))

    except Exception as e:
        logger.error(f"[kokoro-worker] FATAL: {traceback.format_exc()}")
        try:
            pipe.send(("fatal", str(e)))
        except Exception:
            pass


# =============================================================================
# KokoroTTSBackend — public interface
# =============================================================================
class KokoroTTSBackend(TTSBackend):

    def __init__(self, tts_config: dict, persona_config: dict):
        self._tts_config = tts_config
        self._sample_rate = tts_config.get("sample_rate", 24000)

        # Voice comes from persona, engine params from tts_config
        tts_persona = persona_config.get("tts", {})
        voice = tts_persona.get("voice", "af_heart")
        lang = tts_persona.get("lang", "a")
        device = tts_config.get("device", "cuda")
        buckets = tts_config.get("decoder_buckets", [128, 192, 256, 320, 384, 512, 768, 1024])
        chunk0_ps_len = tts_config.get("chunk0_ps_len", 40)
        stream_priority = tts_config.get("stream_priority", -3)

        logger.info(f"Spawning Kokoro worker (voice={voice}, lang={lang})...")
        # 'spawn' avoids inheriting a CUDA context already initialized in the parent
        # process (e.g. by an LLM backend loaded first) — fork would crash on CUDA re-init.
        ctx = mp.get_context("spawn")
        self._parent_pipe, child_pipe = ctx.Pipe()
        self._worker = ctx.Process(
            target=_kokoro_worker,
            args=(child_pipe, voice, lang, device, buckets, chunk0_ps_len, stream_priority),
            daemon=True, name="kokoro-worker",
        )
        self._worker.start()

        msg = self._parent_pipe.recv()
        if msg[0] == "ready":
            logger.info("Kokoro worker ready")
        elif msg[0] == "fatal":
            raise RuntimeError(f"Kokoro worker failed: {msg[1]}")
        else:
            raise RuntimeError(f"Unexpected worker message: {msg}")

        # ── Internal state ──
        self._synth_queue = queue.Queue()
        self._wavs_lock = threading.Lock()
        self._current_wavs = []
        self._question_done = threading.Event()
        self._first_chunk_done = threading.Event()
        self._submit_time = None
        self._first_audio_ready_time = None
        self._first_audio_latency = None
        self._chunk_metrics = []
        self._stopped = threading.Event()
        self._on_audio = None

        self._synth_thread = threading.Thread(
            target=self._synthesis_loop, daemon=True)
        self._synth_thread.start()

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    def begin_question(self, on_audio: Optional[Callable[[int, Any], None]] = None):
        # Set before anything can be submitted, so no chunk of this question can
        # be synthesized while the hook is still the previous question's.
        self._on_audio = on_audio
        print('On Audio Func',on_audio)
        with self._wavs_lock:
            self._current_wavs = []
        self._submit_time = time.perf_counter()
        self._first_audio_ready_time = None
        self._first_audio_latency = None
        self._chunk_metrics = []
        self._question_done.clear()
        self._first_chunk_done.clear()

    def wait_first_chunk(self, timeout: float = 2.0):
        self._first_chunk_done.wait(timeout=timeout)

    def submit(self, text: str, chunk_idx: int):
        self._synth_queue.put((text, chunk_idx))

    def finish_question(self, base_path: Optional[str] = None) -> TTSMetrics:
        self._synth_queue.put(_QUESTION_END)
        self._question_done.wait()

        with self._wavs_lock:
            wavs = list(self._current_wavs)
        cm = self._chunk_metrics

        all_wav_paths = []
        first_dur = rest_dur = 0.0

        for idx, wav in enumerate(wavs):
            dur = len(wav) / self._sample_rate
            if idx == 0:
                first_dur = dur
            else:
                rest_dur += dur

            path = None
            if base_path and len(wav) > 0:
                path = f"{base_path}_chunk{idx:02d}.wav"
                try:
                    _sf.write(path, wav, self._sample_rate)
                except Exception as e:
                    logger.warning(f"Save failed {path}: {e}")
                    path = None
            if path:
                all_wav_paths.append(path)
            if idx < len(cm):
                cm[idx]["wav_path"] = path

        total_dur = first_dur + rest_dur
        first_synth = cm[0]["synth_ms"] if cm else 0.0
        total_synth = sum(c["synth_ms"] for c in cm)
        overall_rtf = (total_synth / 1000) / total_dur if total_dur > 0 else 0.0

        return TTSMetrics(
            first_audio_latency_ms=(
                round(self._first_audio_latency * 1000, 1)
                if self._first_audio_latency is not None else None),
            audio_duration_sec=round(total_dur, 3),
            num_chunks=len(cm),
            first_chunk_synth_ms=round(first_synth, 1),
            synth_total_ms=round(total_synth, 1),
            overall_rtf=round(overall_rtf, 3),
            chunk_metrics=cm,
            first_wav_path=all_wav_paths[0] if all_wav_paths else None,
            all_wav_paths=all_wav_paths,
        )

    def warmup(self):
        self._synth_queue.put(_JIT_WARMUP)

    def close(self):
        self._stopped.set()
        self._synth_queue.put(_SENTINEL)
        self._synth_thread.join(timeout=5)
        try:
            self._parent_pipe.send(("quit",))
            self._worker.join(timeout=10)
            if self._worker.is_alive():
                self._worker.terminate()
        except Exception:
            pass

    # ── Internal synthesis loop ──

    def _emit_audio(self, chunk_idx: int, wav):
        """Hand a finished chunk to the streaming hook; never let it kill the loop."""
        hook = self._on_audio
        if hook is None or len(wav) == 0:
            return
        try:
            hook(chunk_idx, wav)
        except Exception:
            logger.error(f"on_audio hook failed for chunk {chunk_idx}: "
                         f"{traceback.format_exc()}")

    def _synthesis_loop(self):
        while not self._stopped.is_set():
            item = self._synth_queue.get()
            if item is _SENTINEL:
                break
            if item is _JIT_WARMUP:
                try:
                    self._parent_pipe.send(("warmup",))
                    self._parent_pipe.recv()
                except Exception:
                    pass
                continue
            if item is _QUESTION_END:
                self._parent_pipe.send(("end",))
                self._parent_pipe.recv()
                self._question_done.set()
                continue

            text, chunk_idx = item
            try:
                self._parent_pipe.send(("synth", text, chunk_idx))
                resp = self._parent_pipe.recv()

                if resp[0] == "audio":
                    _, wav, metrics = resp
                    self._chunk_metrics.append(metrics)
                    if self._first_audio_ready_time is None:
                        self._first_audio_ready_time = time.perf_counter()
                        if self._submit_time is not None:
                            self._first_audio_latency = (
                                self._first_audio_ready_time - self._submit_time)
                    with self._wavs_lock:
                        self._current_wavs.append(wav)
                    if chunk_idx == 0:
                        self._first_chunk_done.set()
                    # Last, and on this thread: a streaming consumer blocking in
                    # here must not delay the first-chunk gate, and must delay
                    # the next chunk's dispatch (that is the backpressure).
                    self._emit_audio(chunk_idx, wav)

                elif resp[0] == "error":
                    _, metrics = resp
                    self._chunk_metrics.append(metrics)
                    with self._wavs_lock:
                        self._current_wavs.append(np.zeros(0, dtype=np.float32))
                    if chunk_idx == 0:
                        self._first_chunk_done.set()

            except Exception as e:
                logger.error(f"Dispatch error chunk {chunk_idx}: {traceback.format_exc()}")
                self._chunk_metrics.append({
                    "chunk_idx": chunk_idx, "text_len": len(text),
                    "synth_ms": 0, "audio_dur_sec": 0, "rtf": 0, "error": str(e),
                })
                with self._wavs_lock:
                    self._current_wavs.append(np.zeros(0, dtype=np.float32))
                if chunk_idx == 0:
                    self._first_chunk_done.set()
