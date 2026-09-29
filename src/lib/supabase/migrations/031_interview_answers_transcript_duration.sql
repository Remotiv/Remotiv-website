-- ============================================================================
-- Migration 031 — interview_answers.transcript_duration_seconds
-- ----------------------------------------------------------------------------
-- interview_answers.duration_seconds is the BROWSER's recording timer, posted
-- by the candidate's page to /api/interview/confirm and stored unverified. It
-- is diagnostic. It must never decide whether an answer is assessable: a
-- candidate could inflate it and turn a weak-but-real answer into "no usable
-- speech" instead of a low score (Phase 4, AI-1).
--
-- Whisper's verbose_json response carries the audio's actual length as a
-- top-level `duration`. The transcribe handler used to discard it. This
-- column keeps it — provider-derived, so the candidate cannot influence it —
-- and it is what the assessability rule uses, together with the stored
-- segments (which now also keep Whisper's per-segment no_speech_prob), to
-- decide that a long recording with a few words in it is silence rather than
-- an answer.
--
-- A column rather than a key inside transcript_segments: that jsonb keeps its
-- contract of "an array of timed spans" and every reader's Array.isArray check
-- stays true. numeric, not integer: Whisper reports fractional seconds.
--
-- Nullable, no default, no backfill. Every existing answer (six when this was
-- written) stays null: their audio was never re-measured, and the rule does
-- not classify them from the browser timer. They are scored under the two
-- rules that need no duration — the eight-word floor and the low-confidence
-- cap under twenty-five words.
--
-- Run by hand in the Supabase SQL editor BEFORE deploying the code that
-- writes it: the transcribe handler writes this column in the same UPDATE as
-- the transcript itself, and PostgREST rejects an unknown column.
-- ============================================================================

alter table public.interview_answers
  add column if not exists transcript_duration_seconds numeric;

comment on column public.interview_answers.transcript_duration_seconds is
  'Audio length in seconds as reported by the transcription provider (Whisper verbose_json duration). Trusted. duration_seconds beside it is the browser timer and is diagnostic only.';

-- Confirm.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'interview_answers'
   and column_name = 'transcript_duration_seconds';
