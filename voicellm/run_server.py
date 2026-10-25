"""
Launch the VoxAgent interview server.

Usage (from project root):
    pixi run python voicellm/run_server.py
    pixi run python voicellm/run_server.py --port 8000 --text-only
    pixi run python voicellm/run_server.py --ws-secret MY_SECRET
"""

import argparse
import multiprocessing as mp
import os

import uvicorn
from loguru import logger

from voxagent.cli import init_pipeline
from voxagent.server import create_app

_VOICELLM_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIGS_DIR = os.path.join(_VOICELLM_DIR, "configs")

DEFAULT_MODEL_CONFIG = os.path.join(_CONFIGS_DIR, "models", "qwen3_30b_a3b.yaml")
DEFAULT_PERSONA_CONFIG = os.path.join(_CONFIGS_DIR, "personas", "default.yaml")
DEFAULT_TTS_CONFIG = os.path.join(_CONFIGS_DIR, "tts", "kokoro.yaml")


def main():
    parser = argparse.ArgumentParser(description="VoxAgent Interview Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--model-config", default=DEFAULT_MODEL_CONFIG)
    parser.add_argument("--persona-config", default=DEFAULT_PERSONA_CONFIG)
    parser.add_argument("--tts-config", default=DEFAULT_TTS_CONFIG)
    parser.add_argument("--text-only", action="store_true")
    parser.add_argument("--ws-secret", default=os.environ.get("VOXAGENT_WS_SECRET", "dev-secret"))
    args = parser.parse_args()

    try:
        mp.set_start_method("spawn")
    except RuntimeError:
        pass

    logger.info("Initializing pipeline...")
    pipeline, llm, tts, persona_config = init_pipeline(args)

    app = create_app(pipeline, ws_secret=args.ws_secret)

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, ws_ping_interval=20, ws_ping_timeout=30)

    tts.close()
    llm.close()


if __name__ == "__main__":
    main()
