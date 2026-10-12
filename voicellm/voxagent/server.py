"""
VoxAgent interview server — FastAPI + WebSocket wrapper around VoxPipeline.

Endpoints:
  POST   /v1/cv/parse              Upload + parse CV PDF → text
  POST   /v1/sessions              Create an interview session
  WS     /v1/sessions/{id}/ws      Real-time audio streaming
  POST   /v1/sessions/{id}/finalize  Return full transcript
  GET    /v1/health                Health check

Audio format:
  Upstream (mic):   PCM s16le, 16 kHz mono — raw bytes over binary WS frames
  Downstream (TTS): PCM s16le, 24 kHz mono — raw bytes over binary WS frames
  Control messages: JSON over text WS frames
"""

import asyncio
import hashlib
import hmac
import io
import json
import time
import uuid
import wave
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from loguru import logger
from pydantic import BaseModel

from voxagent.cv_parser import parse_cv_bytes
from voxagent.pipeline import VoxPipeline

UPSTREAM_SAMPLE_RATE = 16000
UPSTREAM_CHANNELS = 1
UPSTREAM_SAMPLE_WIDTH = 2  # s16le


class SessionState(str, Enum):
    CREATED = "created"
    CONNECTED = "connected"
    INTERVIEWING = "interviewing"
    FINALIZED = "finalized"


@dataclass
class TranscriptTurn:
    role: str  # "interviewer" or "candidate"
    question_id: int
    question_order: int
    turn_type: str  # "base_question" | "follow_up" | "clarification" | "answer" | "acknowledgment"
    text: str
    turn_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    responds_to_turn_id: str | None = None
    base_question_id: str = ""
    offset_seconds: float | None = None
    follow_up_reason: str | None = None
    audio_file: str | None = None
    interviewer_audio_file: str | None = None
    audio_duration_seconds: float | None = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class InterviewSession:
    session_id: str
    questions: list[dict]  # [{text, id, ...}]
    interviewer_name: str
    candidate_first_name: str
    persona_config: dict
    follow_up_rules: dict
    max_follow_ups: int
    max_session_seconds: int
    cv_text: str = ""
    jd: dict = field(default_factory=dict)
    state: SessionState = SessionState.CREATED
    current_question_idx: int = 0
    follow_up_count: int = 0
    transcript: list[TranscriptTurn] = field(default_factory=list)
    ws_token: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    ended_at: Optional[float] = None
    end_reason: str = ""
    audio_buffer: bytes = b""
    _streaming_stt_active: bool = False
    _last_partial_text: str = ""


class CreateSessionRequest(BaseModel):
    session_id: str
    interviewer_name: str
    candidate_first_name: str | None = None
    questions: list[dict] = []
    cv_text: str | None = None
    jd: dict
    persona_config: dict | None = None
    follow_up_rules: dict | None = None
    max_follow_ups_per_question: int = 1
    duration_minutes: int | None = None
    max_session_seconds: int = 1800


class CreateSessionResponse(BaseModel):
    session_id: str
    ws_url: str
    ws_token: str
    upstream_sample_rate: int
    downstream_sample_rate: int
    audio_format: str


class FinalizeResponse(BaseModel):
    session_id: str
    turns: list[dict]
    duration_seconds: float
    questions_completed: int


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int, channels: int = 1, sample_width: int = 2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _wav_to_pcm(wav_bytes: bytes) -> bytes:
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        return wf.readframes(wf.getnframes())


def _sign_token(session_id: str, secret: str) -> str:
    return hmac.new(secret.encode(), session_id.encode(), hashlib.sha256).hexdigest()


def _verify_token(session_id: str, token: str, secret: str) -> bool:
    expected = _sign_token(session_id, secret)
    return hmac.compare_digest(expected, token)


WHISPER_MODEL_SIZE = "medium.en"
STREAMING_TRANSCRIBE_INTERVAL = 1.0


def _init_whisper():
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(WHISPER_MODEL_SIZE, device="cuda", compute_type="float16")
        logger.info(f"Whisper STT loaded (faster-whisper, {WHISPER_MODEL_SIZE}, cuda)")
        return model
    except Exception as e:
        logger.warning(f"Whisper init failed ({e}), candidate audio won't be transcribed")
        return None


def _transcribe_pcm(whisper_model, pcm_data: bytes, sample_rate: int = 16000) -> str:
    if whisper_model is None or not pcm_data:
        return ""
    try:
        audio_np = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
        if len(audio_np) < sample_rate * 0.3:
            return ""
        segments, _ = whisper_model.transcribe(audio_np, language="en", vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()
    except Exception as e:
        logger.error(f"Whisper transcription failed: {e}")
        return ""



def _session_dir(session_id: str) -> Path:
    d = Path("sessions") / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _save_candidate_audio(session: "InterviewSession", pcm_data: bytes, turn_index: int) -> str:
    d = _session_dir(session.session_id)
    filename = f"candidate_turn_{turn_index:03d}.wav"
    path = d / filename
    wav_bytes = _pcm_to_wav(pcm_data, UPSTREAM_SAMPLE_RATE)
    path.write_bytes(wav_bytes)
    return filename


def _save_interviewer_audio(
    session: "InterviewSession",
    pcm_chunks: list[bytes],
    turn_index: int,
    sample_rate: int,
) -> tuple[str | None, float | None]:
    if not pcm_chunks:
        return None, None
    combined = b"".join(pcm_chunks)
    if not combined:
        return None, None
    d = _session_dir(session.session_id)
    filename = f"interviewer_turn_{turn_index:03d}.wav"
    path = d / filename
    wav_bytes = _pcm_to_wav(combined, sample_rate)
    path.write_bytes(wav_bytes)
    duration_seconds = round(len(combined) / (sample_rate * 1 * 2), 3)
    return filename, duration_seconds


def _compute_offset_seconds(session: "InterviewSession") -> float | None:
    if session.started_at is None:
        return None
    return round(time.time() - session.started_at, 3)


def _get_question_uuid(session: "InterviewSession") -> str:
    if session.current_question_idx < len(session.questions):
        return session.questions[session.current_question_idx].get("id", "")
    return ""


def _last_turn_id(session: "InterviewSession", role: str | None = None) -> str | None:
    for t in reversed(session.transcript):
        if role is None or t.role == role:
            return t.turn_id
    return None


def _infer_follow_up_reason(candidate_text: str, interviewer_response: str) -> str:
    lower = interviewer_response.lower()
    if any(w in lower for w in ("specific", "elaborate", "more detail")):
        return "answer_lacked_specifics"
    if "example" in lower:
        return "answer_lacked_examples"
    if any(w in lower for w in ("unclear", "clarify", "understand")):
        return "answer_was_unclear"
    if any(w in lower for w in ("metric", "number", "quantif", "impact", "outcome")):
        return "answer_lacked_measurable_outcomes"
    return "answer_lacked_substance"


def _extract_first_name_from_cv(cv_text: str) -> str | None:
    for line in cv_text.strip().split('\n'):
        stripped = line.strip().lstrip('#').strip()
        if not stripped:
            continue
        if '@' in stripped or stripped.startswith('|') or stripped.startswith('-'):
            continue
        first_name = stripped.split()[0]
        if len(first_name) >= 2 and first_name.isalpha():
            return first_name
    return None


GENERAL_QUESTIONS = [
    {"text": "Tell me about yourself and your experience.", "position": 1},
    {"text": "What is your greatest strength and how have you applied it?", "position": 2},
]


def _generate_cv_questions(cv_text: str) -> list[dict]:
    import re

    questions = []

    lines = cv_text.split('\n')
    experience_sections = []
    current_company = ""
    current_role = ""
    current_bullets = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('## ') and any(kw in stripped.lower() for kw in ['education', 'skills', 'awards', 'projects']):
            if current_company and current_bullets:
                experience_sections.append({
                    "company": current_company,
                    "role": current_role,
                    "bullets": current_bullets[:6],
                })
            current_company = ""
            current_role = ""
            current_bullets = []
            continue

        if stripped.startswith('## ') and not any(kw in stripped.lower() for kw in ['education', 'skills', 'awards', 'final year', 'intelligent', 'fashion', 'top performer']):
            if current_company and current_bullets:
                experience_sections.append({
                    "company": current_company,
                    "role": current_role,
                    "bullets": current_bullets[:6],
                })
            current_company = stripped.replace('## ', '').strip()
            current_role = ""
            current_bullets = []
        elif not stripped.startswith('#') and not stripped.startswith('|') and stripped and current_company:
            if stripped.startswith('- '):
                bullet = stripped[2:].strip()
                project_name = bullet.split(':')[0].strip() if ':' in bullet[:60] else ""
                current_bullets.append({"text": bullet, "project": project_name})
            elif not current_role and stripped and not stripped.startswith('-'):
                current_role = stripped

    if current_company and current_bullets:
        experience_sections.append({
            "company": current_company,
            "role": current_role,
            "bullets": current_bullets[:6],
        })

    pos = 1
    for section in experience_sections:
        company = section["company"]

        questions.append({
            "text": f"Tell me about your role at {company}. What were your main responsibilities and what was the team like?",
            "position": pos,
        })
        pos += 1

        for bullet in section["bullets"]:
            project = bullet["project"]
            if project:
                questions.append({
                    "text": f"Walk me through the {project} work you did at {company}. What was the problem, your approach, and the outcome?",
                    "position": pos,
                })
            else:
                snippet = bullet["text"][:80]
                questions.append({
                    "text": f"You mentioned '{snippet}' at {company}. Can you elaborate on that — what specifically did you do and what was the impact?",
                    "position": pos,
                })
            pos += 1

    return questions


_RESPONSIBILITY_TEMPLATES = [
    "Part of this role is to {resp}. Tell me about a time you did this — what was the situation and what did you deliver?",
    "This position requires someone who can {resp}. Describe a project where you handled this responsibility.",
    "One key expectation is: {resp}. How have you approached this in your previous work?",
    "A core part of the job is to {resp}. Walk me through your experience with this.",
]

_SKILL_TEMPLATES = [
    "Tell me about a project where you worked with {skills}. What did you build and what challenges came up?",
    "How have you applied {skills} in practice? Give me a concrete example.",
    "Describe your hands-on experience with {skills}. What was the context and outcome?",
]


def _generate_jd_questions(jd: dict) -> list[dict]:
    questions = []
    title = jd.get("title", "this role")
    company = jd.get("company", "the company")
    exp_years = jd.get("experience_years")

    responsibilities = jd.get("responsibilities", [])
    for i, resp in enumerate(responsibilities[:4]):
        tmpl = _RESPONSIBILITY_TEMPLATES[i % len(_RESPONSIBILITY_TEMPLATES)]
        resp_lower = resp[0].lower() + resp[1:] if resp else resp
        questions.append({"text": tmpl.format(resp=resp_lower)})

    required_skills = jd.get("required_skills", [])
    for i in range(0, len(required_skills[:6]), 2):
        pair = required_skills[i:i + 2]
        skills_str = " and ".join(pair)
        tmpl = _SKILL_TEMPLATES[i // 2 % len(_SKILL_TEMPLATES)]
        questions.append({"text": tmpl.format(skills=skills_str)})

    nice_to_have = jd.get("nice_to_have", [])
    for skill in nice_to_have[:2]:
        questions.append({
            "text": f"Do you have any experience with {skill}? If so, tell me about it.",
        })

    if exp_years:
        questions.append({
            "text": f"We're looking for someone with around {exp_years} years of experience. "
                    f"How does your background prepare you for the {title} role at {company}?",
        })

    focus_areas = jd.get("interview_focus", [])
    for area in focus_areas[:2]:
        questions.append({
            "text": f"One thing we value is: '{area}'. Can you give me an example from your work that demonstrates this?",
        })

    return questions


def _target_question_count(duration_seconds: int) -> int:
    minutes = duration_seconds / 60
    return max(3, round(minutes / 2))


def _assemble_questions(
    frontend_questions: list[dict],
    cv_text: str,
    jd: dict | None,
    target_count: int,
) -> list[dict]:
    if frontend_questions:
        return frontend_questions

    questions = [dict(q) for q in GENERAL_QUESTIONS]

    jd_questions = _generate_jd_questions(jd) if jd else []
    cv_questions = _generate_cv_questions(cv_text) if cv_text else []

    remaining = target_count - len(questions)
    if remaining <= 0:
        return questions

    if jd_questions and cv_questions:
        jd_share = round(remaining * 0.5)
        cv_share = remaining - jd_share
        selected_jd = jd_questions[:jd_share]
        selected_cv = cv_questions[:cv_share]
        combined = selected_jd + selected_cv
    elif jd_questions:
        combined = jd_questions[:remaining]
    else:
        combined = cv_questions[:remaining]

    pos = len(questions) + 1
    for q in combined:
        q["position"] = pos
        pos += 1
    questions.extend(combined)

    closing = [
        {"text": "Looking back across everything you've worked on, what are you most proud of technically and why?"},
        {"text": "Where do you see yourself heading next in your career, and what kind of problems excite you most?"},
    ]
    for cq in closing:
        if len(questions) < target_count + 2:
            cq["position"] = pos
            pos += 1
            questions.append(cq)

    return questions


def _save_session_json(session: "InterviewSession"):
    d = _session_dir(session.session_id)

    duration = 0.0
    if session.started_at:
        duration = (session.ended_at or time.time()) - session.started_at

    turns = []
    for t in session.transcript:
        turn = {
            "turn_id": t.turn_id,
            "responds_to_turn_id": t.responds_to_turn_id,
            "role": t.role,
            "base_question_id": t.base_question_id or None,
            "question_id": t.question_id,
            "question_order": t.question_order,
            "turn_type": t.turn_type,
            "text": t.text,
            "offset_seconds": t.offset_seconds,
            "audio_duration_seconds": t.audio_duration_seconds,
            "timestamp": t.timestamp,
        }
        if t.follow_up_reason is not None:
            turn["follow_up_reason"] = t.follow_up_reason
        if t.audio_file is not None:
            turn["audio_file"] = t.audio_file
        if t.interviewer_audio_file is not None:
            turn["interviewer_audio_file"] = t.interviewer_audio_file
        turns.append(turn)

    out = {
        "session_id": session.session_id,
        "interviewer_name": session.interviewer_name,
        "candidate_first_name": session.candidate_first_name,
        "status": session.end_reason or "in_progress",
        "questions": session.questions,
        "turns": turns,
        "duration_seconds": round(duration, 1),
        "questions_completed": session.current_question_idx,
        "created_at": session.created_at,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
    }
    if session.cv_text:
        out["cv_text"] = session.cv_text
    if session.jd:
        out["jd"] = session.jd
    path = d / "session.json"
    path.write_text(json.dumps(out, indent=2))


def _build_conversation_history(session: "InterviewSession", max_chars: int = 4000) -> str:
    parts = []
    total = 0
    for t in session.transcript:
        label = session.interviewer_name if t.role == "interviewer" else "Candidate"
        line = f"{label}: {t.text}"
        if total + len(line) > max_chars:
            break
        parts.append(line)
        total += len(line)
    return "\n".join(parts)


def _response_asks_question(text: str) -> bool:
    stripped = text.rstrip()
    if not stripped:
        return False
    return stripped[-1] == "?"


def _ensure_question_ids(questions: list[dict]) -> list[dict]:
    for q in questions:
        if "id" not in q:
            q["id"] = str(uuid.uuid4())
    return questions


def create_app(pipeline: VoxPipeline, ws_secret: str = "dev-secret") -> FastAPI:
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="VoxAgent Interview Server", version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    sessions: dict[str, InterviewSession] = {}
    pipeline_lock = asyncio.Lock()
    whisper_model = _init_whisper()

    downstream_sample_rate = pipeline.tts.sample_rate

    @app.get("/v1/health")
    async def health():
        return {
            "status": "ok",
            "active_sessions": len([s for s in sessions.values() if s.state == SessionState.CONNECTED]),
            "downstream_sample_rate": downstream_sample_rate,
        }

    @app.post("/v1/cv/parse")
    async def parse_cv(file: UploadFile = File(...)):
        pdf_bytes = await file.read()
        loop = asyncio.get_event_loop()
        cv_text = await loop.run_in_executor(None, lambda: parse_cv_bytes(pdf_bytes))
        return {"cv_text": cv_text, "char_count": len(cv_text)}

    @app.post("/v1/sessions", response_model=CreateSessionResponse)
    async def create_session(req: CreateSessionRequest):
        if req.session_id in sessions:
            return CreateSessionResponse(
                session_id=req.session_id,
                ws_url=f"/v1/sessions/{req.session_id}/ws",
                ws_token=sessions[req.session_id].ws_token,
                upstream_sample_rate=UPSTREAM_SAMPLE_RATE,
                downstream_sample_rate=downstream_sample_rate,
                audio_format="pcm_s16le",
            )

        token = _sign_token(req.session_id, ws_secret)

        cv_text = req.cv_text or ""
        jd = req.jd

        candidate_first_name = req.candidate_first_name
        if not candidate_first_name and cv_text:
            candidate_first_name = _extract_first_name_from_cv(cv_text)
            if candidate_first_name:
                logger.info(f"Extracted candidate name from CV: {candidate_first_name}")
        if not candidate_first_name:
            candidate_first_name = "there"

        if req.duration_minutes:
            max_seconds = req.duration_minutes * 60
        elif jd.get("interview_duration_minutes"):
            max_seconds = jd["interview_duration_minutes"] * 60
        else:
            max_seconds = req.max_session_seconds

        target_count = _target_question_count(max_seconds)

        if req.questions:
            logger.info(f"Using {len(req.questions)} frontend questions")

        questions = _assemble_questions(req.questions, cv_text, jd, target_count)
        questions = _ensure_question_ids(questions)

        logger.info(f"Assembled {len(questions)} questions (target={target_count}, "
                     f"frontend={len(req.questions)}, jd={'yes' if jd else 'no'}, "
                     f"cv={'yes' if cv_text else 'no'})")

        cv_section = ""
        if cv_text:
            cv_section = (
                "\n\nCANDIDATE CV:\n"
                f"{cv_text}\n\n"
                "Use the CV above to ask relevant, specific questions. "
                "Reference specific details from their CV — roles, technologies, projects, timelines. "
                "Walk through each major experience and project systematically. "
                "Dig deep into technical details — ask about architecture decisions, trade-offs, metrics, and impact."
            )

        jd_section = ""
        if jd:
            jd_title = jd.get("title", "")
            jd_company = jd.get("company", "")
            jd_level = jd.get("level", "")
            jd_desc = jd.get("description", "")
            jd_section = (
                f"\n\nJOB DESCRIPTION:\n"
                f"Role: {jd_title} at {jd_company} ({jd_level})\n"
                f"{jd_desc}\n\n"
                "Use this job context to understand what the role requires. "
                "Questions have already been generated from the JD — focus on asking them naturally."
            )

        persona = req.persona_config or {
            "name": req.interviewer_name,
            "system_prompt": (
                f"You are {req.interviewer_name}, Remotiv's AI interviewer. "
                "You conduct professional, friendly first-round screening interviews.\n"
                "Stay strictly neutral at all times. Never evaluate, praise, criticize, or react to answer quality.\n\n"
                f"The candidate's first name is {candidate_first_name}.\n\n"
                "RULES:\n"
                "- Ask the questions you are given, one at a time\n"
                "- After each answer: did they give enough substance to move on?\n"
                "  - Thin/vague answer -> ask a follow-up for more detail\n"
                "  - Enough substance -> acknowledge briefly and stop (do NOT ask another question)\n"
                "- Follow-ups MUST stay on the original question. Do not narrow it or hint at what a good answer contains\n"
                "- Acknowledgments MUST be neutral in tone. Never say things like 'your answer was a bit general' "
                "or 'that's very specific' or 'great answer'. Simply say 'Thank you, let's move on' or similar\n"
                "- NEVER prefix your response with your name (e.g. never start with 'Sarah:')\n"
                "- Never judge, score, evaluate, or reveal any criteria\n"
                "- Never give feedback on answer quality\n"
                "- Speak naturally in 2-3 sentences, plain English only"
                f"{cv_section}"
                f"{jd_section}"
            ),
            "output_instructions": (
                "Speak naturally in 2-3 sentences. No markdown, no bullet points, no lists. "
                "Plain conversational English only. Sound like a real person in a real interview. "
                "NEVER start your response with your name followed by a colon."
            ),
            "post_input_prompt": "",
            "knowledge": [],
            "tts": {"voice": "af_heart", "lang": "a", "speed": 1.0},
        }

        session = InterviewSession(
            session_id=req.session_id,
            questions=questions,
            interviewer_name=req.interviewer_name,
            candidate_first_name=candidate_first_name,
            persona_config=persona,
            cv_text=cv_text,
            jd=jd or {},
            follow_up_rules=req.follow_up_rules or {},
            max_follow_ups=req.max_follow_ups_per_question,
            max_session_seconds=max_seconds,
            ws_token=token,
        )
        sessions[req.session_id] = session

        logger.info(f"Session created: {req.session_id} with {len(questions)} questions, "
                     f"duration={max_seconds}s, candidate={candidate_first_name}, "
                     f"cv={'yes' if cv_text else 'no'}, jd={'yes' if jd else 'no'}")

        return CreateSessionResponse(
            session_id=req.session_id,
            ws_url=f"/v1/sessions/{req.session_id}/ws",
            ws_token=token,
            upstream_sample_rate=UPSTREAM_SAMPLE_RATE,
            downstream_sample_rate=downstream_sample_rate,
            audio_format="pcm_s16le",
        )

    def _setup_session_persona(session: InterviewSession, pipe: VoxPipeline):
        pipe.llm.setup_persona(session.persona_config)
        if hasattr(pipe.llm, "reset_persona_cache"):
            pipe.llm.reset_persona_cache()
        logger.info(f"Session persona set for {session.session_id}")

    def _build_turn_prompt(
        session: InterviewSession, candidate_text: str, q_text: str,
    ) -> str:
        history = _build_conversation_history(session)
        follow_ups_used = session.follow_up_count
        max_follow_ups = session.max_follow_ups

        parts = []
        if history:
            parts.append(f"CONVERSATION SO FAR:\n{history}\n")
        parts.append(f"THE QUESTION THAT WAS ASKED: {q_text}")
        parts.append(f"CANDIDATE'S ANSWER: {candidate_text}")
        parts.append(
            "YOUR TASK: Decide if the candidate gave enough substance.\n"
            f"Follow-ups used so far: {follow_ups_used}/{max_follow_ups}\n\n"
            "OPTION A — Answer had enough substance:\n"
            "Say ONLY a brief neutral acknowledgment like 'Thank you, let's move on.' "
            "Do NOT ask any question. Do NOT comment on answer quality.\n\n"
            "OPTION B — Answer was too thin or vague:\n"
            "Ask ONE specific follow-up question that digs deeper into what they said. "
            "Do NOT repeat the original question. Do NOT rephrase the original question. "
            "Your follow-up must reference something specific from their answer and ask them to elaborate on that detail.\n\n"
            "NEVER start your response with your name followed by a colon."
        )
        return "\n\n".join(parts)

    def _strip_name_prefix(text: str, name: str) -> str:
        stripped = text.lstrip()
        prefix = f"{name}:"
        if stripped.startswith(prefix):
            return stripped[len(prefix):].lstrip()
        return text

    async def _streaming_stt_loop(
        session: InterviewSession,
        send_json: Callable,
        loop: asyncio.AbstractEventLoop,
    ):
        last_buf_len = 0
        while session._streaming_stt_active:
            await asyncio.sleep(STREAMING_TRANSCRIBE_INTERVAL)
            if not session._streaming_stt_active:
                break
            buf = session.audio_buffer
            if len(buf) <= last_buf_len:
                continue
            last_buf_len = len(buf)
            try:
                partial = await loop.run_in_executor(
                    None, lambda b=buf: _transcribe_pcm(whisper_model, b, UPSTREAM_SAMPLE_RATE)
                )
                if partial and partial != session._last_partial_text:
                    session._last_partial_text = partial
                    await send_json({
                        "type": "partial_transcript",
                        "text": partial,
                    })
            except Exception as e:
                logger.warning(f"Streaming STT error: {e}")

    @app.websocket("/v1/sessions/{session_id}/ws")
    async def websocket_interview(ws: WebSocket, session_id: str, token: str = ""):
        if session_id not in sessions:
            await ws.close(code=4004, reason="Session not found")
            return

        session = sessions[session_id]

        if not _verify_token(session_id, token, ws_secret):
            await ws.close(code=4001, reason="Invalid token")
            return

        if session.state == SessionState.FINALIZED:
            await ws.close(code=4003, reason="Session already finalized")
            return

        await ws.accept()
        session.state = SessionState.CONNECTED
        session.started_at = time.time()
        logger.info(f"WS connected: {session_id}")

        async def send_json(msg: dict):
            await ws.send_json(msg)

        async def send_audio(pcm_bytes: bytes):
            await ws.send_bytes(pcm_bytes)

        loop = asyncio.get_event_loop()

        await send_json({
            "type": "ready",
            "session_id": session_id,
            "interviewer_name": session.interviewer_name,
            "candidate_first_name": session.candidate_first_name,
            "total_questions": len(session.questions),
            "max_session_seconds": session.max_session_seconds,
            "upstream_sample_rate": UPSTREAM_SAMPLE_RATE,
            "downstream_sample_rate": downstream_sample_rate,
        })

        async with pipeline_lock:
            await loop.run_in_executor(
                None, lambda: _setup_session_persona(session, pipeline))

        await _deliver_question(session, pipeline, pipeline_lock, send_json, send_audio, loop)

        try:
            while True:
                elapsed = time.time() - session.started_at
                if elapsed >= session.max_session_seconds:
                    session.end_reason = "time_limit"
                    await send_json({"type": "time_warning", "remaining_seconds": 0})
                    await send_json({"type": "session_complete", "reason": "time_limit"})
                    break

                message = await ws.receive()

                if message.get("type") == "websocket.disconnect":
                    break

                if "bytes" in message and message["bytes"]:
                    session.audio_buffer += message["bytes"]

                elif "text" in message and message["text"]:
                    import json
                    try:
                        data = json.loads(message["text"])
                    except json.JSONDecodeError:
                        await send_json({"type": "error", "message": "Invalid JSON"})
                        continue

                    msg_type = data.get("type", "")

                    if msg_type == "stop_listening":
                        session._streaming_stt_active = False
                        if not session.audio_buffer:
                            await send_json({"type": "error", "message": "No audio received"})
                            continue

                        await _process_candidate_audio(
                            session, pipeline, pipeline_lock,
                            send_json, send_audio, loop,
                        )

                    elif msg_type == "text_input":
                        text = data.get("text", "").strip()
                        if text:
                            await _process_candidate_text(
                                session, pipeline, pipeline_lock,
                                send_json, send_audio, loop, text,
                            )

                    elif msg_type == "interrupt":
                        pipeline.llm.interrupt()

                    elif msg_type == "end_session":
                        session._streaming_stt_active = False
                        session.end_reason = "candidate_ended"
                        await send_json({"type": "session_complete", "reason": "candidate_ended"})
                        break

                    elif msg_type == "start_listening":
                        session.audio_buffer = b""
                        session._last_partial_text = ""
                        session._streaming_stt_active = True
                        stt_task = asyncio.ensure_future(
                            _streaming_stt_loop(session, send_json, loop)
                        )
                        await send_json({"type": "listening"})

                    remaining = session.max_session_seconds - (time.time() - session.started_at)
                    if remaining <= 60 and remaining > 55:
                        await send_json({"type": "time_warning", "remaining_seconds": int(remaining)})

        except WebSocketDisconnect:
            logger.info(f"WS disconnected: {session_id}")
            if not session.end_reason:
                session.end_reason = "disconnected"
        except Exception as e:
            logger.error(f"WS error for {session_id}: {e}")
            if not session.end_reason:
                session.end_reason = "error"
            try:
                await send_json({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            if session.state != SessionState.FINALIZED:
                session.state = SessionState.CREATED

    async def _deliver_question(
        session: InterviewSession,
        pipe: VoxPipeline,
        lock: asyncio.Lock,
        send_json: Callable,
        send_audio: Callable,
        loop: asyncio.AbstractEventLoop,
    ):
        if session.current_question_idx >= len(session.questions):
            session.end_reason = "all_questions_answered"
            await send_json({"type": "session_complete", "reason": "all_questions_answered"})
            return

        q = session.questions[session.current_question_idx]
        q_text = q["text"] if isinstance(q, dict) else str(q)
        q_uuid = q.get("id", "") if isinstance(q, dict) else ""

        q_id = session.current_question_idx + 1
        q_order = session.current_question_idx + 1

        await send_json({
            "type": "question",
            "question_id": q_id,
            "base_question_id": q_uuid,
            "question_order": q_order,
            "total_questions": len(session.questions),
            "turn_type": "base_question",
        })

        await send_json({"type": "speaking"})

        audio_chunks: list[bytes] = []

        def on_audio_chunk(chunk_idx: int, wav_data):
            if isinstance(wav_data, np.ndarray):
                pcm = (wav_data * 32767).astype(np.int16).tobytes()
            elif isinstance(wav_data, bytes):
                pcm = _wav_to_pcm(wav_data)
            else:
                pcm = (np.asarray(wav_data) * 32767).astype(np.int16).tobytes()
            audio_chunks.append(pcm)

        if session.current_question_idx == 0:
            prompt = (
                "This is the very start of the interview. Do the following in one response:\n"
                f"1. Greet the candidate: 'Hi {session.candidate_first_name}, I'm {session.interviewer_name}, "
                f"Remotiv's AI interviewer.'\n"
                "2. Ask them to keep their responses precise and to the point.\n"
                f"3. Ask this opening question EXACTLY as written: \"{q_text}\"\n"
                "Do NOT greet or introduce yourself again after this first message."
            )
        else:
            prompt = (
                f"Ask this next interview question naturally:\n\"{q_text}\""
            )

        async with lock:
            response, timing, tts_metrics = await loop.run_in_executor(
                None, lambda: pipe.ask_text(prompt, on_audio_chunk=on_audio_chunk)
            )

        response = _strip_name_prefix(response, session.interviewer_name)

        session.questions[session.current_question_idx]["text"] = response

        for chunk in audio_chunks:
            await send_audio(chunk)

        interviewer_turn_idx = len([t for t in session.transcript if t.role == "interviewer"])
        audio_filename, audio_dur = _save_interviewer_audio(
            session, audio_chunks, interviewer_turn_idx, downstream_sample_rate,
        )

        turn = TranscriptTurn(
            role="interviewer",
            question_id=q_id,
            question_order=q_order,
            turn_type="base_question",
            text=response,
            base_question_id=q_uuid,
            offset_seconds=_compute_offset_seconds(session),
            responds_to_turn_id=None,
            interviewer_audio_file=audio_filename,
            audio_duration_seconds=audio_dur,
        )
        session.transcript.append(turn)

        await send_json({
            "type": "transcript",
            "turn_id": turn.turn_id,
            "responds_to_turn_id": None,
            "role": "interviewer",
            "text": response,
            "base_question_id": q_uuid,
            "question_id": q_id,
            "question_order": q_order,
            "turn_type": "base_question",
            "offset_seconds": turn.offset_seconds,
            "interviewer_audio_file": audio_filename,
            "audio_duration_seconds": audio_dur,
        })

        _save_session_json(session)

        await send_json({"type": "listening"})

    async def _process_candidate_audio(
        session: InterviewSession,
        pipe: VoxPipeline,
        lock: asyncio.Lock,
        send_json: Callable,
        send_audio: Callable,
        loop: asyncio.AbstractEventLoop,
    ):
        pcm_data = session.audio_buffer
        session.audio_buffer = b""

        audio_duration_seconds = round(len(pcm_data) / (UPSTREAM_SAMPLE_RATE * UPSTREAM_CHANNELS * UPSTREAM_SAMPLE_WIDTH), 3)

        await send_json({"type": "processing"})

        audio_chunks: list[bytes] = []

        def on_audio_chunk(chunk_idx: int, wav_data):
            if isinstance(wav_data, np.ndarray):
                pcm = (wav_data * 32767).astype(np.int16).tobytes()
            elif isinstance(wav_data, bytes):
                pcm = _wav_to_pcm(wav_data)
            else:
                pcm = (np.asarray(wav_data) * 32767).astype(np.int16).tobytes()
            audio_chunks.append(pcm)

        candidate_text = await loop.run_in_executor(
            None, lambda: _transcribe_pcm(whisper_model, pcm_data, UPSTREAM_SAMPLE_RATE)
        )
        if not candidate_text:
            candidate_text = session._last_partial_text or f"[audio: {audio_duration_seconds:.1f}s]"

        q_id = session.current_question_idx + 1
        q_order = session.current_question_idx + 1
        q_uuid = _get_question_uuid(session)

        candidate_turn_idx = len([t for t in session.transcript if t.role == "candidate"])
        audio_filename = _save_candidate_audio(session, pcm_data, candidate_turn_idx)

        responds_to = _last_turn_id(session, "interviewer")

        candidate_turn = TranscriptTurn(
            role="candidate",
            question_id=q_id,
            question_order=q_order,
            turn_type="answer",
            text=candidate_text,
            base_question_id=q_uuid,
            offset_seconds=_compute_offset_seconds(session),
            responds_to_turn_id=responds_to,
            audio_file=audio_filename,
            audio_duration_seconds=audio_duration_seconds,
        )
        session.transcript.append(candidate_turn)

        await send_json({
            "type": "transcript",
            "turn_id": candidate_turn.turn_id,
            "responds_to_turn_id": responds_to,
            "role": "candidate",
            "text": candidate_text,
            "base_question_id": q_uuid,
            "question_id": q_id,
            "question_order": q_order,
            "turn_type": "answer",
            "offset_seconds": candidate_turn.offset_seconds,
            "audio_file": audio_filename,
            "audio_duration_seconds": audio_duration_seconds,
        })

        _save_session_json(session)

        q = session.questions[session.current_question_idx]
        q_text = q["text"] if isinstance(q, dict) else str(q)
        turn_prompt = _build_turn_prompt(session, candidate_text, q_text)

        async with lock:
            response, timing, tts_metrics = await loop.run_in_executor(
                None, lambda: pipe.ask_text(turn_prompt, on_audio_chunk=on_audio_chunk)
            )

        response = _strip_name_prefix(response, session.interviewer_name)

        await send_json({"type": "speaking"})

        for chunk in audio_chunks:
            await send_audio(chunk)

        llm_asks_question = _response_asks_question(response)
        turn_type = "follow_up" if llm_asks_question else "acknowledgment"

        follow_up_reason = None
        if turn_type == "follow_up":
            follow_up_reason = _infer_follow_up_reason(candidate_text, response)

        interviewer_turn_idx = len([t for t in session.transcript if t.role == "interviewer"])
        audio_fn, audio_dur = _save_interviewer_audio(
            session, audio_chunks, interviewer_turn_idx, downstream_sample_rate,
        )

        interviewer_turn = TranscriptTurn(
            role="interviewer",
            question_id=q_id,
            question_order=q_order,
            turn_type=turn_type,
            text=response,
            base_question_id=q_uuid,
            offset_seconds=_compute_offset_seconds(session),
            responds_to_turn_id=candidate_turn.turn_id,
            follow_up_reason=follow_up_reason,
            interviewer_audio_file=audio_fn,
            audio_duration_seconds=audio_dur,
        )
        session.transcript.append(interviewer_turn)

        transcript_msg = {
            "type": "transcript",
            "turn_id": interviewer_turn.turn_id,
            "responds_to_turn_id": candidate_turn.turn_id,
            "role": "interviewer",
            "text": response,
            "base_question_id": q_uuid,
            "question_id": q_id,
            "question_order": q_order,
            "turn_type": turn_type,
            "offset_seconds": interviewer_turn.offset_seconds,
            "interviewer_audio_file": audio_fn,
            "audio_duration_seconds": audio_dur,
        }
        if follow_up_reason is not None:
            transcript_msg["follow_up_reason"] = follow_up_reason
        await send_json(transcript_msg)

        _save_session_json(session)

        await _advance_or_follow_up(session, send_json, send_audio, pipe, lock, loop, llm_asks_question)

    async def _process_candidate_text(
        session: InterviewSession,
        pipe: VoxPipeline,
        lock: asyncio.Lock,
        send_json: Callable,
        send_audio: Callable,
        loop: asyncio.AbstractEventLoop,
        text: str,
    ):
        q_id = session.current_question_idx + 1
        q_order = session.current_question_idx + 1
        q_uuid = _get_question_uuid(session)

        responds_to = _last_turn_id(session, "interviewer")

        candidate_turn = TranscriptTurn(
            role="candidate",
            question_id=q_id,
            question_order=q_order,
            turn_type="answer",
            text=text,
            base_question_id=q_uuid,
            offset_seconds=_compute_offset_seconds(session),
            responds_to_turn_id=responds_to,
            audio_file=None,
            audio_duration_seconds=None,
        )
        session.transcript.append(candidate_turn)

        await send_json({
            "type": "transcript",
            "turn_id": candidate_turn.turn_id,
            "responds_to_turn_id": responds_to,
            "role": "candidate",
            "text": text,
            "base_question_id": q_uuid,
            "question_id": q_id,
            "question_order": q_order,
            "turn_type": "answer",
            "offset_seconds": candidate_turn.offset_seconds,
            "audio_file": None,
            "audio_duration_seconds": None,
        })

        _save_session_json(session)

        await send_json({"type": "processing"})

        audio_chunks: list[bytes] = []

        def on_audio_chunk(chunk_idx: int, wav_data):
            if isinstance(wav_data, np.ndarray):
                pcm = (wav_data * 32767).astype(np.int16).tobytes()
            elif isinstance(wav_data, bytes):
                pcm = _wav_to_pcm(wav_data)
            else:
                pcm = (np.asarray(wav_data) * 32767).astype(np.int16).tobytes()
            audio_chunks.append(pcm)

        q = session.questions[session.current_question_idx]
        q_text = q["text"] if isinstance(q, dict) else str(q)
        turn_prompt = _build_turn_prompt(session, text, q_text)

        async with lock:
            response, timing, tts_metrics = await loop.run_in_executor(
                None, lambda: pipe.ask_text(turn_prompt, on_audio_chunk=on_audio_chunk)
            )

        response = _strip_name_prefix(response, session.interviewer_name)

        await send_json({"type": "speaking"})

        for chunk in audio_chunks:
            await send_audio(chunk)

        llm_asks_question = _response_asks_question(response)
        turn_type = "follow_up" if llm_asks_question else "acknowledgment"

        follow_up_reason = None
        if turn_type == "follow_up":
            follow_up_reason = _infer_follow_up_reason(text, response)

        interviewer_turn_idx = len([t for t in session.transcript if t.role == "interviewer"])
        audio_fn, audio_dur = _save_interviewer_audio(
            session, audio_chunks, interviewer_turn_idx, downstream_sample_rate,
        )

        interviewer_turn = TranscriptTurn(
            role="interviewer",
            question_id=q_id,
            question_order=q_order,
            turn_type=turn_type,
            text=response,
            base_question_id=q_uuid,
            offset_seconds=_compute_offset_seconds(session),
            responds_to_turn_id=candidate_turn.turn_id,
            follow_up_reason=follow_up_reason,
            interviewer_audio_file=audio_fn,
            audio_duration_seconds=audio_dur,
        )
        session.transcript.append(interviewer_turn)

        transcript_msg = {
            "type": "transcript",
            "turn_id": interviewer_turn.turn_id,
            "responds_to_turn_id": candidate_turn.turn_id,
            "role": "interviewer",
            "text": response,
            "base_question_id": q_uuid,
            "question_id": q_id,
            "question_order": q_order,
            "turn_type": turn_type,
            "offset_seconds": interviewer_turn.offset_seconds,
            "interviewer_audio_file": audio_fn,
            "audio_duration_seconds": audio_dur,
        }
        if follow_up_reason is not None:
            transcript_msg["follow_up_reason"] = follow_up_reason
        await send_json(transcript_msg)

        _save_session_json(session)

        await _advance_or_follow_up(session, send_json, send_audio, pipe, lock, loop, llm_asks_question)

    async def _advance_or_follow_up(
        session: InterviewSession,
        send_json: Callable,
        send_audio: Callable,
        pipe: VoxPipeline,
        lock: asyncio.Lock,
        loop: asyncio.AbstractEventLoop,
        llm_asks_question: bool = True,
    ):
        if not llm_asks_question or session.follow_up_count >= session.max_follow_ups:
            session.current_question_idx += 1
            session.follow_up_count = 0

            if session.current_question_idx >= len(session.questions):
                session.end_reason = "all_questions_answered"
                await send_json({"type": "session_complete", "reason": "all_questions_answered"})
            else:
                next_q_uuid = session.questions[session.current_question_idx].get("id", "")
                await send_json({
                    "type": "next_question",
                    "question_id": session.current_question_idx + 1,
                    "base_question_id": next_q_uuid,
                    "question_order": session.current_question_idx + 1,
                })
                await _deliver_question(session, pipe, lock, send_json, send_audio, loop)
        else:
            session.follow_up_count += 1
            await send_json({"type": "listening"})

    @app.post("/v1/sessions/{session_id}/finalize", response_model=FinalizeResponse)
    async def finalize_session(session_id: str):
        if session_id not in sessions:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Session not found")

        session = sessions[session_id]
        session.state = SessionState.FINALIZED
        if not session.ended_at:
            session.ended_at = time.time()
        if not session.end_reason:
            session.end_reason = "completed"

        _save_session_json(session)

        duration = 0.0
        if session.started_at:
            duration = session.ended_at - session.started_at

        turns = []
        for t in session.transcript:
            turn = {
                "turn_id": t.turn_id,
                "responds_to_turn_id": t.responds_to_turn_id,
                "role": t.role,
                "base_question_id": t.base_question_id or None,
                "question_id": t.question_id,
                "question_order": t.question_order,
                "turn_type": t.turn_type,
                "text": t.text,
                "offset_seconds": t.offset_seconds,
                "audio_duration_seconds": t.audio_duration_seconds,
                "timestamp": t.timestamp,
            }
            if t.follow_up_reason is not None:
                turn["follow_up_reason"] = t.follow_up_reason
            if t.audio_file is not None:
                turn["audio_file"] = t.audio_file
            if t.interviewer_audio_file is not None:
                turn["interviewer_audio_file"] = t.interviewer_audio_file
            turns.append(turn)

        logger.info(f"Session finalized: {session_id}, {len(turns)} turns, {duration:.1f}s")

        return FinalizeResponse(
            session_id=session_id,
            turns=turns,
            duration_seconds=round(duration, 1),
            questions_completed=session.current_question_idx,
        )

    return app
