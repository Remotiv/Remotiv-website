-- ============================================================================
-- #68 alignment, step 03: migration 058 on STAGING
-- ----------------------------------------------------------------------------
-- STAGING ONLY, by decision of this plan (058 itself has no staging refusal).
--
-- RUN src/lib/supabase/migrations/058_communication_logs_attempt_clock.sql AS
-- WRITTEN: one paste, from its begin; to its commit;, one execution. This
-- file does not copy it. This file holds only the checks before and after.
--
-- Closes, from the #68 audit (14 Nov 2026): column
-- communication_logs.attempt_started_at (058:87) and its column comment
-- (058:90). This is also the object scripts/staging/schema-dump.mjs requires,
-- so the staging dump stops being refused as OUTDATED after this step.
--
-- ── Why 058 can run on staging exactly as written ────────────
--
--   1. No production constant in 058:64-126: one nullable column, no default,
--      no backfill, one comment, one invariant.
--   2. It reads no rows: its invariant (058:100-124) checks information_schema
--      only, so staging's data cannot trip it.
--   3. Re-runnable: add column if not exists (058:87).
--   4. It must come before 059 (059:27 rests on it), and 059 is not part of
--      this plan.
-- ============================================================================


-- ── BEFORE: read-only, run alone first (058:57-61, plus the staging check) ──

begin;
set transaction read only;

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'communication_logs'
      and column_name = 'attempt_started_at')                           as attempt_started_at_columns, -- 0
  to_regclass('staging_guard.sentinel') is not null                     as is_staging;                 -- true, or STOP

rollback;


-- ── Then run 058 as written. Expect "Success. No rows returned". ──
--
-- If its block raises, nothing was applied. Run  rollback;  on its own, then
-- the BEFORE query again (0 columns).


-- ── AFTER: read-only (058:129-133, plus the comment) ────────

begin;
set transaction read only;

select
  (select data_type || ', ' || is_nullable || ', ' || coalesce(column_default, 'NULL')
     from information_schema.columns
    where table_schema = 'public' and table_name = 'communication_logs'
      and column_name = 'attempt_started_at')                           as attempt_started_at_column, -- timestamp with time zone, YES, NULL
  col_description('public.communication_logs'::regclass,
    (select attnum from pg_attribute
      where attrelid = 'public.communication_logs'::regclass
        and attname = 'attempt_started_at')) is not null                as has_comment;               -- true

rollback;

-- ── ROLLBACK of a committed apply: 058's own (058:144-158), only while no
-- code on staging writes the column. Not repeated here.
