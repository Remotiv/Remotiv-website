"""
Config loader — reads YAML configs, resolves paths, merges defaults.

Three config files:
  - model config:   which LLM backend + model params
  - persona config: system prompt + knowledge + voice + avatar
  - tts config:     which TTS engine + engine params

Shared defaults live in PERSONA_DEFAULTS so they're never duplicated.
"""

import os
import yaml
from loguru import logger


# =============================================================================
# Persona defaults — single source of truth
# =============================================================================
PERSONA_DEFAULTS = {
    "name": "Default Assistant",
    "system_prompt": (
        "You are a helpful, conversational AI assistant. "
        "Keep your answers clear and concise. Speak naturally."
    ),
    "output_instructions": (
        "IMPORTANT: Keep your answers conversational and concise (3-5 sentences). "
        "No markdown, no bullet points, no numbered lists. Speak naturally as if in conversation. "
        "When the user sends audio, answer the question in the audio. Respond in plain text only."
    ),
    "post_input_prompt": "",
    "knowledge": [],
    "tts": {"voice": "af_heart", "lang": "a", "speed": 1.0},
    "avatar": {"reference_image": None},
}


# =============================================================================
# Loaders
# =============================================================================

def load_yaml(path: str) -> dict:
    with open(path, "r") as f:
        return yaml.safe_load(f) or {}


def load_model_config(path: str) -> dict:
    cfg = load_yaml(path)
    assert "backend" in cfg, f"Model config missing 'backend' key: {path}"
    assert "model" in cfg, f"Model config missing 'model' key: {path}"
    logger.info(f"Model config: {path} (backend={cfg['backend']})")
    return cfg


def load_persona_config(path: str) -> dict:
    """Load persona YAML, merge with defaults. YAML only needs overrides."""
    cfg = load_yaml(path)
    config_dir = os.path.dirname(os.path.abspath(path))

    merged = {**PERSONA_DEFAULTS, **cfg}
    merged["tts"] = {**PERSONA_DEFAULTS["tts"], **cfg.get("tts", {})}
    merged["avatar"] = {**PERSONA_DEFAULTS["avatar"], **cfg.get("avatar", {})}

    for entry in merged.get("knowledge", []):
        doc_path = entry.get("path", "")
        if doc_path and not os.path.isabs(doc_path):
            entry["path"] = os.path.join(config_dir, doc_path)

    logger.info(f"Persona config: {path} (name={merged.get('name', 'unnamed')})")
    return merged


def build_persona_from_doc(doc_path: str) -> dict:
    """Build persona config from a raw .txt/.md file. Uses shared defaults."""
    return {
        **PERSONA_DEFAULTS,
        "name": os.path.splitext(os.path.basename(doc_path))[0],
        "knowledge": [
            {"path": os.path.abspath(doc_path), "strategy": "prefix_cache"}
        ],
    }


def load_tts_config(path: str) -> dict:
    cfg = load_yaml(path)
    assert "backend" in cfg, f"TTS config missing 'backend' key: {path}"
    logger.info(f"TTS config: {path} (backend={cfg['backend']})")
    return cfg


# =============================================================================
# Default config paths — relative to the caller's working directory, not
# voxagent's install location, so `voxagent` finds ./configs/ in whichever
# project directory it's run from.
# =============================================================================
_CONFIGS_DIR = os.path.join(os.getcwd(), "configs")

DEFAULT_MODEL_CONFIG = os.path.join(_CONFIGS_DIR, "models", "gemma4_e4b.yaml")
DEFAULT_PERSONA_CONFIG = os.path.join(_CONFIGS_DIR, "personas", "default.yaml")
DEFAULT_TTS_CONFIG = os.path.join(_CONFIGS_DIR, "tts", "kokoro.yaml")