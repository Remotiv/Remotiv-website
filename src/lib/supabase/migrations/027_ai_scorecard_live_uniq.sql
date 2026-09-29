-- ============================================================================
-- Migration 027 — one live ai_scorecard job per interview session
-- ----------------------------------------------------------------------------
-- background_jobs has no dedupe key. A scorecard is now asked for from three
-- places — the transcribe handler, the candidate's submit, and a recruiter's
-- "Score interview" button (src/lib/interviews/scorecard.ts) — and any two of
-- them can pass the "is one already queued?" read together and both insert.
-- The handler upserts, so the RESULT is the same, but both jobs run and both
-- are paid Claude calls. This index makes the second insert fail.
--
-- Partial on purpose: it covers only rows that are queued or running. A job
-- that has succeeded, failed or died drops out of the index, so a later
-- deliberate re-score of the same session is still allowed. The application
-- reads the 23505 this raises as "already queued" and treats it as success.
--
-- Run by hand in the Supabase SQL editor, like the files before it. ORDER:
-- run this BEFORE the "Score interview" button is deployed. Until it exists
-- the code falls back to the read-then-write pre-check alone, which narrows
-- the window but does not close it — and that button's whole purpose is to
-- spend money.
--
-- Safe on the live table: at the time of writing there are zero queued or
-- running ai_scorecard rows, so nothing can conflict at creation. Idempotent
-- via IF NOT EXISTS.
-- ============================================================================

-- 0. Look first. Expect 0 live rows; if two share a sessionId the index
--    cannot be created until one is retired.
select payload->>'sessionId' as session_id, count(*) as live_jobs
  from public.background_jobs
 where type = 'ai_scorecard' and status in ('queued', 'running')
 group by 1
having count(*) > 1;

-- 1. The index.
create unique index if not exists background_jobs_ai_scorecard_live_uniq
  on public.background_jobs ((payload->>'sessionId'))
  where type = 'ai_scorecard' and status in ('queued', 'running');

-- 2. Confirm.
select indexname, indexdef
  from pg_indexes
 where tablename = 'background_jobs'
   and indexname = 'background_jobs_ai_scorecard_live_uniq';
