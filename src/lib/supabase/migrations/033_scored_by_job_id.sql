-- ============================================================================
-- Migration 033 — which run produced each interview score
-- ----------------------------------------------------------------------------
-- The ai_scorecard handler makes up to seven paid calls in sequence. When the
-- worker is killed or yields for budget after some of them, the job is retried
-- and, until now, re-paid every call. The retry needs to know which answer
-- scores THIS execution already persisted - and a future deliberate re-score
-- needs to be able to replace all of them regardless.
--
-- The job id is the run token: a retry is the same background_jobs row, a
-- deliberate re-score is a new one. Each score row records the job that wrote
-- it. The rule (src/lib/ai/scorecard-resume.ts):
--   status = 'scored' AND scored_by_job_id = <this job>  → reuse, no call
--   anything else                                        → score
-- so a fresh job id re-scores everything, a null from before this migration
-- re-scores, and a failed or skipped row is always retried.
--
-- Nullable, no default, no backfill: existing rows read as "unknown run" and
-- are simply re-scored by whichever job touches them next. Not a foreign key:
-- background_jobs rows are swept after 30 days and the score must outlive the
-- job that wrote it.
--
-- Run by hand in the Supabase SQL editor BEFORE the code deploys - the handler
-- writes the column on every score. Idempotent via IF NOT EXISTS.
-- ============================================================================

alter table public.interview_answer_scores
  add column if not exists scored_by_job_id uuid;
comment on column public.interview_answer_scores.scored_by_job_id is
  'background_jobs.id of the ai_scorecard run that wrote this row. A retry of the same job reuses a scored row it wrote; any other job re-scores. Not an FK: jobs are swept, scores are not.';

alter table public.interview_session_scores
  add column if not exists scored_by_job_id uuid;
comment on column public.interview_session_scores.scored_by_job_id is
  'background_jobs.id of the ai_scorecard run that wrote this rollup. A retry that finds its own scored rollup has nothing left to do.';

-- Confirm: expect two rows, both uuid, both nullable.
select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and column_name = 'scored_by_job_id'
   and table_name in ('interview_answer_scores', 'interview_session_scores')
 order by table_name;
