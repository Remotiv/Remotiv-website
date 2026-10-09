"""
Backend registry and factories.

Adding a new LLM or TTS engine:
  1. Create modules/backends/<name>/backend.py implementing LLMBackend or TTSBackend
  2. Register it in the dict below
  3. Create configs/<models|tts>/<name>.yaml
  4. Done — pipeline and main.py don't change
"""

from voxagent.backends.base import LLMBackend, TTSBackend, TokenEvent, EvalDetail, TTSMetrics

# ── Registry ──
# Lazy imports so we don't pull in torch/llama_cpp until actually needed.

_LLM_BACKENDS = {
    "gemma4": "voxagent.backends.gemma4.backend:Gemma4Backend",
    "qwen3": "voxagent.backends.qwen3.backend:Qwen3Backend",
}

_TTS_BACKENDS = {
    "kokoro": "voxagent.backends.kokoro.backend:KokoroTTSBackend",
}


def _import_class(dotted_path: str):
    """Import 'package.module:ClassName' lazily."""
    module_path, class_name = dotted_path.rsplit(":", 1)
    import importlib
    mod = importlib.import_module(module_path)
    return getattr(mod, class_name)


def create_llm(model_config: dict) -> LLMBackend:
    """Instantiate LLM backend from model config."""
    backend_name = model_config["backend"]
    if backend_name not in _LLM_BACKENDS:
        raise ValueError(
            f"Unknown LLM backend '{backend_name}'. "
            f"Available: {list(_LLM_BACKENDS.keys())}")
    cls = _import_class(_LLM_BACKENDS[backend_name])
    return cls(model_config)


def create_tts(tts_config: dict, persona_config: dict) -> TTSBackend:
    """Instantiate TTS backend from TTS + persona configs."""
    backend_name = tts_config["backend"]
    if backend_name not in _TTS_BACKENDS:
        raise ValueError(
            f"Unknown TTS backend '{backend_name}'. "
            f"Available: {list(_TTS_BACKENDS.keys())}")
    cls = _import_class(_TTS_BACKENDS[backend_name])
    return cls(tts_config, persona_config)
