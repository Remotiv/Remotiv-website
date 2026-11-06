-- ============================================================================
-- Migration 056 - candidate erasure, slice 1: the orphan sweep (#72)
-- ----------------------------------------------------------------------------
-- NOT RUN. This file is a report. Waleed applies it by hand in the Supabase
-- SQL editor after reviewing the SQL and running the pre-check below. Nothing
-- in the repository executes it; migration-056.test.ts pins its text against
-- the TypeScript constants it must agree with.
--
-- RUN THIS FILE AS ONE EXECUTION: PASTE IT WHOLE, FROM begin; TO commit;.
-- RUNNING IT IN PIECES BREAKS THE ROLLBACK GUARANTEE. The SQL editor sends
-- the whole text in one request, and the explicit begin; and commit; make it
-- one transaction; if any statement errors, the transaction is aborted, the
-- trailing commit; performs a ROLLBACK, and every column, trigger, function,
-- table and grant below vanishes together, DDL included. Run step by step,
-- each execution is its own transaction and the earlier steps survive a
-- failure in a later one.
--
-- If any statement errors: run, as a separate execution,
--   rollback;
-- (harmless if nothing is open: "there is no transaction in progress"), then
-- prove nothing was left behind with the one query at the end of the
-- pre-check, which must answer null, 0, 0, 0.
--
-- ── What this is ─────────────────────────────────────────────
--
-- When a company deletes an application, communication_logs.application_id
-- and notifications_company.application_id go NULL (ON DELETE SET NULL,
-- production catalog, 6 Nov 2026). The message row keeps the address, the
-- subject and the text; the bell keeps the candidate's name. The dashboard
-- hides both (messages/actions.ts:108-127), so the orphan is the one place
-- the product's "delete means erasure" is not kept. This migration:
--
--   1. gives both tables an orphaned_at column, stamped by a trigger the
--      moment the FK nulls application_id, so a sweep can honour a window
--      measured from the orphaning, never from created_at;
--   2. creates candidate_erasures, the record that a clearing happened;
--   3. creates a read-only preview and the sweep function, which refuses any
--      cutoff inside the 30-day window and is idempotent by operation id;
--   4. runs ONE-TIME statements for the rows that predate orphaned_at, with
--      their own audit row and the real counts, refused on a second run.
--
-- ── Measured on production, 6 Nov 2026 (catalog and counts only) ─
--
--   communication_logs with application_id IS NULL: 86, created in
--   August (67) and September (19) 2026; none in October or November.
--   notifications_company with application_id IS NULL, by type:
--     interview_expired 17, score_ready 8, interview_rescheduled 2,
--     interview_booked 1, interview_cancelled 1  (29, all Aug-Sep 2026)
--     invite_accepted 1, added_to_job 1          (8 Oct 2026; team events,
--                                                 null by design, NOT swept)
--   applicant_deleted: 0 rows.
--
-- ONE DATE SERVES BOTH TABLES: created_at < '2026-10-01' takes every one of
-- the 86 message rows and all 29 sweepable bells, and excludes the two
-- October team rows, which the type list excludes as well. The same date is
-- used in both one-time statements so the two cannot drift.
--
-- ── Waleed's decision, 6 Nov 2026 ────────────────────────────
--
-- Sweep them. The dispute window has passed, no dispute was raised, and no
-- candidate has asked for deletion. The absence of October and November rows
-- says these are the residue of a past bulk cleanup, not an ongoing drip.
--
-- ── A provenance inference, POSSIBLE not proven ──────────────
--
-- applicant_deleted is always written with a NULL application_id
-- (applicants/actions.ts:2504-2508), so every such bell is an orphan from
-- birth and would appear in the count above. There are none. Had the
-- company-facing delete action produced the 86 orphans, about 86 of these
-- bells would exist. So those deletions came by another path, most likely the
-- admin or super-admin one, or they predate the bell. This is the first
-- positive evidence on a question that has rested on a negative. It changes
-- nothing here, and #88 still fixes that writer to stop recording the name,
-- in the BODY as well as the title.
--
-- ── Why applicant_deleted is NOT in the sweep ─────────────────
--
-- It is orphaned from birth, so a sweep would delete it fresh and unread, and
-- the company would silently lose the one bell meant to outlive the
-- applicant. It stays. There is no one-time title rewrite either: with zero
-- rows it would be a no-op.
--
-- ── Pre-check (run first; every expected value is from 6 Nov 2026) ─
--
-- select count(*) as orphan_messages                               -- expect 86
--   from public.communication_logs where application_id is null;
-- select type, count(*) from public.notifications_company           -- expect the table above
--  where application_id is null group by 1 order by 1;
-- select count(*) as applicant_deleted_rows                         -- expect 0
--   from public.notifications_company where type = 'applicant_deleted';
-- select count(*) as triggers_on_both                               -- expect 0
--   from pg_trigger
--  where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
--    and not tgisinternal;
-- select to_regclass('public.candidate_erasures') as already_there; -- expect null
-- select count(*) filter (where created_at >= '2026-10-01') as orphans_after_cutoff  -- expect 0
--   from public.communication_logs where application_id is null;
--
-- Your own auth.users id, for performed_by in step 6 (pick your row):
-- select id, email from auth.users where email ilike '%@remotiv.work' order by created_at;
-- Then replace the sentinel in step 6 with it. The block refuses the sentinel.
--
-- Nothing left behind (after a failed run, or to confirm a clean start):
-- select to_regclass('public.candidate_erasures') as table_left,                          -- null
--        (select count(*) from pg_trigger
--          where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
--            and not tgisinternal) as triggers_left,                                         -- 0
--        (select count(*) from pg_proc
--          where proname in ('erased_address', 'sweepable_notification_types', 'sweep_not_covered',
--                            'stamp_orphaned_at', 'preview_orphaned_message_rows',
--                            'erase_orphaned_message_rows')) as functions_left,              -- 0
--        (select count(*) from information_schema.columns
--          where table_schema = 'public' and column_name = 'orphaned_at'
--            and table_name in ('communication_logs', 'notifications_company')) as columns_left;  -- 0
-- ============================================================================

begin;

-- The ALTERs in step 2 take ACCESS EXCLUSIVE on communication_logs and on
-- notifications_company and hold it until commit. If a long transaction
-- already holds a lock on either, the ALTER would wait and every new reader
-- and writer would queue behind it. Fail fast instead: the migration rolls
-- back whole, and is simply run again.
set local lock_timeout = '5s';

-- ── 1. Constants: one SQL home each ──────────────────────────
--
-- Their TypeScript twins are ERASED_ADDRESS (lib/email/candidate/types.ts)
-- and SWEEPABLE_NOTIFICATION_TYPES (lib/notifications/company.ts).
-- migration-056.test.ts holds the two pairs equal.

create or replace function public.erased_address() returns text
language sql immutable
as $$ select '[erased]' $$;

-- Only the types whose title or body can carry a candidate's name, each
-- justified in company.ts beside SWEEPABLE_NOTIFICATION_TYPES. A type that
-- never writes a name gains nothing from a sweep and costs an unread bell.
-- applicant_deleted is deliberately absent (above). The final_recording types
-- and message_failed never carry a name.
create or replace function public.sweepable_notification_types() returns text[]
language sql immutable
as $$
  select array['score_ready', 'stage_change', 'interview_booked', 'interview_rescheduled',
               'interview_cancelled', 'interview_expired']
$$;

-- What this slice does not reach, recorded on every audit row.
create or replace function public.sweep_not_covered() returns text[]
language sql immutable
as $$
  select array['whatsapp_inbound', 'interview_bookings', 'communication_opt_outs',
               'whatsapp_opt_outs', 'talent_profiles']
$$;

-- ── 2. orphaned_at, stamped by the FK's own update ───────────
--
-- Neither table has a trigger today (pre-check expects 0), so this is
-- additive. The FK does the nulling; only a trigger sees it happen. A row
-- born with a NULL application_id is never updated this way and never gets a
-- stamp, which is why the sweep's type list holds only types that are always
-- written against a live application (company.ts).
--
-- BEFORE UPDATE OF application_id fires only for an UPDATE whose SET list
-- names application_id. The status and error updates in deliverEmail
-- (lib/email/candidate/deliver.ts), the WhatsApp dispatcher
-- (lib/whatsapp/dispatch.ts) and the WhatsApp webhook
-- (app/api/webhooks/whatsapp/route.ts) set status, error, sent_at and the
-- provider ids and never application_id, so none of them runs this trigger.
-- Neither do the sweep's own updates below, which set to_address, subject,
-- body, error and the provider ids. The only statement that writes
-- application_id is the FK's ON DELETE SET NULL, which is exactly the one
-- this trigger exists for. A trigger on the busiest table is not a cost on
-- its busiest path.

alter table public.communication_logs    add column orphaned_at timestamptz;
alter table public.notifications_company add column orphaned_at timestamptz;

create or replace function public.stamp_orphaned_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.application_id is not null and new.application_id is null then
    new.orphaned_at := now();
  end if;
  return new;
end;
$$;

create trigger communication_logs_orphaned_at
  before update of application_id on public.communication_logs
  for each row execute function public.stamp_orphaned_at();

create trigger notifications_company_orphaned_at
  before update of application_id on public.notifications_company
  for each row execute function public.stamp_orphaned_at();

-- ── 3. candidate_erasures: the record that a clearing happened ─
--
-- operation_id is client-generated and UNIQUE: a retry after a dropped
-- connection either finds this row (it committed) or inserts it (it did not).
-- Never the address, never a name, never a cleared row's id: counts only.
-- RLS on with no policy and no grant to anon or authenticated, as 055 does.

create table public.candidate_erasures (
  id            uuid primary key default gen_random_uuid(),
  operation_id  uuid not null unique,
  performed_at  timestamptz not null default now(),
  performed_by  uuid not null,
  mode          text not null check (mode in ('sweep', 'address')),
  subject_kind  text check (subject_kind in ('email', 'phone')),
  subject_hmac  text,
  cleared       jsonb not null,
  not_covered   text[] not null default '{}',
  constraint candidate_erasures_subject
    check ((mode = 'address') = (subject_kind is not null and subject_hmac is not null))
);

alter table public.candidate_erasures enable row level security;
revoke all on table public.candidate_erasures from public, anon, authenticated;
grant select, insert on table public.candidate_erasures to service_role;

-- ── 4. Preview: counts only, writes nothing ──────────────────
--
-- A dry run must not leave a row behind: a candidate_erasures row from a
-- preview would read as a consumed operation.

create or replace function public.preview_orphaned_message_rows(p_orphaned_before timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'communication_logs',
      (select count(*) from public.communication_logs
        where application_id is null
          and orphaned_at is not null and orphaned_at < p_orphaned_before
          and to_address <> public.erased_address()),
    'notifications_company',
      (select count(*) from public.notifications_company
        where application_id is null
          and orphaned_at is not null and orphaned_at < p_orphaned_before
          and type = any (public.sweepable_notification_types())))
$$;

-- ── 5. The sweep ─────────────────────────────────────────────
--
-- Clears message rows (address, subject, text, provider ids; the event, the
-- channel, the status, the company, the times and sent_by_name stay, so every
-- count survives) and deletes name-bearing bells, for rows orphaned before
-- the cutoff. The window is enforced HERE and never clamped: a cutoff inside
-- the last 30 days is refused, so a future date cannot clear what was
-- orphaned yesterday. The one-time statements in step 6 are the explicit
-- exception and do not go through this function.

create or replace function public.erase_orphaned_message_rows(
  p_operation_id    uuid,
  p_performed_by    uuid,
  p_orphaned_before timestamptz
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  done    jsonb;
  n_logs  bigint;
  n_bells bigint;
begin
  if p_operation_id is null or p_performed_by is null or p_orphaned_before is null then
    raise exception 'erase_orphaned_message_rows: every argument is required'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_orphaned_before > now() - interval '30 days' then
    raise exception 'erase_orphaned_message_rows: cutoff % is inside the 30-day window; refused, not clamped',
      p_orphaned_before
      using errcode = 'check_violation';
  end if;

  -- A retry of an operation that already committed: answer from the record,
  -- touch nothing.
  select cleared into done from public.candidate_erasures where operation_id = p_operation_id;
  if found then
    return done;
  end if;

  update public.communication_logs
     set to_address = public.erased_address(),
         subject = null, body = null, error = null,
         provider_message_id = null, provider_id = null
   where application_id is null
     and orphaned_at is not null and orphaned_at < p_orphaned_before
     and to_address <> public.erased_address();
  get diagnostics n_logs = row_count;

  delete from public.notifications_company
   where application_id is null
     and orphaned_at is not null and orphaned_at < p_orphaned_before
     and type = any (public.sweepable_notification_types());
  get diagnostics n_bells = row_count;

  done := jsonb_build_object('communication_logs', n_logs, 'notifications_company', n_bells);

  insert into public.candidate_erasures (operation_id, performed_by, mode, cleared, not_covered)
  values (p_operation_id, p_performed_by, 'sweep', done, public.sweep_not_covered());

  return done;
end;
$$;

revoke all on function public.preview_orphaned_message_rows(timestamptz)
  from public, anon, authenticated;
revoke all on function public.erase_orphaned_message_rows(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.preview_orphaned_message_rows(timestamptz) to service_role;
grant execute on function public.erase_orphaned_message_rows(uuid, uuid, timestamptz) to service_role;

-- ── 6. ONE-TIME: the rows that predate orphaned_at ───────────
--
-- Run once, with this migration, never again. The 86 message rows and the
-- 29 bells were orphaned before any stamp existed and can never carry one.
-- The predicate is exactly "no stamp and created before 2026-10-01":
--   orphaned_at IS NULL   excludes anything orphaned since step 2 created the
--                         trigger, which is the row a window protects, even if
--                         its message dates from August;
--   created_at < '2026-10-01'  is the measured boundary: every orphan was
--                         created in August or September 2026 and none later,
--                         and it excludes the two October team bells.
-- No orphaned_at is backfilled: a made-up timestamp would be a false record.
--
-- This clearing writes its own audit row with the REAL counts from the
-- statements, not the expected 86 and 29. Its operation_id is a fixed
-- literal, so a second run is refused by the unique constraint; the block
-- also checks first so the refusal is a clear message rather than a late
-- constraint error. A count other than 86 or 29 means the premise moved
-- between the measurement and this run: the block raises, everything in this
-- transaction rolls back, and the counts are measured again before retrying.

do $$
declare
  op           constant uuid := '7b2c9b8e-0056-4a6e-9f01-202611060000';
  performed_by constant uuid := '00000000-0000-0000-0000-000000000000';  -- REPLACE with your auth.users id
  n_logs  bigint;
  n_bells bigint;
begin
  if performed_by = '00000000-0000-0000-0000-000000000000' then
    raise exception 'migration 056: set performed_by to your auth.users id before running step 6';
  end if;

  if exists (select 1 from public.candidate_erasures where operation_id = op) then
    raise exception 'migration 056: the one-time sweep has already run (operation %)', op;
  end if;

  update public.communication_logs
     set to_address = public.erased_address(),
         subject = null, body = null, error = null,
         provider_message_id = null, provider_id = null
   where application_id is null
     and orphaned_at is null and created_at < '2026-10-01'
     and to_address <> public.erased_address();
  get diagnostics n_logs = row_count;

  delete from public.notifications_company
   where application_id is null
     and orphaned_at is null and created_at < '2026-10-01'
     and type = any (public.sweepable_notification_types());
  get diagnostics n_bells = row_count;

  -- Expected 86 and 29, measured 6 Nov 2026. Anything else stops the run.
  if n_logs <> 86 or n_bells <> 29 then
    raise exception 'migration 056: cleared % message rows (expected 86) and % bells (expected 29); re-measure before retrying',
      n_logs, n_bells;
  end if;

  insert into public.candidate_erasures (operation_id, performed_by, mode, cleared, not_covered)
  values (op, performed_by, 'sweep',
          jsonb_build_object('communication_logs', n_logs, 'notifications_company', n_bells),
          public.sweep_not_covered());

  raise notice 'migration 056: one-time sweep cleared % message rows and % bells (operation %)',
    n_logs, n_bells, op;
end;
$$;

-- ── 7. THE INVARIANT, asserted before commit ─────────────────
--
-- The race step 6 cannot see: an application deleted between the pre-check
-- and this run leaves a message with application_id NULL and no stamp (the
-- trigger did not exist yet). If that message was created on or after
-- 2026-10-01, step 6 skips it, the counts still read 86 and 29, and the row
-- would then be unreachable for ever: the sweep requires orphaned_at and
-- step 6 never runs again. So the success condition is not the two counts
-- alone but this: after step 6, nothing orphaned is unstamped.
--
--   communication_logs: every writer requires a string application id
--   (deliver.ts:99, whatsapp/dispatch.ts:104-106, triggers.ts:200-209,
--   reminder.ts:410-419), so a NULL one is always an orphan. Unambiguous.
--   notifications_company: scoped to the six sweepable types, because
--   invite_accepted and added_to_job are legitimately born null. A sweepable
--   bell born null carries the fallback label and no name and would be
--   harmless, but letting it through costs an unreachable row while raising
--   costs a re-measure and a re-run. For a migration that runs once, strict.

do $$
declare
  n_msgs  bigint;
  n_bells bigint;
begin
  select count(*) into n_msgs
    from public.communication_logs
   where application_id is null and orphaned_at is null
     and to_address <> public.erased_address();
  select count(*) into n_bells
    from public.notifications_company
   where application_id is null and orphaned_at is null
     and type = any (public.sweepable_notification_types());
  if n_msgs <> 0 or n_bells <> 0 then
    raise exception 'migration 056: % message row(s) and % bell(s) are orphaned with no stamp after the one-time clear: an application was deleted between the pre-check and this run. Nothing is committed. Re-measure, then either widen the dated predicate in step 6 or stamp the new rows, and retry.',
      n_msgs, n_bells;
  end if;
end;
$$;

commit;

-- ── After running ────────────────────────────────────────────
--
-- select count(*) as triggers_on_both                                -- expect 2
--   from pg_trigger
--  where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
--    and not tgisinternal;
-- The invariant, true at every later date too: nothing orphaned is unstamped
-- and still carries an address.
-- select count(*) as unstamped_orphans_with_address                  -- expect 0, always
--   from public.communication_logs
--  where application_id is null and orphaned_at is null and to_address <> '[erased]';
-- Right after THIS migration only. A row orphaned tomorrow legitimately keeps
-- its address for 30 days, so this reads above 0 later and that is not a fault.
-- select count(*) as orphan_messages_with_address                    -- expect 0 today only
--   from public.communication_logs
--  where application_id is null and to_address <> '[erased]';
-- select count(*) as orphan_name_bells                               -- expect 0 today; later, bells orphaned inside the window
--   from public.notifications_company
--  where application_id is null and type = any (public.sweepable_notification_types());
-- select count(*) as team_bells_untouched                            -- expect 2
--   from public.notifications_company
--  where application_id is null and type in ('invite_accepted', 'added_to_job');
-- select operation_id, mode, cleared, not_covered from public.candidate_erasures;  -- expect 1 row, 86 and 29
-- select proname from pg_proc
--  where proname in ('preview_orphaned_message_rows', 'erase_orphaned_message_rows')
--    and prosrc like '%sweepable_notification_types%';               -- expect 2 rows
-- select (select relrowsecurity from pg_class where oid = 'public.candidate_erasures'::regclass) as rls_on,
--        (select count(*) from pg_policies where tablename = 'candidate_erasures') as policies;  -- true, 0
