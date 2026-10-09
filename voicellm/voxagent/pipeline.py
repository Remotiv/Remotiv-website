"""
VoxAgent pipeline — model-agnostic audio/text question processing.

Uses LLMBackend and TTSBackend abstractions only. No concrete backend
imports. Swap model or TTS engine by changing config, not code.
"""

import time
from loguru import logger

from voxagent.backends.base import LLMBackend, TTSBackend
from voxagent.backends.kokoro.text_utils import sanitize_for_tts, split_for_tts


class VoxPipeline:
    """
    Orchestrates LLM + TTS for a single question→answer→audio cycle.

    Holds references to backend instances and chunking params.
    The pipeline itself is stateless per-turn — all state lives in the backends.
    """

    def __init__(self, llm: LLMBackend, tts: TTSBackend, chunking_config: dict = None):
        self.llm = llm
        self.tts = tts

        # Text splitting params (from tts config or defaults)
        cc = chunking_config or {}
        self._first_chunk_chars = cc.get("first_chunk_chars", 20)
        self._first_chunk_max = cc.get("first_chunk_max", 40)
        self._min_chunk_chars = cc.get("min_chunk_chars", 60)
        self._max_buffer_chars = cc.get("max_buffer_chars", 200)

    def ask_audio(self, wav_path=None, wav_bytes=None, base_path=None, on_audio_chunk=None):
        """Process an audio question. Returns (response, timing, tts_metrics)."""
        read_ms = None
        if wav_bytes is None:
            t0 = time.perf_counter()
            with open(wav_path, "rb") as f:
                wav_bytes = f.read()
            read_ms = round((time.perf_counter() - t0) * 1000, 2)

        timing, t_pipeline = self.prefill_audio(wav_bytes)
        if read_ms is not None:
            timing["wav_read_ms"] = read_ms

        return self.stream_response(timing, t_pipeline, base_path, on_audio_chunk)

    def prefill_audio(self, wav_bytes):
        """
        Evaluate an audio question into the LLM's KV cache, up to the point where
        generation could start. Returns (timing, t_pipeline) to hand to
        stream_response().

        Split out of ask_audio() for callers that need the prefill on its own —
        the rtr orchestrator brackets exactly this in its GPU lock, because the
        mtmd audio encoder runs on the same device as the avatar renderer.
        """
        timing = {}
        t_pipeline = time.perf_counter()
        timing["wav_size_bytes"] = len(wav_bytes)
        timing["input_type"] = "audio"

        # ── Trim ──
        t0 = time.perf_counter()
        self.llm.trim_to_persona()
        timing["kv_trim_ms"] = round((time.perf_counter() - t0) * 1000, 2)

        # ── Audio eval ──
        t0 = time.perf_counter()
        audio_detail = self.llm.eval_audio(wav_bytes)
        timing["audio_eval_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        timing["audio_detail"] = audio_detail.extra

        # ── Post-input eval ──
        t0 = time.perf_counter()
        self.llm.eval_post_input()
        timing["post_eval_ms"] = round((time.perf_counter() - t0) * 1000, 1)

        timing["prefill_total_ms"] = round(
            timing["kv_trim_ms"] + timing["audio_eval_ms"] + timing["post_eval_ms"], 1)

        return timing, t_pipeline

    def ask_text(self, user_text, base_path=None, on_audio_chunk=None):
        """Process a text question. Returns (response, timing, tts_metrics)."""
        timing = {}
        t_pipeline = time.perf_counter()
        timing["input_type"] = "text"

        # ── Trim ──
        t0 = time.perf_counter()
        self.llm.trim_to_persona()
        timing["kv_trim_ms"] = round((time.perf_counter() - t0) * 1000, 2)

        # ── Text eval (includes post-input) ──
        text_detail = self.llm.eval_text(user_text)
        timing["text_eval_ms"] = text_detail.extra.get("text_eval_ms", 0)
        timing["text_tokens"] = text_detail.extra.get("text_tokens", 0)
        timing["post_eval_ms"] = text_detail.extra.get("post_eval_ms", 0)
        timing["prefill_total_ms"] = round(
            timing["kv_trim_ms"] + text_detail.total_ms, 1)

        return self.stream_response(timing, t_pipeline, base_path, on_audio_chunk)

    def stream_response(self, timing, t_pipeline, base_path=None, on_audio_chunk=None,
                        pace=None):
        """
        Generation + TTS streaming loop for an already-prefilled turn.

        on_audio_chunk: optional ``(chunk_idx, wav)`` hook handed to the TTS
        backend, so a consumer can take each chunk's audio as it is synthesized
        instead of waiting for the whole answer. See TTSBackend.begin_question().

        pace: optional ``(chunk_idx) -> bool`` gate, called right *after* each
        chunk is submitted. It blocks while the consumer is behind, which is what
        lets a downstream stage schedule itself against generation instead of
        merely buffering whatever the decode loop produces. Returns False to
        abandon the rest of the answer (barge-in); the tail flush is then skipped
        and only ``finish_question()`` runs, so the TTS backend still lands in a
        clean state for the next turn.

        Two reasons the gate sits at a chunk boundary rather than a token count.
        A boundary is the first point where audio is actually forthcoming — pause
        after N tokens instead and the whole burst may still be sitting in
        ``buffer``, so a consumer waiting on audio waits on something that never
        arrives. And the call lands at a ``yield`` point of ``llm.generate()``,
        which is outside its per-token GPU guard: a generator paused here holds
        no device lock, so a consumer sharing the GPU gets it to itself.
        """
        self.tts.begin_question(on_audio=on_audio_chunk)

        t_gen = time.perf_counter()
        ttft = None
        parts = []
        buffer = ""
        is_first_chunk = True
        chunk_idx = 0
        pace_wait = 0.0
        abandoned = False

        def submit_chunk(text):
            """Submit one chunk, then let the consumer pace us. False -> stop."""
            nonlocal chunk_idx, is_first_chunk, pace_wait
            self.tts.submit(text, chunk_idx)
            if chunk_idx == 0:
                self.tts.wait_first_chunk()
            submitted = chunk_idx
            chunk_idx += 1
            is_first_chunk = False
            if pace is None:
                return True
            t0 = time.perf_counter()
            try:
                return pace(submitted)
            finally:
                pace_wait += time.perf_counter() - t0

        for event in self.llm.generate():
            if ttft is None:
                ttft = time.perf_counter() - t_gen
            parts.append(event.text)
            buffer += event.text

            new_chunks, buffer = split_for_tts(
                buffer, is_first_chunk,
                first_chunk_chars=self._first_chunk_chars,
                first_chunk_max=self._first_chunk_max,
                min_chunk_chars=self._min_chunk_chars,
                max_buffer_chars=self._max_buffer_chars,
            )
            for c in new_chunks:
                c_clean = sanitize_for_tts(c)
                if c_clean and not submit_chunk(c_clean):
                    abandoned = True
                    break
            if abandoned:
                break

        gen_ms = (time.perf_counter() - t_gen) * 1000
        gen_pace_wait = pace_wait      # snapshot: the tail flush paces too

        # ── Flush remaining buffer ──
        if abandoned:
            logger.info(f"Answer abandoned by pacer after {chunk_idx} chunks")
        elif buffer.strip():
            tail_chunks, leftover = split_for_tts(
                buffer, is_first_chunk=False,
                first_chunk_chars=self._first_chunk_chars,
                first_chunk_max=self._first_chunk_max,
                min_chunk_chars=self._min_chunk_chars,
                max_buffer_chars=self._max_buffer_chars,
            )
            leftover_clean = sanitize_for_tts(leftover)
            if leftover_clean:
                tail_chunks.append(leftover_clean)
            for c in tail_chunks:
                c_clean = sanitize_for_tts(c)
                if c_clean and not submit_chunk(c_clean):
                    break

        tts_metrics = self.tts.finish_question(base_path)

        ntok = len(parts)
        pace_ms = pace_wait * 1000
        # Decode time with the pacing waits taken out: gen_ms is wall-clock, and
        # a paced turn spends much of it parked at a yield point rather than
        # decoding, which would otherwise read as a collapse in tokens/sec.
        decode_ms = max(gen_ms - gen_pace_wait * 1000, 0.0)
        timing["ttft_ms"] = round(ttft * 1000, 1) if ttft else None
        timing["generation_ms"] = round(gen_ms, 1)
        timing["pace_wait_ms"] = round(pace_ms, 1)
        timing["generated_tokens"] = ntok
        timing["abandoned"] = abandoned
        timing["tps"] = round(ntok / (decode_ms / 1000), 1) if decode_ms > 0 else 0
        timing["pipeline_total_ms"] = round((time.perf_counter() - t_pipeline) * 1000, 1)
        timing["audio_ttft_ms"] = round(
            timing["prefill_total_ms"] + (timing["ttft_ms"] or 0), 1)

        response = "".join(parts).strip()
        return response, timing, tts_metrics
