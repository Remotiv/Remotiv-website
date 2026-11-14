-- ============================================================================
-- Migration 058 - communication_logs.attempt_started_at: the attempt clock a
--                 stale queued row is judged by (#85)
-- ----------------------------------------------------------------------------
-- APPLIED TO PRODUCTION 14 Nov 2026, by Waleed, by hand in the Supabase SQL
-- editor: one paste, one execution, one transaction. Nothing in the
-- repository executes it. Verified with the information_schema queries below:
--
--   before:  0 columns named attempt_started_at
--   after:   timestamp with time zone, is_nullable YES, column_default null
--
-- PRODUCTION SCHEMA, read by Waleed on 13 Nov 2026, which this file rests on:
--
--   communication_logs.created_at     timestamptz default now()
--   communication_logs.status         text default 'queued'
--   communication_logs.scheduled_for  timestamptz, NULLABLE
--   communication_logs.sent_by_name   text, NULLABLE
--   communication_logs                has no updated_at and no attempt timestamp
--   communication_logs_auto_event_uniq
--     UNIQUE INDEX on (application_id, event, channel) WHERE sent_by_name IS NULL
--     (an index, not a constraint, and without NULLS NOT DISTINCT)
--
-- Migration 026's header calls that a UNIQUE constraint named
-- communication_logs_application_event_channel_uniq. No such constraint or
-- index exists; the name above is the one production holds.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- An automatic send writes its communication_logs row as 'queued' BEFORE it
-- calls the provider, then moves it to 'sent' or 'failed'. A process that dies
-- between the two leaves the row 'queued' for good, and the unique index above
-- makes every retry of that job collide with it. The retry must be able to
-- adopt the row, but only when the attempt that wrote it is clearly dead, and
-- created_at cannot say that: it is the time the row was FIRST written, not
-- the time the current attempt claimed it, so an adopted row would look stale
-- again the instant it was adopted.
--
-- attempt_started_at is that second clock. The application stamps it on the
-- pre-send insert and on every adoption, and every failure write is guarded
-- on the stamp the claim returned, so an attempt that lost its row (to an
-- adoption or to a Request stop) can never overwrite it.
--
-- ── What the column means ────────────────────────────────────
--
--   a timestamp   when the current send attempt claimed this row
--   NULL          written before this migration, or never an attempt
--
-- Nullable, no default, no backfill, on purpose:
--   - a default of now() would stamp every EXISTING queued row with the apply
--     time and make a row that has been dead for days look freshly claimed;
--   - a NULL never satisfies the stale-queued claim's .lt() filter, so a row
--     written before this migration is never adopted by it. The count of such
--     legacy rows that would need adopting was zero when #85 was designed, so
--     no legacy claim exists and none is needed.
--
-- ── Before running: confirm the column is absent ─────────────
--
-- select count(*) as attempt_started_at_columns
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'communication_logs'
--    and column_name = 'attempt_started_at';                                -- 0
-- ============================================================================

begin;

-- The ALTER below takes ACCESS EXCLUSIVE on communication_logs and holds it
-- until commit. Adding a nullable column with no default is a catalog-only
-- change and does not rewrite the table, so the lock is held for moments; but
-- if a long transaction already holds a lock on the table, the ALTER would
-- wait and every sender and reader would queue behind it. Fail fast instead:
-- the migration rolls back whole, and is run again.
set local lock_timeout = '5s';

-- ── 1. The column ────────────────────────────────────────────
--
-- No index. Every query #85 step 3 sends that reads this column is already
-- pinned to at most one row by something indexed:
--   - the stale-queued claim filters application_id, event and channel with
--     sent_by_name IS NULL, which is exactly the key and predicate of
--     communication_logs_auto_event_uniq, so the planner resolves it on that
--     index and attempt_started_at is checked on one row at most;
--   - every guarded failure write filters by id, the primary key, and only
--     then compares status and attempt_started_at on that one row.
-- Nothing scans or sorts by this column, so an index would cost a write on
-- every send and serve no read.

alter table public.communication_logs
  add column if not exists attempt_started_at timestamptz;

comment on column public.communication_logs.attempt_started_at is
  'When the current send attempt claimed this row (#85). Written by the app on the pre-send insert and on every adoption. NULL: written before migration 058, or never an attempt.';

-- ── 2. THE INVARIANT, asserted before commit ─────────────────
--
-- add column if not exists is silent when a column of that name is already
-- there, whatever its type. This block refuses the commit unless the column
-- is exactly what this file says: timestamp with time zone, nullable, and with
-- no default. A failure names what it found and rolls everything back.

do $$
declare
  n_columns bigint;
  found_type text;
  found_nullable text;
  found_default text;
begin
  select count(*) into n_columns
    from information_schema.columns
   where table_schema = 'public' and table_name = 'communication_logs'
     and column_name = 'attempt_started_at';
  select data_type, is_nullable, column_default
    into found_type, found_nullable, found_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'communication_logs'
     and column_name = 'attempt_started_at';
  if n_columns <> 1
     or found_type is distinct from 'timestamp with time zone'
     or found_nullable is distinct from 'YES'
     or found_default is not null then
    raise exception 'migration 058: expected one attempt_started_at column, timestamp with time zone, nullable, no default; found % column(s), type %, nullable %, default %; rolled back',
      n_columns, coalesce(found_type, 'none'), coalesce(found_nullable, 'none'), coalesce(found_default, 'none');
  end if;
end;
$$;

commit;

-- ── After running: the column ────────────────────────────────
--
-- select data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'communication_logs'
--    and column_name = 'attempt_started_at';   -- timestamp with time zone, YES, NULL
--
-- ── Production order ─────────────────────────────────────────
--
-- This migration FIRST, then the code (#85 step 3). What runs in the window
-- between the two: the current production senders never name the column, so
-- every row they write carries NULL, which is the value this file defines for
-- a row written before the code. Nothing reads the column yet. The window is
-- safe. The reverse order would make every pre-send insert name a column that
-- does not exist, and every automatic email and WhatsApp send would fail.
--
-- ── Rollback, only after the code that writes the column is reverted ──
--
-- Dropping the column while step 3's code is live would make every pre-send
-- insert fail, which stops every automatic send. Revert the code first, then:
--
-- ```sql
-- begin;
-- set local lock_timeout = '5s';
-- alter table public.communication_logs
--   drop column if exists attempt_started_at;
-- commit;
-- ```
