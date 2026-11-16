-- ============================================================================
-- #68 alignment, step 01: migration 056 on STAGING, without step 6
-- ----------------------------------------------------------------------------
-- STAGING ONLY. Refuses to write anything on a database without
-- staging_guard.sentinel (README-steps.md step 3 creates it on staging;
-- production never has it), the same refusal 059 uses.
--
-- Closes, from the #68 audit (14 Nov 2026), everything 056 put on production
-- that staging lacks: table candidate_erasures (with its PK, UNIQUE and RLS);
-- columns communication_logs.orphaned_at and notifications_company.orphaned_at;
-- triggers communication_logs_orphaned_at and notifications_company_orphaned_at;
-- functions erased_address, sweepable_notification_types, sweep_not_covered,
-- stamp_orphaned_at, preview_orphaned_message_rows, erase_orphaned_message_rows;
-- and their grants.
--
-- TWO SECTIONS. Run them as two separate executions, A first:
--   A. PRE-CHECK, read-only (begin; set transaction read only; rollback;).
--      Read its one row. Every column must show its expected value, or STOP.
--   B. THE APPLY, one transaction. Paste from its begin; to its commit; as
--      one execution. If any statement errors, run rollback; on its own,
--      then the "nothing left behind" query at the end of this file.
-- Pasting the whole file at once is also safe (B's step 0 re-checks what A
-- reports and refuses), but you would not see A's row.
--
-- ── What is copied, what is removed, and why ─────────────────
--
-- Section B is src/lib/supabase/migrations/056_candidate_erasure_sweep.sql
-- copied VERBATIM, comments included, except:
--
--   REMOVED 056:339-410, all of step 6 (the one-time sweep): its heading and
--   comments (339-360) and its do-block (361-410). Every part of it is
--   production's, not a schema object:
--     - performed_by is Waleed's PRODUCTION auth.users id (056:369), which
--       does not name anyone on staging;
--     - operation 7b2c9b8e-...-202611060000 is production's spent audit row;
--     - it raises unless it clears exactly 86 message rows and 29 bells
--       (056:396-399), production's counts of 6 Nov 2026, so on staging it
--       would roll the whole file back;
--     - its date predicate created_at < '2026-10-01' is production's
--       measured boundary (056:347-350).
--   Removing it removes no schema object: step 6 only updates, deletes and
--   inserts one audit row.
--
--   REMOVED from the pre-check: 056:117-119, the auth.users query. It reads
--   ids and email addresses, and it existed only to fill step 6's
--   performed_by.
--
--   ADDED, step 0 (after set local lock_timeout): the staging refusal and the
--   pre-check's decisive conditions, re-asserted inside the transaction.
--   ADDED, step 8 (before commit): a structural invariant naming every object
--   this file creates and the grants it must leave.
--
-- ── Every safeguard kept, and why each is still valid on staging ─
--
--   begin; ... commit; one transaction (056:135, :451). Valid anywhere: any
--     error rolls back every column, trigger, function and table together.
--   set local lock_timeout = '5s' (056:142). Valid anywhere: fail fast
--     rather than queue the seeded staging app behind an ACCESS EXCLUSIVE lock.
--   Plain "add column" and "create table" with no "if not exists" (056:194-195,
--     :224). Kept on purpose: a second run errors instead of half-applying,
--     which is what you want on staging too.
--   erase_orphaned_message_rows' own refusals (056:290-299): every argument
--     required, a cutoff inside 30 days refused. Not data-dependent.
--   The idempotent operation id (056:301-306) and candidate_erasures'
--     UNIQUE (056:226). Not data-dependent.
--   RLS on candidate_erasures and the revokes (056:237-240, :332-337).
--     Not data-dependent.
--   STEP 7, the invariant (056:412-449): after the apply, no orphaned row is
--     unstamped and still carries an address, and no sweepable bell is
--     orphaned and unstamped. On production it guarded a race against step 6.
--     On staging, with step 6 gone, it asserts the same property directly:
--     the triggers only stamp rows orphaned FROM NOW ON, so a row orphaned
--     before this file runs can never get a stamp, and erase_orphaned_message_rows
--     can never reach it (it requires orphaned_at, 056:309-321). Step 7 refuses
--     to commit in that case rather than leave such a row unreachable for good.
--     That makes its premise on staging: ZERO pre-existing orphans. Section A
--     measures it; step 0 refuses early if it is not zero.
--
-- IF SECTION A SHOWS ORPHANS ON STAGING: do not edit step 7 away. That is a
-- decision for Waleed: clear those seeded rows the way step 6 did, with
-- staging's own counts and a staging user id, or delete them as seed data.
-- Either is a staging data change and is NOT part of this file.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION A. PRE-CHECK, READ-ONLY. Run this section alone, first.
-- 056:101-133, minus 056:117-119, as one row. Expected values for STAGING.
-- ════════════════════════════════════════════════════════════════════════════

begin;
set transaction read only;

select
  -- 056:103-104. Production expected 86; staging must be 0 for step 7 (see header).
  (select count(*) from public.communication_logs
    where application_id is null)                                        as orphan_messages,
  -- step 7's exact message predicate (056:436-439), before orphaned_at exists. Expect 0.
  (select count(*) from public.communication_logs
    where application_id is null and to_address <> '[erased]')           as orphan_messages_with_address,
  -- 056:105-106, as one value: type -> count. Informational.
  (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)
     from (select type, count(*) as n from public.notifications_company
            where application_id is null group by 1) t)                  as orphan_bells_by_type,
  -- step 7's exact bell predicate (056:440-443), the list of 056:159-164. Expect 0.
  (select count(*) from public.notifications_company
    where application_id is null
      and type = any (array['score_ready', 'stage_change', 'interview_booked',
                            'interview_rescheduled', 'interview_cancelled',
                            'interview_expired']))                       as orphan_sweepable_bells,
  -- 056:107-108. Expect 0.
  (select count(*) from public.notifications_company
    where type = 'applicant_deleted')                                    as applicant_deleted_rows,
  -- 056:109-112. Expect 0 (the staging dump of 14 Nov 2026 shows none).
  (select count(*) from pg_trigger
    where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
      and not tgisinternal)                                              as triggers_on_both,
  -- 056:113. Expect null.
  to_regclass('public.candidate_erasures')                               as already_there,
  -- 056:114-115. Informational without step 6 (it mattered only to step 6's date).
  (select count(*) filter (where created_at >= '2026-10-01')
     from public.communication_logs where application_id is null)        as orphans_after_cutoff,
  -- 056:120-132, nothing left behind / clean start. Expect 0, 0, 0.
  (select count(*) from pg_proc
    where proname in ('erased_address', 'sweepable_notification_types', 'sweep_not_covered',
                      'stamp_orphaned_at', 'preview_orphaned_message_rows',
                      'erase_orphaned_message_rows'))                    as functions_left,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'orphaned_at'
      and table_name in ('communication_logs', 'notifications_company'))  as columns_left,
  -- the staging refusal of section B. Expect true. false means NOT staging: stop.
  to_regclass('staging_guard.sentinel') is not null                      as is_staging;

rollback;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION B. THE APPLY. One execution, from begin; to commit;.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- The ALTERs in step 2 take ACCESS EXCLUSIVE on communication_logs and on
-- notifications_company and hold it until commit. If a long transaction
-- already holds a lock on either, the ALTER would wait and every new reader
-- and writer would queue behind it. Fail fast instead: the migration rolls
-- back whole, and is simply run again.
set local lock_timeout = '5s';

-- ── 0. STAGING ONLY, and the pre-check re-asserted (ADDED for #68) ─
--
-- Not in 056. Refuses before anything is written: on a database without the
-- staging sentinel, or if section A's decisive values are not what this file
-- rests on. A refusal here rolls back nothing because nothing has happened.

do $$
declare
  n_msgs  bigint;
  n_bells bigint;
  n_trg   bigint;
begin
  if to_regclass('staging_guard.sentinel') is null then
    raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was written';
  end if;

  if to_regclass('public.candidate_erasures') is not null then
    raise exception 'align-068 01: candidate_erasures already exists; 056 has been applied here. Nothing was written.';
  end if;

  select count(*) into n_trg
    from pg_trigger
   where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
     and not tgisinternal;
  if n_trg <> 0 then
    raise exception 'align-068 01: % trigger(s) already on communication_logs or notifications_company (expected 0). Nothing was written.', n_trg;
  end if;

  select count(*) into n_msgs
    from public.communication_logs
   where application_id is null and to_address <> '[erased]';
  select count(*) into n_bells
    from public.notifications_company
   where application_id is null
     and type = any (array['score_ready', 'stage_change', 'interview_booked',
                           'interview_rescheduled', 'interview_cancelled', 'interview_expired']);
  if n_msgs <> 0 or n_bells <> 0 then
    raise exception 'align-068 01: staging already holds % orphaned message row(s) with an address and % orphaned sweepable bell(s). Without 056 step 6, step 7 would refuse them. Nothing was written; this needs a decision (header).',
      n_msgs, n_bells;
  end if;
end;
$$;

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

-- ── 6. REMOVED for staging (056:339-410) ─────────────────────
--
-- The one-time production sweep. See the header of this file for why each
-- part of it is production's and why nothing structural is lost.

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

-- ── 8. STRUCTURE, asserted before commit (ADDED for #68) ─────
--
-- Not in 056. Everything this file creates, named, plus the grants that
-- section 00 compares, so a partial or wrong apply cannot commit.

do $$
declare
  missing text[] := '{}';
  n bigint;
begin
  if to_regclass('public.candidate_erasures') is null then
    missing := missing || 'table candidate_erasures'::text;
  else
    if not (select relrowsecurity from pg_class where oid = 'public.candidate_erasures'::regclass) then
      missing := missing || 'RLS on candidate_erasures'::text;
    end if;
    select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'candidate_erasures';
    if n <> 0 then
      missing := missing || format('0 policies on candidate_erasures (found %s)', n);
    end if;
    if has_table_privilege('anon', 'public.candidate_erasures', 'SELECT')
       or has_table_privilege('authenticated', 'public.candidate_erasures', 'SELECT')
       or has_table_privilege('public', 'public.candidate_erasures', 'SELECT') then
      missing := missing || 'no SELECT on candidate_erasures for public, anon, authenticated'::text;
    end if;
    if not (has_table_privilege('service_role', 'public.candidate_erasures', 'SELECT')
            and has_table_privilege('service_role', 'public.candidate_erasures', 'INSERT')) then
      missing := missing || 'SELECT and INSERT on candidate_erasures for service_role'::text;
    end if;
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and column_name = 'orphaned_at'
     and table_name in ('communication_logs', 'notifications_company');
  if n <> 2 then
    missing := missing || format('2 orphaned_at columns (found %s)', n);
  end if;

  select count(*) into n from pg_trigger
   where not tgisinternal
     and ((tgrelid = 'public.communication_logs'::regclass and tgname = 'communication_logs_orphaned_at')
       or (tgrelid = 'public.notifications_company'::regclass and tgname = 'notifications_company_orphaned_at'));
  if n <> 2 then
    missing := missing || format('2 orphaned_at triggers (found %s)', n);
  end if;

  if to_regprocedure('public.erased_address()') is null then missing := missing || 'function erased_address()'::text; end if;
  if to_regprocedure('public.sweepable_notification_types()') is null then missing := missing || 'function sweepable_notification_types()'::text; end if;
  if to_regprocedure('public.sweep_not_covered()') is null then missing := missing || 'function sweep_not_covered()'::text; end if;
  if to_regprocedure('public.stamp_orphaned_at()') is null then missing := missing || 'function stamp_orphaned_at()'::text; end if;
  if to_regprocedure('public.preview_orphaned_message_rows(timestamptz)') is null then
    missing := missing || 'function preview_orphaned_message_rows(timestamptz)'::text;
  elsif has_function_privilege('anon', 'public.preview_orphaned_message_rows(timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.preview_orphaned_message_rows(timestamptz)', 'EXECUTE')
     or has_function_privilege('public', 'public.preview_orphaned_message_rows(timestamptz)', 'EXECUTE') then
    missing := missing || 'no EXECUTE on preview_orphaned_message_rows for public, anon, authenticated'::text;
  end if;
  if to_regprocedure('public.erase_orphaned_message_rows(uuid, uuid, timestamptz)') is null then
    missing := missing || 'function erase_orphaned_message_rows(uuid, uuid, timestamptz)'::text;
  elsif has_function_privilege('anon', 'public.erase_orphaned_message_rows(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.erase_orphaned_message_rows(uuid, uuid, timestamptz)', 'EXECUTE')
     or has_function_privilege('public', 'public.erase_orphaned_message_rows(uuid, uuid, timestamptz)', 'EXECUTE') then
    missing := missing || 'no EXECUTE on erase_orphaned_message_rows for public, anon, authenticated'::text;
  end if;

  if array_length(missing, 1) is not null then
    raise exception 'align-068 01: rolled back; not as expected: %', array_to_string(missing, '; ');
  end if;
end;
$$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING (056:453-480, adapted: the two production-only expectations,
-- "1 row, 86 and 29" and "team_bells_untouched 2", are removed)
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin; set transaction read only;
-- select
--   (select count(*) from pg_trigger
--     where tgrelid in ('public.communication_logs'::regclass, 'public.notifications_company'::regclass)
--       and not tgisinternal)                                        as triggers_on_both,               -- 2
--   (select count(*) from public.communication_logs
--     where application_id is null and orphaned_at is null
--       and to_address <> '[erased]')                                as unstamped_orphans_with_address, -- 0, always
--   (select count(*) from public.candidate_erasures)                 as audit_rows,                     -- 0 on staging (no step 6)
--   (select count(*) from pg_proc
--     where proname in ('preview_orphaned_message_rows', 'erase_orphaned_message_rows')
--       and prosrc like '%sweepable_notification_types%')            as functions_using_type_list,      -- 2
--   (select relrowsecurity from pg_class
--     where oid = 'public.candidate_erasures'::regclass)             as rls_on,                         -- true
--   (select count(*) from pg_policies
--     where tablename = 'candidate_erasures')                        as policies;                       -- 0
-- rollback;
--
-- Then 00-effective-access-READONLY.sql on staging: the candidate_erasures
-- row and the six 056 function rows must now read the same as production's.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════════
--
-- If section B errored: run  rollback;  on its own (harmless if nothing is
-- open), then section A again: already_there null, triggers_on_both 0,
-- functions_left 0, columns_left 0 proves nothing was left behind.
--
-- To undo a COMMITTED apply on staging (staging only; nothing on staging
-- writes candidate_erasures, and audit_rows above should be 0 first):
--
-- begin;
-- set local lock_timeout = '5s';
-- do $$ begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: nothing was written';
--   end if;
-- end $$;
-- drop trigger if exists communication_logs_orphaned_at on public.communication_logs;
-- drop trigger if exists notifications_company_orphaned_at on public.notifications_company;
-- drop function if exists public.erase_orphaned_message_rows(uuid, uuid, timestamptz);
-- drop function if exists public.preview_orphaned_message_rows(timestamptz);
-- drop table if exists public.candidate_erasures;
-- drop function if exists public.stamp_orphaned_at();
-- alter table public.communication_logs    drop column if exists orphaned_at;
-- alter table public.notifications_company drop column if exists orphaned_at;
-- drop function if exists public.sweep_not_covered();
-- drop function if exists public.sweepable_notification_types();
-- drop function if exists public.erased_address();
-- commit;
