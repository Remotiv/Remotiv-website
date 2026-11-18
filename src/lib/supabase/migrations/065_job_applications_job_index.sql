-- ============================================================================
-- Migration 065 - an index on job_applications.job_id (#82)
-- ----------------------------------------------------------------------------
-- APPLIED (see below). Run by hand in the Supabase SQL editor, STAGING FIRST, then
-- production only after staging's step 2 reads as expected. Run the CREATE
-- (step 1) ALONE: its own execution, nothing else in the editor. Nothing in the
-- repository executes this file.
--
-- APPLIED TO STAGING:    18 Nov 2026, Waleed (before false/false; after definition_ok true, valid true)
-- APPLIED TO PRODUCTION: 18 Nov 2026, Waleed (same results)
--
-- ── NOT ONE TRANSACTION ──────────────────────────────────────
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run step 0,
-- then step 1 ALONE (its own execution, nothing else in the editor), then
-- step 2. If the editor wraps statements in a transaction, step 1 fails with
-- "cannot run inside a transaction block" and nothing is created; run it alone.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- No index on job_applications starts with job_id (prod dump, 16 Nov 2026).
-- On staging (10,003 applications), EXPLAIN of
--   select count(*) from job_applications where job_id = $1
-- is Aggregate > Seq Scan on job_applications: every per-job count reads the
-- whole table, every company's rows. That count runs once per job on the Jobs
-- page and the deleted-jobs view, twice per view of a public job page (now
-- cached for 5 minutes), in #32's per-job counts on Overview, and on the
-- ON DELETE SET NULL from jobs.
--
-- (job_id, created_at desc) serves both the all-time count and the this-week
-- count (job_id = $1 and created_at >= ...).
--
-- ── Lock behaviour ───────────────────────────────────────────
--
-- CONCURRENTLY does not block reads or writes on job_applications; it waits for
-- transactions already running, and takes longer than a plain build. A build
-- that is cancelled part-way leaves an INVALID index: step 2 shows it; drop it
-- (drop index concurrently ...) and run step 1 again.
-- ============================================================================

-- ── 0. BEFORE. Expect: false, false (no such index yet, no index led by job_id).
select
  to_regclass('public.idx_ja_job_created') is not null                     as already_there,       -- false
  exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'job_applications'
       and indexdef ~ 'USING btree \(job_id[,)]'
  )                                                                        as other_job_id_index;  -- false

-- ── 1. Run ALONE. ──
create index concurrently if not exists idx_ja_job_created
  on public.job_applications using btree (job_id, created_at desc);

-- ── 2. AFTER. ──
select
  pg_get_indexdef('public.idx_ja_job_created'::regclass)
    = 'CREATE INDEX idx_ja_job_created ON public.job_applications USING btree (job_id, created_at DESC)'
                                                                           as definition_ok,       -- true
  (select indisvalid and indisready from pg_index
    where indexrelid = 'public.idx_ja_job_created'::regclass)              as valid;               -- true

-- Optional, read-only (no ANALYZE: nothing runs). Use a job id you already
-- hold; never paste one anywhere shared. Expect an Index Only Scan or Index
-- Scan on idx_ja_job_created, not a Seq Scan.
--   explain select count(*) from public.job_applications where job_id = '<job uuid>';

-- ── ROLLBACK. Run ALONE. ──
-- drop index concurrently if exists public.idx_ja_job_created;
