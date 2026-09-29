-- ============================================================================
-- Migration 032 — one live transcribe job per RECORDING of an answer
-- ----------------------------------------------------------------------------
-- The 027/030 pattern for the third paid job type, with one difference: the
-- key is the recording generation, not the answer. An answer keeps its row id
-- across re-records (the confirm route upserts on session_id + position), so
-- a key on answerId alone would let a job for the OLD recording block the job
-- for the new one. The generation is interview_answers.recorded_at, carried in
-- the payload as recordedAt - copied verbatim from the string PostgREST
-- returned on the upsert, so every payload uses the database's own formatting
-- and equal generations compare equal here.
--
-- What it guarantees: two concurrent enqueues for the same answer AND the same
-- recordedAt collapse to one job (the second gets 23505, read as "already
-- queued" by src/lib/interviews/transcribe-request.ts). What it deliberately
-- allows: a job for a newer recordedAt beside a queued job for an older one;
-- the confirm route retires the older queued job on re-record, and the handler
-- checks the generation before any storage access, before the Whisper call,
-- and again on the final write (src/lib/interviews/transcribe.ts).
--
-- Partial on purpose: only queued or running rows are in the index, so a
-- deliberate re-record after a completed transcription enqueues normally.
--
-- Run by hand in the Supabase SQL editor BEFORE the code deploys. Idempotent
-- via IF NOT EXISTS. Steps 0a and 0b are read-only checks; both must return
-- zero rows.
-- ============================================================================

-- 0a. Look first. Expect no rows; a row means two live jobs share a generation
--     and one must be retired before the index can be created.
select payload->>'answerId' as answer_id,
       payload->>'recordedAt' as recorded_at,
       count(*) as live_jobs
  from public.background_jobs
 where type = 'transcribe' and status in ('queued', 'running')
 group by 1, 2
having count(*) > 1;

-- 0b. Legacy payloads. The new handler runs a job with no recordedAt once,
--     unchecked, for safety - but that path must not be relied on at deploy.
--     Expect ZERO rows. If any appear, let them finish (they are minutes of
--     work) or retire them by hand before deploying.
select id, status, created_at, payload
  from public.background_jobs
 where type = 'transcribe'
   and status in ('queued', 'running')
   and (payload->>'recordedAt') is null;

-- 1. The index.
create unique index if not exists background_jobs_transcribe_live_uniq
  on public.background_jobs ((payload->>'answerId'), (payload->>'recordedAt'))
  where type = 'transcribe' and status in ('queued', 'running');

-- 2. Confirm.
select indexname, indexdef
  from pg_indexes
 where tablename = 'background_jobs'
   and indexname = 'background_jobs_transcribe_live_uniq';
