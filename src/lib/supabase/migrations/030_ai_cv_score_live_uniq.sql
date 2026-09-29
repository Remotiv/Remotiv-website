-- ============================================================================
-- Migration 030 — one live ai_cv_score job per application
-- ----------------------------------------------------------------------------
-- The 027 pattern, for the other paid scorer. ai_cv_score is enqueued from
-- five places — /api/apply, a manual add, attaching a CV, Re-score on one
-- applicant, Re-score on a whole job — and background_jobs has no dedupe key,
-- so two of them can pass the "is one already queued?" read together and both
-- insert. The handler upserts, so the RESULT is the same card, but both jobs
-- run and both are paid Claude calls. Live when this was written: one
-- application with four jobs, one pair enqueued under five minutes apart.
--
-- Partial on purpose: only queued or running rows are in the index. A job that
-- succeeded, failed or died drops out, so a deliberate later Re-score of the
-- same application is still allowed. The application reads the 23505 this
-- raises as "already queued" (src/lib/ai/cv-score-request.ts) and every
-- enqueue site goes through that one helper.
--
-- Run by hand in the Supabase SQL editor BEFORE the code deploys: until it
-- exists the helper degrades to the pre-check alone, which narrows the window
-- but does not close it. Safe on the live table — zero queued or running
-- ai_cv_score rows when this was written; step 0 checks anyway. Idempotent via
-- IF NOT EXISTS.
-- ============================================================================

-- 0. Look first. Expect no rows; a row means two live jobs share an
--    applicationId and one must be retired before the index can be created.
select payload->>'applicationId' as application_id, count(*) as live_jobs
  from public.background_jobs
 where type = 'ai_cv_score' and status in ('queued', 'running')
 group by 1
having count(*) > 1;

-- 1. The index.
create unique index if not exists background_jobs_ai_cv_score_live_uniq
  on public.background_jobs ((payload->>'applicationId'))
  where type = 'ai_cv_score' and status in ('queued', 'running');

-- 2. Confirm.
select indexname, indexdef
  from pg_indexes
 where tablename = 'background_jobs'
   and indexname = 'background_jobs_ai_cv_score_live_uniq';
