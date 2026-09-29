-- ============================================================================
-- Migration 028 — interview_sessions.scoring_snapshot
-- ----------------------------------------------------------------------------
-- What a candidate was ASKED has always been frozen on the session
-- (questions_snapshot). What the answer is MARKED AGAINST — competency, rubric,
-- weight — was not: the scorer read it from interview_questions at scoring
-- time, and matched by question id, falling back to POSITION. Every job save
-- deletes and reinserts interview_questions, so ids churn, the id match
-- misses, and an answer could be marked against whatever question now sits at
-- its position. Reorder or delete a question between invite and scoring and
-- answer 2 is graded with question 3's rubric and weight (Phase 4, AI-6).
--
-- This column freezes the marking scheme at invite time, per question:
--   [{ position, question_id, competency, rubric, weight }]
--
-- A SEPARATE column, on purpose, rather than more keys in questions_snapshot.
-- questions_snapshot is what the candidate is SENT — resolveSessionByToken
-- selects it by name and builds the candidate payload from it. Putting the
-- rubric beside it would rely on every future reader remembering to strip it.
-- No candidate-facing read names this column, and none may: it is the marking
-- scheme, and shipping it to the person being marked defeats the exercise.
--
-- Nullable, no default, no backfill. Every existing session (23 when this was
-- written) predates it and stays null. For those, the scorer matches the
-- snapshot's question id against the live rows; if the id is gone it uses the
-- frozen question text with NO competency, NO rubric and Normal weight — it
-- never borrows the marking scheme from the question now at that position.
-- Backfilling would freeze TODAY'S rubric onto a session invited under a
-- different one, which is the error the column exists to prevent.
--
-- Run by hand in the Supabase SQL editor BEFORE deploying the code that writes
-- it: the invite writers include the column in their insert, and PostgREST
-- rejects an unknown column. The reader tolerates null.
-- ============================================================================

alter table public.interview_sessions
  add column if not exists scoring_snapshot jsonb;

comment on column public.interview_sessions.scoring_snapshot is
  'Frozen at invite: [{position, question_id, competency, rubric, weight}]. The marking scheme. NEVER select this in a candidate-facing read - questions_snapshot is the candidate payload, this is not.';

-- Confirm.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'interview_sessions'
   and column_name = 'scoring_snapshot';
