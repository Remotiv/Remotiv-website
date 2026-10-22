-- ============================================================================
-- Migration 045 - live_interview_scores: 'ending_unconfirmed', and a completed
--                 interview that may be held from ranking
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 044. Safe to run
-- twice: every constraint is dropped if it exists, then added.
--
-- ── Before running: the count should be 0 ────────────────────
-- Live scoring is not wired (LIVE_INTERVIEW_SCORING_ENABLED is off), so the
-- new checks validate against an empty table.
--
-- select count(*) as live_interview_scores from public.live_interview_scores;
--
-- ── Why (decision D2, revised 22 Oct 2026) ───────────────────
--
-- "Completed" now comes only from a confirmed normal close by Sarah, never
-- from how many questions were asked (lib/interviews/live-ingest.ts). Every
-- ending that is not clearly a normal close or a clear technical failure is
-- 'ending_unconfirmed' ("Ending not confirmed - needs review"): its scores
-- are shown like a partial interview's, with an overall, and it is never
-- ranked against completed interviews. A restart is a person's decision.
--
-- A completed interview where Sarah closed before asking every question is
-- still 'completed', but held from ranking: partial = true. So the partial
-- rule changes from "partial exactly when not completed" to "partial whenever
-- not completed; a completed row may be held". A row short of completed with
-- partial = false is still refused.
--
-- Nothing else changes: no new action, no restart rule (migration 020 is
-- untouched), no column.

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_outcome,
  add constraint live_interview_scores_outcome
    check (
      outcome is null
      or outcome in ('completed', 'partial', 'abandoned', 'technical_failure', 'ending_unconfirmed')
    );

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_overall_outcome,
  add constraint live_interview_scores_overall_outcome
    check (overall_score is null or outcome in ('completed', 'partial', 'ending_unconfirmed'));

-- Never ranked against a completed interview: anything short of completed is
-- partial, and a completed interview may be held (partial = true) too.
-- `is true`, not a bare `partial`: a CHECK whose expression is NULL passes, so
-- a NULL partial would slip through a bare one. partial is NOT NULL (042),
-- so this is the second guard, not the only one.
alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_partial,
  add constraint live_interview_scores_partial
    check (outcome is null or outcome = 'completed' or partial is true);

-- ── After running: should list these 3 constraints with their definitions ──
-- select conrelid::regclass as "table", conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conname in (
--          'live_interview_scores_outcome', 'live_interview_scores_overall_outcome',
--          'live_interview_scores_partial')
--  order by 1, 2;
--
-- Expected definitions:
--   live_interview_scores_outcome          CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['completed'::text, 'partial'::text, 'abandoned'::text, 'technical_failure'::text, 'ending_unconfirmed'::text]))))
--   live_interview_scores_overall_outcome  CHECK (((overall_score IS NULL) OR (outcome = ANY (ARRAY['completed'::text, 'partial'::text, 'ending_unconfirmed'::text]))))
--   live_interview_scores_partial          CHECK (((outcome IS NULL) OR (outcome = 'completed'::text) OR (partial IS TRUE)))
