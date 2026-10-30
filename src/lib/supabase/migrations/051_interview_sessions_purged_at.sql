-- ============================================================================
-- Migration 051 - interview_sessions.purged_at: the interview purge's marker (#59)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. For review. Run by hand in the Supabase SQL editor, after 050.
-- Staging first; production after Phase 3 shows the decay is gone.
--
-- RUN THIS FILE FIRST, once, top to bottom. Every statement here runs once.
-- Nothing in it is meant to be repeated, and a pin in
-- src/lib/interview-purge-decay.test.ts fails if a repeatable statement is
-- ever added here. Three steps: the column, its index, and the twenty-first
-- job type for the orphan sweep (#59c).
--
-- THEN run scripts/backfills/051-interview-sessions-purged-at.sql, which stamps
-- the sessions already purged: a dry-run count and a 500-row batch pasted
-- until it reports 0. It lives outside this directory because it is not a
-- migration, and so that looping on it can never leave a later step of this
-- file unrun.
--
-- ── Why a column, and why this one ───────────────────────────
--
-- The purge (lib/interviews/purge.ts) clears a session's answers, turns,
-- video pieces and score words, but never touched the session row, so a
-- purged session matched `delete_after <= now` forever and every run re-walked
-- the whole purged history before it reached new work. Measured on staging:
-- 36 to 45 sessions per 18-second run, every run ending "budget reached".
--
-- `purged_at timestamptz null` on the session itself, written by the purge
-- once every sub-purge reports nothing left to retry for that session. A
-- timestamp rather than a boolean because "when" is the audit answer, and a
-- column on interview_sessions rather than a side table because the purge's
-- selector reads interview_sessions and nothing else, so the filter is one
-- `and purged_at is null` with no join. NULL means "not yet", which is what
-- every existing row means today, so the ADD COLUMN itself changes nothing.
--
-- ── Before running (staging and production alike) ────────────
--
-- select to_regclass('public.interview_sessions') as table_exists,
--        (select count(*) from information_schema.columns
--          where table_schema = 'public' and table_name = 'interview_sessions'
--            and column_name = 'purged_at') as already_there,
--        (select count(*) from public.interview_sessions
--          where delete_after is not null and delete_after <= now()) as past_retention;
--
-- Expected: the table exists, already_there = 0, and past_retention is the
-- backlog the purge has been re-walking.
-- ============================================================================

-- ── Step 1: the column ───────────────────────────────────────
alter table public.interview_sessions
  add column if not exists purged_at timestamptz null;

comment on column public.interview_sessions.purged_at is
  'Set by the retention purge once every sub-purge (answers, turns, video pieces, score words) reported nothing left to retry for this session. NULL = not yet purged, or past retention with something still held back (an object storage could not confirm gone). The purge reads only rows where this is NULL.';

-- ── Step 2: the purge's read, exactly ────────────────────────
-- Due and unmarked, paged by key on (delete_after, id). Partial, so it holds
-- only the rows the purge can still want; it shrinks as the backfill below and
-- every later run mark rows.
create index if not exists interview_sessions_purge_due_idx
  on public.interview_sessions (delete_after, id)
  where purged_at is null;

-- ============================================================================
-- Step 3: interview_orphan_sweep, the twenty-first job type (#59c)
-- ----------------------------------------------------------------------------
-- The orphan sweep of the interview-videos bucket is now its own daily job
-- (jobs-queue.ts RECURRING), so a backlog in interview_purge cannot starve it.
-- An orphan is a candidate recording whose row write failed after the upload:
-- no row, no delete_after, nothing else ever expires it.
--
-- background_jobs_type_check lists every allowed job type, so without this
-- step the worker's scheduler would try to enqueue the job once a minute and
-- the database would refuse it, non-fatally and forever: the sweep would be
-- built, registered, scheduled and never run. Same guarded pattern as 040 and
-- 047: the live constraint must be exactly the approved twenty, or on a re-run
-- exactly the approved twenty-one, or this refuses and changes nothing.
-- ============================================================================

do $$
declare
  v_def    text;
  v_count  integer;
  v_val    text;
  v_have   text[];
  v_want   text[];
  v_types  text[] := array[
    'ai_cv_score',
    'send_message',
    'interview_reminder',
    'interview_expiry',
    'interview_expiry_sweep',
    'cv_score_recompute',
    'transcribe',
    'ai_scorecard',
    'calendar_sync',
    'interview_purge',
    'cv_purge',
    'queue_sweep',
    'talent_retention_warn',
    'talent_retention_purge',
    'final_bot_sync',
    'final_bot_lobby_check',
    'final_recording_import',
    'final_recording_import_watchdog',
    'final_recording_purge'
  ];
  v_twenty text[];
begin
  v_twenty := v_types || array['access_log_purge'];
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.background_jobs'::regclass
     and conname  = 'background_jobs_type_check';
  if v_def is null then
    raise exception '051: background_jobs_type_check not found. Inspect the live constraints; this file will not guess a name.';
  end if;
  -- Every quoted value in the live definition, as a set.
  select coalesce(array_agg(distinct m[1] order by m[1]), '{}') into v_have
    from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') as m;
  if 'interview_orphan_sweep' = any(v_have) then
    -- A re-run: the constraint must be exactly the approved twenty-one.
    select array_agg(x order by x) into v_want from unnest(v_types || array['access_log_purge', 'interview_orphan_sweep']) as x;
    if v_have is distinct from v_want then
      raise exception
        '051: background_jobs_type_check already allows interview_orphan_sweep but is not exactly the approved twenty-one. Missing: %. Extra: %. Live definition: %',
        (select coalesce(array_agg(x), '{}') from unnest(v_want) as x where not x = any(v_have)),
        (select coalesce(array_agg(x), '{}') from unnest(v_have) as x where not x = any(v_want)),
        v_def;
    end if;
    raise notice '051: background_jobs_type_check is exactly the approved twenty-one; nothing to change.';
    return;
  end if;
  v_count := (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text');
  if v_count <> array_length(v_twenty, 1) then
    raise exception
      '051: expected exactly % job types in background_jobs_type_check (040 nineteen plus 047 access_log_purge) but the live constraint has %. Not replacing an unexpected definition. Live definition: %',
      array_length(v_twenty, 1), v_count, v_def;
  end if;
  foreach v_val in array v_twenty loop
    if position(quote_literal(v_val) || '::text' in v_def) = 0 then
      raise exception
        '051: background_jobs_type_check does not include expected value %. Not replacing an unexpected definition. Live definition: %',
        v_val, v_def;
    end if;
  end loop;
  alter table public.background_jobs drop constraint background_jobs_type_check;
  execute format(
    'alter table public.background_jobs add constraint background_jobs_type_check check (type in (%s))',
    (select string_agg(quote_literal(x), ', ') from unnest(v_types || array['access_log_purge', 'interview_orphan_sweep']) as x)
  );
  raise notice '051: background_jobs_type_check now allows % values.', array_length(v_types, 1) + 2;
end
$$;

-- ── Done. Now run the backfill ───────────────────────────────
--
-- This file ran once, top to bottom. The backfill that stamps the sessions
-- already purged is NOT here: it is pasted repeatedly until it reports 0,
-- which has no place in a migration. It is
--
--   scripts/backfills/051-interview-sessions-purged-at.sql
--
-- Run it after this file, on the same database. Until it has run, the purge
-- still re-walks the existing backlog; after it, only the sessions that still
-- hold something are read again.
