# Interview AI — Design Notes

## Purpose
First-round screening interview. The AI does NOT score or judge quality.

## Behaviour Rules
- Follow-ups must stay on the original question. Don't narrow it and don't hint at what a good answer contains.
- Acknowledgments must be neutral — "Thank you, let's move on." Never "your answer was a bit general" or "that's very specific". Every candidate must get the same tone.
- The interviewer must NEVER prefix its text with its name (e.g. "Sarah:").

## Inputs
- If questions are provided: use them directly (job-question mode).
- If questions are empty/omitted: auto-generate from JD and/or CV. Up to 2 general questions first, then a mix of JD-based and CV-based questions, scaled to session duration.
- If neither questions, cv_text, nor JD: 422 error.
- JD (Job Description) can be provided as a JSON object with title, company, responsibilities, required_skills, nice_to_have, interview_focus, and `interview_duration_minutes`.
- Candidate first name only. No email, phone, or other PII.
- Scoring rubrics are never sent to the AI. Scoring stays on our side.

## Follow-up Logic
The AI only decides: "Did the candidate actually answer the question with enough information to move on?"

- If the answer has enough substance → move to next question
- If the answer is thin/vague → ask a follow-up for more detail
- AI should NOT receive the scoring rubric
- AI should NOT tell the candidate what a high-scoring answer looks like
- AI should NOT evaluate if the answer is "good" or "bad" for hiring

## Session Duration
- Default: 30 minutes (1800 seconds)
- Priority: `duration_minutes` > `jd.interview_duration_minutes` > `max_session_seconds` (default 1800)
- Question count scales to duration: ~1 question per 2 minutes (with follow-ups)

## Question Assembly (no frontend questions)
1. 2 general questions (tell me about yourself, greatest strength)
2. JD-based questions (from responsibilities, skills, focus areas) — 50% of remaining budget
3. CV-based questions (from work history parsing) — 50% of remaining budget
4. 2 closing questions (proudest work, career direction)
- If only JD or only CV: that source fills the full remaining budget

## Session JSON Format

Each turn includes:
- `turn_id` — UUID, unique per turn
- `responds_to_turn_id` — UUID of the turn this responds to (null for initiating turns)
- `base_question_id` — UUID of the original question from the input list
- `question_id` — integer position (1-indexed)
- `question_order` — integer display order
- `turn_type` — `base_question` | `follow_up` | `clarification` | `answer` | `acknowledgment`
- `text` — exact text (LLM output for interviewer, transcription for candidate)
- `offset_seconds` — seconds from session start (for alignment with video recording timestamps)
- `follow_up_reason` — present on follow-up turns, describes why the AI followed up
- `audio_file` — candidate audio WAV path (null when not applicable)
- `interviewer_audio_file` — interviewer TTS audio WAV path (null when not available)
- `audio_duration_seconds` — duration in seconds (null, not 0, when audio is unavailable). In seconds for easy alignment with video recording timestamps.

## Technical Requirements

1. The exact LLM-generated text (before TTS) must be saved in each turn's JSON
2. Interviewer TTS audio files must be saved per turn
3. Candidates must be able to reconnect after internet drop and continue from the next unanswered question with previous context preserved
4. Turn type classification and question ID must be in the JSON
5. Use `null` (not `0`) when audio is not available

## Roadmap
- [x] JSON session format with turn types
- [x] Per-turn UUIDs, offset_seconds, responds_to_turn_id
- [x] Interviewer audio file saving
- [x] follow_up_reason on follow-up turns
- [x] Default 30-min session with duration_minutes override
- [x] CV-based question fallback (when no questions provided)
- [x] JD-based question generation (responsibilities, skills, focus areas)
- [x] Combined JD + CV question assembly with duration-based scaling
- [x] JD interview_duration_minutes as default session duration
- [ ] Question customization per role
