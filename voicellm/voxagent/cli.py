"""
VoxAgent — config-driven AI avatar pipeline.

Usage:
    voxagent                                                          # interactive, default persona
    voxagent --persona-config docs/fifa.txt                           # pass a doc, auto-generates persona
    voxagent --persona-config configs/personas/fifa_expert.yaml       # explicit YAML persona
    voxagent --persona-config docs/fifa.txt --questions audios/       # doc + audio eval
    voxagent --text-only                                              # text input only
"""

import argparse
import os
import json
import multiprocessing as mp
from datetime import datetime
from loguru import logger

from voxagent.config_loader import (
    load_model_config, load_persona_config, load_tts_config,
    build_persona_from_doc,
    DEFAULT_MODEL_CONFIG, DEFAULT_PERSONA_CONFIG, DEFAULT_TTS_CONFIG,
)
from voxagent.backends import create_llm, create_tts
from voxagent.pipeline import VoxPipeline
from voxagent.utils.helpers import read_questions


REPORTS_DIR = "reports"


# =============================================================================
# Resolve persona: .txt/.md → auto-generate dict, .yaml → load normally
# =============================================================================
def resolve_persona(path: str) -> dict:
    if path.endswith((".txt", ".md")):
        logger.info(f"Auto-generating persona from document: {path}")
        return build_persona_from_doc(path)
    else:
        return load_persona_config(path)


# =============================================================================
# Init pipeline from configs
# =============================================================================
def init_pipeline(args):
    model_config = load_model_config(args.model_config)
    persona_config = resolve_persona(args.persona_config)
    tts_config = load_tts_config(args.tts_config)

    if args.text_only:
        if "audio" in model_config:
            model_config["audio"]["enabled"] = False

    llm = create_llm(model_config)
    llm.setup_persona(persona_config)

    warmup_wav = None
    if llm.supports_audio:
        wav_path = model_config.get("audio", {}).get("warmup_wav", "")
        if wav_path and os.path.isfile(wav_path):
            warmup_wav = wav_path
    llm.warmup(warmup_wav_path=warmup_wav)

    tts = create_tts(tts_config, persona_config)

    chunking = tts_config.get("chunking", {})
    pipeline = VoxPipeline(llm, tts, chunking_config=chunking)

    logger.info(f"Pipeline ready: "
                f"LLM={model_config['backend']}, "
                f"TTS={tts_config['backend']}, "
                f"Persona={persona_config.get('name', 'unnamed')}, "
                f"Audio={'yes' if llm.supports_audio else 'no'}")

    return pipeline, llm, tts, persona_config


# =============================================================================
# Interactive mode
# =============================================================================
def run_interactive(pipeline, output_dir):
    logger.info("Interactive mode — type a question, /audio <path.wav>, or /quit")
    logger.info("─" * 50)

    q_num = 0
    history = []

    while True:
        try:
            user_input = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not user_input:
            continue
        if user_input.lower() in ("/quit", "/exit", "/q"):
            break

        q_num += 1
        base = os.path.join(output_dir, f"q{q_num:03d}") if output_dir else None

        if user_input.lower().startswith("/audio "):
            wav_path = user_input[7:].strip()
            if not os.path.isfile(wav_path):
                logger.error(f"File not found: {wav_path}")
                continue
            logger.info(f"[audio] {os.path.basename(wav_path)}")
            response, timing, tts_metrics = pipeline.ask_audio(wav_path=wav_path, base_path=base)
        else:
            response, timing, tts_metrics = pipeline.ask_text(user_input, base)

        fa = tts_metrics.first_audio_latency_ms
        fa_str = f"{fa:.0f}ms" if fa is not None else "n/a"

        logger.info(f"\n{response}\n")
        logger.info(f"  prefill={timing['prefill_total_ms']:.0f}ms | "
                     f"gen={timing['generation_ms']:.0f}ms ({timing['generated_tokens']} tok, "
                     f"{timing['tps']} tok/s) | first-audio={fa_str} | "
                     f"pipeline={timing['pipeline_total_ms']:.0f}ms")

        history.append({
            "q": q_num,
            "input": user_input,
            "input_type": timing.get("input_type", "text"),
            "response": response,
            "first_audio_latency_ms": fa,
            "pipeline_ms": timing.get("pipeline_total_ms"),
            "tps": timing.get("tps"),
            "generated_tokens": timing.get("generated_tokens"),
        })

    if history:
        os.makedirs(REPORTS_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        conv_path = os.path.join(REPORTS_DIR, f"conversation_{ts}.json")
        conv = {
            "timestamp": datetime.now().isoformat(),
            "num_turns": len(history),
            "turns": history,
        }
        with open(conv_path, "w") as f:
            json.dump(conv, f, indent=2)
        logger.info(f"Conversation saved → {conv_path}")


# =============================================================================
# Eval mode
# =============================================================================
def run_eval(pipeline, llm, questions, output_dir, report_path):
    logger.info(f"Evaluating {len(questions)} questions → {report_path}")

    results = []

    for i, wav_path in enumerate(questions, 1):
        q_name = os.path.basename(wav_path)
        logger.info(f"Q{i}/{len(questions)}: {q_name}")
        base = os.path.join(output_dir, f"q{i:02d}_{os.path.splitext(q_name)[0]}")

        response, timing, tts_metrics = pipeline.ask_audio(wav_path=wav_path, base_path=base)

        fa = tts_metrics.first_audio_latency_ms
        fa_str = f"{fa:.0f}ms" if fa is not None else "n/a"
        preview = response[:200] + "..." if len(response) > 200 else response

        logger.info(f"  {preview}")
        logger.info(f"  prefill={timing['prefill_total_ms']:.0f}ms | "
                     f"gen={timing['generation_ms']:.0f}ms ({timing['generated_tokens']} tok, "
                     f"{timing['tps']} tok/s) | first-audio={fa_str} | "
                     f"pipeline={timing['pipeline_total_ms']:.0f}ms")

        results.append({
            "question_wav": wav_path,
            "response": response,
            **timing,
            "first_audio_latency_ms": fa,
            "tts_audio_duration_sec": tts_metrics.audio_duration_sec,
            "tts_num_chunks": tts_metrics.num_chunks,
            "tts_first_chunk_synth_ms": tts_metrics.first_chunk_synth_ms,
            "tts_synth_total_ms": tts_metrics.synth_total_ms,
            "tts_overall_rtf": tts_metrics.overall_rtf,
            "tts_chunk_metrics": tts_metrics.chunk_metrics,
        })

    def avg(lst):
        return round(sum(lst) / len(lst), 1) if lst else None

    fas = [r["first_audio_latency_ms"] for r in results if r.get("first_audio_latency_ms")]
    pipelines = [r["pipeline_total_ms"] for r in results]

    report = {
        "timestamp": datetime.now().isoformat(),
        "persona_tokens": llm.n_persona_tokens,
        "num_questions": len(questions),
        "avg_first_audio_latency_ms": avg(fas),
        "avg_pipeline_ms": avg(pipelines),
        "results": results,
    }

    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    logger.info("=" * 60)
    logger.info(f"Avg first-audio: {avg(fas)}ms | Avg pipeline: {avg(pipelines)}ms")
    logger.info(f"Report: {report_path} | Output: {output_dir}/")
    logger.info("=" * 60)


# =============================================================================
# Main
# =============================================================================
def main():
    parser = argparse.ArgumentParser(description="VoxAgent — config-driven AI avatar pipeline")

    parser.add_argument("--model-config", default=DEFAULT_MODEL_CONFIG,
                        help="Path to model YAML config")
    parser.add_argument("--persona-config", default=DEFAULT_PERSONA_CONFIG,
                        help="Path to persona YAML config OR a .txt/.md document")
    parser.add_argument("--tts-config", default=DEFAULT_TTS_CONFIG,
                        help="Path to TTS engine YAML config")

    parser.add_argument("--questions", default=None,
                        help="Directory of .wav files (eval mode)")
    parser.add_argument("--text-only", action="store_true",
                        help="Disable audio input even if model supports it")
    parser.add_argument("--output", default=None,
                        help="Output directory for audio/reports")

    args = parser.parse_args()

    try:
        mp.set_start_method("spawn")
    except RuntimeError:
        pass

    # ── Derive persona name for output dir ──
    if args.persona_config.endswith((".txt", ".md")):
        persona_name = os.path.splitext(os.path.basename(args.persona_config))[0]
    elif os.path.isfile(args.persona_config):
        import yaml
        with open(args.persona_config) as f:
            persona_name = (yaml.safe_load(f) or {}).get("name", "default")
    else:
        persona_name = "default"
    persona_name = persona_name.lower().replace(" ", "_")

    if args.output:
        output_dir = args.output
    elif args.questions:
        output_dir = os.path.join(REPORTS_DIR, persona_name)
    else:
        output_dir = os.path.join(os.getcwd(), f"{persona_name}_output")
    os.makedirs(output_dir, exist_ok=True)

    pipeline, llm, tts, _ = init_pipeline(args)

    if args.questions:
        questions = read_questions(args.questions)
        report_path = os.path.join(output_dir, f"{persona_name}.json")
        run_eval(pipeline, llm, questions, output_dir, report_path)
    else:
        run_interactive(pipeline, output_dir)

    tts.close()
    llm.close()


if __name__ == "__main__":
    main()
