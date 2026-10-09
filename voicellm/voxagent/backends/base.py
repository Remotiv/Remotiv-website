"""
Abstract backend interfaces for LLM and TTS.

All model-specific and engine-specific code lives behind these ABCs.
The pipeline, server, orchestrator — nothing above this layer ever
imports a concrete backend directly.
"""

from abc import ABC, abstractmethod
from contextlib import nullcontext
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Optional


# =============================================================================
# LLM Backend
# =============================================================================

@dataclass
class TokenEvent:
    """Single token emitted during generation."""
    token_id: int
    text: str
    is_eos: bool = False


@dataclass
class EvalDetail:
    """Timing breakdown from an eval operation."""
    total_ms: float = 0.0
    extra: dict = field(default_factory=dict)


class LLMBackend(ABC):
    """
    Abstract LLM backend.

    Concrete implementations handle model loading, prompt formatting,
    audio/text eval, KV caching, and token generation.

    Lifecycle:
        backend = SomeBackend(model_config)
        backend.setup_persona(persona_config)
        backend.warmup()

        # Per turn:
        backend.trim_to_persona()
        backend.eval_audio(wav_bytes)   # or eval_text(text)
        backend.eval_post_input()
        for event in backend.generate():
            ...

    GPU sharing:
        A backend that runs on the same device as another engine (e.g. a
        TensorRT renderer) can be handed a lock via set_gpu_lock() so its
        device-touching calls take turns with that engine instead of
        overlapping. See set_gpu_lock() / _gpu_guard() below.
    """

    # Set via set_gpu_lock(); None means no external engine shares this GPU,
    # so device-touching calls run unguarded.
    _gpu_lock = None

    def set_gpu_lock(self, lock) -> None:
        """
        Share a GPU mutual-exclusion lock with another engine on the same
        device (e.g. a renderer whose TensorRT engine corrupts output if
        something else submits work mid-inference).

        Duck-typed on purpose: ``lock`` only needs to expose
        ``hold_sync(label, sync=None, timeout=None)`` as a context manager —
        this module never imports the caller's lock implementation.
        """
        self._gpu_lock = lock

    def _gpu_guard(self, label: str):
        """
        Hold ``self._gpu_lock`` around one device-touching call, or a no-op
        if none was injected. Keep the guarded region to a single call (or a
        couple of tightly related ones) — wrapping anything that can block on
        a queue another engine drains risks a deadlock (see generate()'s
        per-token use in the gemma4 backend for the intended granularity).

        A per-turn method that is already invoked from inside a caller-held
        lock (e.g. eval_audio()/eval_post_input()/trim_to_persona() during an
        audio-prefill call some orchestrators bracket externally) must NOT
        also wrap itself in _gpu_guard() — the lock is expected to be a plain
        non-reentrant mutex, so a second acquire from the same thread hangs
        rather than raising.
        """
        if self._gpu_lock is None:
            return nullcontext()
        return self._gpu_lock.hold_sync(label, sync=None)

    @abstractmethod
    def __init__(self, model_config: dict):
        """Load model into VRAM using model_config."""
        ...

    @abstractmethod
    def setup_persona(self, persona_config: dict):
        """
        Build and eval the system prompt from persona_config.

        Reads persona_config keys: system_prompt, output_instructions,
        post_input_prompt, knowledge (list of {path, strategy}).

        After this call, the KV cache contains the persona prefix and
        `n_persona_tokens` is set.
        """
        ...

    @abstractmethod
    def warmup(self, warmup_wav_path: Optional[str] = None):
        """
        Warm up model kernels.

        If warmup_wav_path is provided and audio is supported, also warms
        the audio encoder path and establishes the prefix cache.
        """
        ...

    # ── Per-turn operations ──

    @abstractmethod
    def trim_to_persona(self):
        """Reset KV cache to the persona prefix boundary."""
        ...

    @abstractmethod
    def eval_audio(self, wav_bytes: bytes) -> EvalDetail:
        """
        Encode + eval audio into KV cache.

        Call trim_to_persona() first.
        Raises NotImplementedError if the backend doesn't support audio.
        """
        ...

    @abstractmethod
    def eval_text(self, user_text: str) -> EvalDetail:
        """
        Tokenize + eval a text query into KV cache.

        Call trim_to_persona() first.
        """
        ...

    @abstractmethod
    def eval_post_input(self) -> float:
        """
        Eval post-input turn tokens (e.g. role markers).

        Returns eval time in ms.
        """
        ...

    @abstractmethod
    def generate(self) -> Iterator[TokenEvent]:
        """
        Stream tokens. Yields TokenEvent until EOS or stop condition.

        Generation params (max_tokens, soft_limit, temperature, etc.)
        come from model_config passed at __init__.
        """
        ...

    @abstractmethod
    def interrupt(self):
        """Barge-in: stop generation immediately."""
        ...

    @property
    @abstractmethod
    def n_persona_tokens(self) -> int:
        """Number of tokens in the cached persona prefix."""
        ...

    @property
    @abstractmethod
    def supports_audio(self) -> bool:
        """Whether this backend can process audio input."""
        ...

    @abstractmethod
    def close(self):
        """Release model resources."""
        ...


# =============================================================================
# TTS Backend
# =============================================================================

@dataclass
class TTSChunkMetrics:
    """Per-chunk synthesis metrics."""
    chunk_idx: int
    text_len: int
    synth_ms: float
    audio_dur_sec: float
    rtf: float
    wav_path: Optional[str] = None
    error: Optional[str] = None


@dataclass
class TTSMetrics:
    """Aggregate metrics for a full question's TTS output."""
    first_audio_latency_ms: Optional[float]
    audio_duration_sec: float
    num_chunks: int
    first_chunk_synth_ms: float
    synth_total_ms: float
    overall_rtf: float
    chunk_metrics: list
    # File paths (populated if base_path was given)
    first_wav_path: Optional[str] = None
    all_wav_paths: list = field(default_factory=list)


class TTSBackend(ABC):
    """
    Abstract TTS backend.

    Concrete implementations handle voice loading, synthesis, and
    streaming chunk management.

    Lifecycle:
        tts = SomeTTS(tts_config, persona_config)

        # Per question:
        tts.begin_question()
        tts.submit("Hello.", chunk_idx=0)
        tts.wait_first_chunk()
        tts.submit("More text.", chunk_idx=1)
        metrics = tts.finish_question(base_path="output/q01")

        tts.close()

    A streaming consumer (one that plays or renders audio while the answer is
    still being written) passes ``on_audio`` to begin_question() instead of
    waiting for finish_question().
    """

    @abstractmethod
    def __init__(self, tts_config: dict, persona_config: dict):
        """
        Initialize TTS engine.

        tts_config: engine-specific settings (device, buckets, etc.)
        persona_config: voice/lang/speed from persona YAML
        """
        ...

    @property
    @abstractmethod
    def sample_rate(self) -> int:
        """Audio sample rate in Hz."""
        ...

    @abstractmethod
    def begin_question(self, on_audio: Optional[Callable[[int, Any], None]] = None):
        """
        Reset state for a new question.

        on_audio: optional streaming hook, called as ``on_audio(chunk_idx, wav)``
        for each chunk as soon as its audio exists — in chunk order, before
        finish_question() returns. It runs on the backend's synthesis thread, so
        blocking inside it stalls synthesis: that is how a slow consumer applies
        backpressure. Empty/failed chunks are not reported.
        """
        ...

    @abstractmethod
    def wait_first_chunk(self, timeout: float = 2.0):
        """Block until chunk 0 synthesis completes."""
        ...

    @abstractmethod
    def submit(self, text: str, chunk_idx: int):
        """Queue a text chunk for synthesis."""
        ...

    @abstractmethod
    def finish_question(self, base_path: Optional[str] = None) -> TTSMetrics:
        """Signal end-of-question, wait for all chunks, return metrics."""
        ...

    @abstractmethod
    def warmup(self):
        """Run a JIT warmup — call during idle, not during generation."""
        ...

    @abstractmethod
    def close(self):
        """Shut down engine and release resources."""
        ...
