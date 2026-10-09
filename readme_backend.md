# VoxAgent — Remotiv AI Interview Backend

VoxAgent is the backend that powers Remotiv's AI interviewer (Sarah). It runs a local LLM + TTS pipeline and exposes a WebSocket-based API that the frontend connects to for real-time audio interviews.

## What it does

1. Frontend creates a session with questions (or a CV to generate questions from)
2. Candidate connects via WebSocket
3. Sarah greets the candidate, asks questions one by one, and follows up when answers are thin
4. All audio (both sides) and transcripts are saved to `sessions/<id>/`

## Requirements

- Linux with an NVIDIA GPU (CUDA 12.8+)
- ~8 GB VRAM minimum (Gemma 4 E4B Q4_1 + Kokoro TTS)

## Setup (one-time)

### 1. Install pixi

```bash
curl -fsSL https://pixi.sh/install.sh | bash
```

Close and reopen your terminal so `pixi` is on your PATH.

### 2. Install dependencies

From the **project root** (not `voicellm/`):

```bash
pixi install
```

This creates a Python 3.11 environment with PyTorch, CUDA libs, and all Python packages.

### 3. Run post-install setup

```bash
pixi run setup
```

This installs three things in order:
- **Kokoro TTS** — text-to-speech engine
- **llama-cpp-python** — builds from source with CUDA support
- **voxagent** — the interview server package (editable mode)

This step takes 5-10 minutes (llama compiles C++ with CUDA).

### 4. Download model weights

Place these two files in `model_pth/` at the project root:

| File | What it is |
|------|-----------|
| `gemma-4-E4B-it-Q4_1.gguf` | Gemma 4 E4B language model (Q4_1 quantized) |
| `mmproj-BF16.gguf` | Audio encoder for voice input |

These are downloaded from Hugging Face. Ask Arham for the exact repo/links if you don't have them.

## Choosing a model

Two LLM backends are available out of the box:

| Model | Config file | VRAM usage | Notes |
|-------|------------|------------|-------|
| **Qwen3-30B-A3B** (default) | `voicellm/configs/models/qwen3_30b_a3b.yaml` | ~15 GB (40/48 layers on GPU) | MoE — only 3B params active per token. Better instruction-following. Text-only. |
| **Gemma 4 E4B** | `voicellm/configs/models/gemma4_e4b.yaml` | ~8 GB | Supports audio input via mmproj encoder. |

The default is Qwen3. To switch models, use the `--model-config` flag:

```bash
# Qwen3 (default)
pixi run python voicellm/run_server.py

# Gemma 4
pixi run python voicellm/run_server.py --model-config voicellm/configs/models/gemma4_e4b.yaml
```

To add a new model: create a YAML config in `voicellm/configs/models/`, set the `backend` field to `qwen3` or `gemma4` (or add a new backend in `voicellm/voxagent/backends/`), and point `model.path` at your GGUF file.

## Running the server

From the **project root**:

```bash
pixi run python voicellm/run_server.py
```

The server starts on `http://localhost:8000`. You'll see log output as it loads the model (~10-20 seconds).

### Server options

```bash
pixi run python voicellm/run_server.py --port 8000         # change port
pixi run python voicellm/run_server.py --text-only          # skip audio encoder (faster startup)
pixi run python voicellm/run_server.py --ws-secret MY_KEY   # set WebSocket auth secret
pixi run python voicellm/run_server.py --model-config voicellm/configs/models/gemma4_e4b.yaml  # use Gemma instead of Qwen3
```

### Quick test (no frontend needed)

In a separate terminal:

```bash
pixi run python test_live_interview.py
```

This creates a session and runs a text-based interview over WebSocket. Useful for verifying the server works.

### Test with browser UI

```bash
python3 -m http.server 3001
```

Open `http://127.0.0.1:3001/test_interview.html` — upload a CV PDF, click Start, and talk to Sarah through your mic.

## API Reference

Base URL: `http://localhost:8000`

### Health check

```
GET /v1/health
```

Returns `{"status": "ok", "active_sessions": 0, "downstream_sample_rate": 24000}`

### Parse CV (PDF to text)

```
POST /v1/cv/parse
Content-Type: multipart/form-data

file: <pdf file>
```

Returns `{"cv_text": "## Name\n...", "char_count": 6845}`

### Create session

```
POST /v1/sessions
Content-Type: application/json
```

**Request body:**

```json
{
  "session_id": "unique-id-from-frontend",
  "interviewer_name": "Sarah",
  "candidate_first_name": "Alex",
  "questions": [
    {"text": "Tell me about yourself.", "position": 1},
    {"text": "What is your greatest strength?", "position": 2}
  ],
  "cv_text": null,
  "jd": { "title": "ML Engineer", "company": "Remotiv", "interview_duration_minutes": 30, "..." : "..." },
  "duration_minutes": 30,
  "max_follow_ups_per_question": 2
}
```

**Field rules:**

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `session_id` | yes | — | Any unique string. Use a timestamp or UUID. |
| `interviewer_name` | yes | — | Name the AI uses. We use "Sarah". |
| `candidate_first_name` | no | extracted from CV, or "there" | If omitted and CV is provided, the name is parsed from the CV automatically. |
| `questions` | no | `[]` | If empty, questions are auto-generated from JD + CV. |
| `cv_text` | no | `null` | Raw text from CV (get it from `/v1/cv/parse`). |
| `jd` | **yes** | — | Job description object (see JD format below). Used for question generation and session duration. |
| `duration_minutes` | no | from JD or 30 | Overrides everything. If not set, uses `jd.interview_duration_minutes`. If neither, defaults to 30 min. |
| `max_session_seconds` | no | 1800 | Lowest-priority duration (in seconds). `duration_minutes` and JD duration both take priority. |
| `max_follow_ups_per_question` | no | 1 | How many follow-up questions Sarah can ask per base question before moving on. |

**JD format** (see `sample_jd.json` for a full example):

```json
{
  "title": "Machine Learning Engineer",
  "company": "Remotiv",
  "experience_years": 3,
  "level": "mid",
  "interview_duration_minutes": 30,
  "description": "...",
  "responsibilities": ["..."],
  "required_skills": ["Python", "PyTorch"],
  "nice_to_have": ["..."],
  "interview_focus": ["..."]
}
```

**Question generation logic:**
- Questions provided → use those as-is
- No questions → 2 general questions + JD-based questions + CV-based questions (if CV provided) + 2 closing questions, scaled to session duration (~1 question per 2 minutes)

**Duration priority:** `duration_minutes` > `jd.interview_duration_minutes` > `max_session_seconds` (default 1800)

**Question count scaling:** Target = session duration ÷ 2 minutes (accounts for follow-ups). A 30-min session targets ~15 questions, a 15-min session targets ~8.

**Response:**

```json
{
  "session_id": "unique-id",
  "ws_url": "/v1/sessions/unique-id/ws",
  "ws_token": "hmac-token",
  "upstream_sample_rate": 16000,
  "downstream_sample_rate": 24000,
  "audio_format": "pcm_s16le"
}
```

### WebSocket connection

```
WS /v1/sessions/{session_id}/ws?token={ws_token}
```

Use `ws_url` and `ws_token` from the create session response.

#### Messages from server (JSON text frames)

| type | When | Key fields |
|------|------|-----------|
| `ready` | Connection established | `session_id`, `total_questions`, `max_session_seconds` |
| `question` | New question starting | `question_id`, `base_question_id`, `turn_type` |
| `speaking` | Sarah is about to talk | — |
| `listening` | Sarah is done, waiting for candidate | — |
| `processing` | Server processing candidate input | — |
| `transcript` | Turn transcript saved | `turn_id`, `responds_to_turn_id`, `role`, `text`, `base_question_id`, `offset_seconds`, `audio_duration_seconds` |
| `time_warning` | 60 seconds remaining | `remaining_seconds` |
| `session_complete` | Interview ended | `reason`: `all_questions_answered` / `time_limit` / `candidate_ended` |
| `error` | Something went wrong | `message` |

#### Audio from server (binary frames)

Raw PCM s16le at 24 kHz mono. Arrives in chunks during `speaking` state. Play them in order.

#### Messages to server

**Send audio** (candidate speaking):
1. Send `{"type": "start_listening"}` — clears the audio buffer
2. Send raw PCM binary frames (s16le, 16 kHz, mono) as the candidate speaks
3. Send `{"type": "stop_listening"}` — triggers transcription + AI response

**Send text** (for testing without mic):
```json
{"type": "text_input", "text": "My answer to the question..."}
```

**End session early:**
```json
{"type": "end_session"}
```

### Finalize session

```
POST /v1/sessions/{session_id}/finalize
```

Returns the complete transcript with all turns. Also saves `session.json` to disk.

## Session JSON format

Each session is saved to `sessions/<session_id>/session.json`. The turns array contains every exchange:

```json
{
  "turn_id": "uuid",
  "responds_to_turn_id": "uuid or null",
  "role": "interviewer or candidate",
  "base_question_id": "uuid of the question",
  "question_id": 1,
  "turn_type": "base_question | follow_up | acknowledgment | answer",
  "text": "exact spoken text",
  "offset_seconds": 22.5,
  "audio_duration_seconds": 8.7,
  "follow_up_reason": "answer_lacked_specifics",
  "audio_file": "candidate_turn_000.wav",
  "interviewer_audio_file": "interviewer_turn_000.wav"
}
```

**Time fields** (all in seconds for video alignment):
- `offset_seconds` — when this turn happened, relative to session start
- `audio_duration_seconds` — length of the audio clip
- `null` (not `0`) when audio is not available

**Linking turns:**
- `responds_to_turn_id` links each turn to what it responds to (candidate answer → interviewer question, follow-up → candidate answer)
- `base_question_id` is the UUID of the original question from the input list

**Audio files** saved per session:
- `candidate_turn_NNN.wav` — candidate's recorded audio
- `interviewer_turn_NNN.wav` — Sarah's TTS audio

## Troubleshooting

**`torch` import fails after adding packages:**
```bash
pixi run fix-nvidia
```

**Server won't start / CUDA error:**
- Check `nvidia-smi` works
- Make sure model files exist in `model_pth/`

**Session ends too quickly:**
- The session ends when all questions are answered, not when the timer runs out
- Send more questions, or send no questions + a CV to auto-generate 15+ questions

**422 on session create:**
- Make sure you're sending either `questions` (non-empty list) or `cv_text`
- `candidate_first_name` is optional — it's extracted from the CV if not provided
