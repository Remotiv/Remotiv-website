-- ============================================================================
-- Migration 059 - communication_logs: the first-attempt insert, the claim
--                 and the observed-state transitions, judged on the
--                 database clock (#85)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor: one paste, one
-- execution, one transaction. Staging first, with the rehearsal at the end of
-- this file; production only after it passes. Nothing in the repository
-- executes it.
--
-- APPLIED TO STAGING:
-- APPLIED TO PRODUCTION:
-- Fill each in when it happens: date, by whom. Between the two dates staging
-- has both functions and production has neither, a new, known
-- staging-versus-production difference (#68). Record it in #68 when staging is
-- applied, and close it there when production is.
--
-- AFTER PRODUCTION: one 059 object joins REQUIRED_OBJECTS in
-- scripts/staging/schema-dump.mjs, and the production dump is re-taken
-- (README-steps.md step 1). That file belongs to the staging session and this
-- file does not edit it. The object to pass on: the function
-- public.claim_communication_log(uuid, text, text, text), found by its
-- CREATE FUNCTION line in the dump, with the why "migration 059 creates it,
-- and 059 is the newest applied migration", which 058's entry claims today.
--
-- PRODUCTION SCHEMA, read by Waleed on 13 Nov 2026, plus migration 058
-- (applied 14 Nov 2026), which this file rests on:
--
--   communication_logs.attempt_started_at  timestamptz, NULLABLE, no default (058)
--   communication_logs.created_at          timestamptz default now()
--   communication_logs.status              text default 'queued'
--   communication_logs.scheduled_for       timestamptz, NULLABLE
--   communication_logs.sent_by_name        text, NULLABLE
--   communication_logs.error               text, NULLABLE
--   communication_logs_auto_event_uniq
--     UNIQUE INDEX on (application_id, event, channel) WHERE sent_by_name IS NULL
--
-- ── Why ──────────────────────────────────────────────────────
--
-- #85 lets a retry adopt the row a dead or failed attempt left behind. Every
-- decision about that row is a time comparison: is the attempt older than 15
-- minutes, was the message first attempted more than 24 hours ago. A
-- PostgREST filter can only compare a column with a value the worker sends,
-- so through PostgREST every cutoff would come from the worker's own clock:
--   - a worker 20 minutes FAST computes a cutoff 20 minutes late, sees a claim
--     made a minute ago as dead, claims it again, and the message goes twice;
--   - a worker 20 minutes fast also ends a failed row as "past 24 hours" while
--     it is still inside them, and that message is never retried.
-- A timestamp trigger alone fixes the stamp, not the cutoff. So both the claim
-- and the transitions run here, with every comparison against the database
-- clock, inside the one statement that writes. No function below takes a time
-- argument except the observed stamp, which is compared only for identity.
--
-- ── What the app does with the answers ───────────────────────
--
-- claim_communication_log returns one row: (out_id, out_attempt_started_at,
-- out_outcome). The worker never compares times itself.
--   claimed       it owns the row: send, and guard every later failure write
--                 on out_attempt_started_at, kept as the exact string
--                 (3a REQUIREMENT 1, section 2)
--   too_fresh     yield (E2)
--   too_old       failed row: terminal E1, NO write to the row, so it keeps
--                 its original error. Queued row: the E1 transition below
--   unclocked     the E10 transition below
--   scheduled     queued row: the E9 transition below; then terminal E9
--   wrong_status  re-read once, follow the decision list from step 3
--   missing       E4 at a conflict; a first attempt at the pre-check
--
-- fail_observed_communication_log returns one row: (out_id, out_outcome).
--   failed        written
--   changed       the row moved on since it was read: re-read once, follow
--                 the decision list
--   not_due       unchanged, but the database says the rule is not met: YIELD.
--                 A refused E1 or E10 never ends the job early
--   bad_rule      p_rule is not E1, E5, E9 or E10, or is NULL. Nothing was
--                 written. A PROGRAMMING ERROR, not a row state: the worker
--                 raises with the fixed safe sentence pattern and does NOT
--                 yield, because a yield would retry the same wrong rule on
--                 every run, for ever, with no error and no alert. Checked
--                 before changed and not_due. The app test belongs to 3a
--   missing       E4
--
-- insert_first_attempt_communication_log returns one row: (out_id,
-- out_attempt_started_at). It is the pre-send insert of an AUTOMATIC first
-- attempt, the one write that used to need a stamp from the worker. A
-- unique-index conflict is NOT caught: it raises 23505 exactly as the
-- PostgREST insert did, so 3a's existing conflict path is unchanged.
-- Recruiter sends (sent_by_name set) and skipped rows keep their plain
-- inserts: nothing claims them, so they need no stamp.
--
-- With this, nothing in 3a sends a time to the database. Stamps are written
-- only by now() inside this file's functions; the worker only ever sends back
-- a stamp the database returned, compared for identity.
--
-- Owned failure writes (email not-configured, email provider failure, the one
-- WhatsApp failure write) do not come here. They compare id, status queued and
-- the worker's own returned stamp by equality through PostgREST: no clock, and
-- that stamp is never NULL. Success writes are unchanged, by id.
--
-- ── Before running ───────────────────────────────────────────
--
-- All three functions absent:
-- select count(*) as functions_present
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('insert_first_attempt_communication_log',
--                      'claim_communication_log', 'fail_observed_communication_log');  -- 0
--
-- The legacy rows this file sends to E10 on the first run after the 3a deploy
-- (unclocked, automatic, unscheduled, older than 15 minutes). Count only;
-- report the number before approving the deploy:
-- select count(*) from public.communication_logs
--  where status = 'queued'
--    and attempt_started_at is null
--    and sent_by_name is null
--    and scheduled_for is null
--    and created_at <= now() - interval '15 minutes';
-- ============================================================================

begin;

-- CREATE FUNCTION takes no lock on communication_logs; this is here for the
-- same reason as in 057 and 058, so a stuck catalog lock fails fast and the
-- whole file rolls back rather than queueing.
set local lock_timeout = '5s';

-- ── 1. The claim ─────────────────────────────────────────────
--
-- ONE STATEMENT, so every now() below is the same instant. now() is
-- TRANSACTION START, not wall clock. That is fine at a 15-minute bound. Do not
-- swap it for clock_timestamp() without a reason.
--
-- target is at most one row: its filter is exactly the key and predicate of
-- communication_logs_auto_event_uniq, (application_id, event, channel) WHERE
-- sent_by_name IS NULL. So no LIMIT and no ORDER BY.
--
-- claimed is a data-modifying CTE. Postgres executes it exactly once and to
-- completion, however many times the query below references it (the first
-- branch and two NOT EXISTS), so the UPDATE runs once.
--
-- target is read from the statement's snapshot, before the UPDATE. If another
-- worker claimed the row first, the UPDATE waits for it, re-checks its
-- predicate against the winner's committed row, and matches nothing; target
-- still shows the old row, so the outcome reads too_fresh when the truth is
-- "someone else has it". Both mean YIELD, so this is safe. The outcome is
-- AUTHORITATIVE for the time cases and ADVISORY for the concurrent one.
--
-- The CASE order matters:
--   wrong_status  first: the caller asked for a status the row is not in
--   scheduled     never claimed (E9)
--   unclocked     BEFORE too_old: a queued row with no stamp is the E10 story
--                 at any age. Checked after too_old, a 25-hour-old legacy row
--                 would be written E1, "first attempted more than 24 hours
--                 ago", about an attempt that was never timed. unclocked fires
--                 only for status queued: a FAILED row with a NULL stamp is
--                 legitimately claimable, because the failed branch has no
--                 stamp condition
--   too_old       past 24 hours
--   too_fresh     everything else
--
-- error = null: a claimed failed row is about to be retried, and success
-- writes are unchanged, so without this a retry that succeeds would leave a
-- sent row carrying its old failure text. A row refused as too_old is not
-- written at all and keeps its original error.
--
-- subject, body and to_address are NOT in the SET: email resends the stored
-- message.
--
-- Output columns are out_*, and every reference in the body is qualified, so
-- no bare name can resolve to an output column.

create or replace function public.claim_communication_log(
  p_application_id uuid, p_event text, p_channel text, p_from_status text)
returns table (out_id uuid, out_attempt_started_at timestamptz, out_outcome text)
language sql
volatile
set search_path = public
as $$
  with target as (
    select l.id, l.status, l.created_at, l.attempt_started_at, l.scheduled_for
      from public.communication_logs l
     where l.application_id = p_application_id
       and l.event = p_event
       and l.channel = p_channel
       and l.sent_by_name is null
  ),
  claimed as (
    update public.communication_logs l
       set status = 'queued',
           attempt_started_at = now(),
           error = null
     where l.id = (select t.id from target t)
       and l.scheduled_for is null
       and l.created_at > now() - interval '24 hours'
       and ((p_from_status = 'failed' and l.status = 'failed')
         or (p_from_status = 'queued' and l.status = 'queued'
             and l.attempt_started_at < now() - interval '15 minutes'))
    returning l.id, l.attempt_started_at
  )
  select c.id, c.attempt_started_at, 'claimed'::text
    from claimed c
  union all
  select t.id, t.attempt_started_at,
         case
           when t.status is distinct from p_from_status                  then 'wrong_status'
           when t.scheduled_for is not null                               then 'scheduled'
           when t.status = 'queued' and t.attempt_started_at is null      then 'unclocked'
           when t.created_at <= now() - interval '24 hours'               then 'too_old'
           else 'too_fresh'
         end
    from target t
   where not exists (select 1 from claimed)
  union all
  select null::uuid, null::timestamptz, 'missing'::text
   where not exists (select 1 from target);
$$;

-- ── 2. The observed-state transitions: E1, E5, E9, E10 ───────
--
-- The worker owns no stamp here, so the guard is the state it OBSERVED: status
-- queued and the stamp it read. IS NOT DISTINCT FROM matches a NULL stamp.
-- Through PostgREST, .eq("attempt_started_at", null) can never match, because
-- equality with NULL is never true, and a filter that matches nothing does not
-- error. Doing the comparison here closes that trap in one place; E10's case
-- is exactly a row whose stamp was observed as NULL.
--
-- Same one-statement shape as the claim, and for the same reason: a zero-row
-- result says why. The data-modifying CTE runs exactly once.
--
-- 3a REQUIREMENT 1, BINDING: THE STAMP IS AN OPAQUE STRING.
--   PostgREST returns attempt_started_at as a string with MICROSECOND
--   precision. Carrying that string through JSON is safe. Turning it into a
--   JavaScript Date is NOT: a Date keeps only milliseconds, so a stamp that
--   has been through one no longer equals the stored value. Every guard that
--   compares the stamp (IS NOT DISTINCT FROM here, equality in the owned
--   failure writes) then matches nothing, and every guarded write silently
--   does nothing. No error, ever. It is the same class as the .eq(null) trap,
--   and the whole claim design rests on stamp identity.
--   The rule: 3a keeps the exact string it was given and passes that string
--   straight back. It never constructs a Date from it, never calls
--   toISOString on it, and never formats, truncates or regenerates it. An age
--   needed for logging is derived separately and never sent to the database.
--   It covers BOTH sources of a stamp:
--     a. out_attempt_started_at returned by the claim (and by the
--        first-attempt insert), used in the owned failure writes;
--     b. attempt_started_at read off a row by an ordinary .select() and passed
--        here as p_observed_stamp for E1, E5, E9 and E10. This is the easy one
--        to miss: it arrives as a field on a normal row object, exactly where
--        new Date(row.attempt_started_at) gets written without thinking.
--   3a's tests must carry, for EACH source, a stamp with non-zero
--   microseconds (e.g. ...:05.123456+00:00) and assert the guarded write still
--   matches. Negative control: route the stamp through a Date and the test
--   must fail.
--
-- scheduled_for IS NULL on E1, E5 and E10, and IS NOT NULL on E9, is DEFENCE
-- IN DEPTH, not a fix. On 14 Nov 2026 no code in src/ or scripts/ writes
-- scheduled_for at all, at insert or on update (every reference is a read, in
-- messages/actions.ts), so a row cannot become scheduled between the read and
-- this write today. The guard keeps that true if a writer is ever added.
--
-- p_rule comes from a closed type in the app, but the database does not rely
-- on that. An unknown rule still writes nothing: the update's CASE ends in
-- "else false". The output then says bad_rule, tested FIRST, before changed
-- and not_due. Without it an unknown rule read as not_due, not_due means
-- yield, and a misspelled rule yielded on every run, for ever, silently.
-- "p_rule is null or" is there because NOT IN with a NULL is NULL, not true:
-- without it a NULL rule would fall through to not_due, the same trap.
--
-- target is a pre-update snapshot here too, as in the claim. A row changed
-- concurrently after the snapshot (the UPDATE waits, re-checks its predicate
-- against the committed row and matches nothing) reports not_due where the
-- truth is changed. Both are non-destructive and both retry, so it is safe.

create or replace function public.fail_observed_communication_log(
  p_id uuid, p_observed_stamp timestamptz, p_rule text, p_error text)
returns table (out_id uuid, out_outcome text)
language sql
volatile
set search_path = public
as $$
  with target as (
    select l.id, l.status, l.attempt_started_at
      from public.communication_logs l
     where l.id = p_id
  ),
  failed as (
    update public.communication_logs l
       set status = 'failed',
           error = p_error
     where l.id = p_id
       and l.status = 'queued'
       and l.attempt_started_at is not distinct from p_observed_stamp
       and case p_rule
             when 'E1'  then l.scheduled_for is null
                         and l.created_at <= now() - interval '24 hours'
             when 'E10' then l.scheduled_for is null
                         and l.attempt_started_at is null
                         and l.created_at <= now() - interval '15 minutes'
             when 'E5'  then l.scheduled_for is null
             when 'E9'  then l.scheduled_for is not null
             else false
           end
    returning l.id
  )
  select f.id, 'failed'::text
    from failed f
  union all
  select t.id,
         case
           when p_rule is null
             or p_rule not in ('E1', 'E5', 'E9', 'E10')                then 'bad_rule'
           when t.status <> 'queued'
             or t.attempt_started_at is distinct from p_observed_stamp then 'changed'
           else 'not_due'
         end
    from target t
   where not exists (select 1 from failed)
  union all
  select p_id, 'missing'::text
   where not exists (select 1 from target);
$$;

-- ── 3. The first-attempt insert ──────────────────────────────
--
-- The narrowest insert that can carry the stamp. attempt_started_at is set to
-- now() HERE and is not a parameter, so no caller can supply it, and no
-- parameter of this function is a date or time type at all. status is fixed
-- 'queued', sent_by_name fixed NULL (an automatic send, inside the partial
-- unique index), error NULL, sent_at and scheduled_for unset. created_at
-- takes its default, now(), the same instant: the stamp of a first attempt
-- and its creation are one moment.
--
-- No ON CONFLICT. A second automatic row for the same (application, event,
-- channel) must raise 23505 from communication_logs_auto_event_uniq, exactly
-- as the PostgREST insert raised it, so the caller's conflict path does not
-- change.
--
-- body is stored as given. The caller redacts it first, as today: the redactor
-- is app code, and every write to body goes through it.

create or replace function public.insert_first_attempt_communication_log(
  p_company_id uuid, p_application_id uuid, p_event text, p_channel text,
  p_to_address text, p_subject text, p_body text)
returns table (out_id uuid, out_attempt_started_at timestamptz)
language sql
volatile
set search_path = public
as $$
  insert into public.communication_logs as l
    (company_id, application_id, event, channel, to_address, subject, body,
     status, error, sent_by_name, attempt_started_at)
  values
    (p_company_id, p_application_id, p_event, p_channel, p_to_address, p_subject, p_body,
     'queued', null, null, now())
  returning l.id, l.attempt_started_at;
$$;

-- ── 4. Service role only ─────────────────────────────────────
--
-- A new function is executable by PUBLIC by default, which PostgREST would
-- expose to anon and authenticated callers. Revoke first, then grant. Every
-- caller in the app uses the service-role client (#85 pre-flight, 14 Nov:
-- email/candidate/dispatch.ts:48, whatsapp/dispatch.ts:116, and every other
-- deliverEmail caller builds createServiceClient itself).

revoke execute on function public.claim_communication_log(uuid, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.fail_observed_communication_log(uuid, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_communication_log(uuid, text, text, text)
  to service_role;
grant execute on function public.fail_observed_communication_log(uuid, timestamptz, text, text)
  to service_role;
revoke execute on function public.insert_first_attempt_communication_log(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.insert_first_attempt_communication_log(uuid, uuid, text, text, text, text, text)
  to service_role;

-- ── 5. THE INVARIANT, asserted before commit ─────────────────
--
-- All three functions exist and are SECURITY INVOKER, neither anon nor
-- authenticated can execute any of them (six checks), service_role can
-- execute all three, and
-- attempt_started_at still has NO default (#85 decided against one: a default
-- stamps rows where no attempt started, and turns a safe E10 stop into a
-- resend).

do $$
declare
  n_functions bigint;
  n_bad_grants bigint;
  n_service_grants bigint;
  found_default text;
begin
  select count(*) into n_functions
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('insert_first_attempt_communication_log',
                       'claim_communication_log', 'fail_observed_communication_log')
     and not p.prosecdef;
  select count(*) into n_bad_grants
    from (values ('anon'), ('authenticated')) r(role_name),
         (values ('public.insert_first_attempt_communication_log(uuid, uuid, text, text, text, text, text)'),
                 ('public.claim_communication_log(uuid, text, text, text)'),
                 ('public.fail_observed_communication_log(uuid, timestamptz, text, text)')) f(sig)
   where has_function_privilege(r.role_name, f.sig, 'execute');
  select count(*) into n_service_grants
    from (values ('public.insert_first_attempt_communication_log(uuid, uuid, text, text, text, text, text)'),
                 ('public.claim_communication_log(uuid, text, text, text)'),
                 ('public.fail_observed_communication_log(uuid, timestamptz, text, text)')) f(sig)
   where has_function_privilege('service_role', f.sig, 'execute');
  select column_default into found_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'communication_logs'
     and column_name = 'attempt_started_at';
  if n_functions <> 3 or n_bad_grants <> 0 or n_service_grants <> 3
     or found_default is not null then
    raise exception 'migration 059: expected 3 invoker functions, 0 anon or authenticated grants, 3 service_role grants and no default on attempt_started_at; found % functions, % bad grants, % service grants, default %; rolled back',
      n_functions, n_bad_grants, n_service_grants, coalesce(found_default, 'none');
  end if;
end;
$$;

commit;

-- ── After running: the functions and the grants ──────────────
--
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args,
--        p.prosecdef as security_definer
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('insert_first_attempt_communication_log',
--                      'claim_communication_log', 'fail_observed_communication_log')
--  order by 1;
--      -- claim_communication_log (uuid, text, text, text) f
--      -- fail_observed_communication_log (uuid, timestamp with time zone, text, text) f
--      -- insert_first_attempt_communication_log (uuid, uuid, text, text, text, text, text) f
-- select r.role_name,
--        has_function_privilege(r.role_name, 'public.claim_communication_log(uuid, text, text, text)', 'execute') as claim,
--        has_function_privilege(r.role_name, 'public.fail_observed_communication_log(uuid, timestamptz, text, text)', 'execute') as fail,
--        has_function_privilege(r.role_name, 'public.insert_first_attempt_communication_log(uuid, uuid, text, text, text, text, text)', 'execute') as insert
--   from (values ('anon'), ('authenticated'), ('service_role')) r(role_name);
--      -- anon f f f; authenticated f f f; service_role t t t
-- select column_default from information_schema.columns
--  where table_schema = 'public' and table_name = 'communication_logs'
--    and column_name = 'attempt_started_at';                           -- NULL
--
-- ── Staging rehearsal, before production ─────────────────────
--
-- The app's tests run against a fake that applies database time. They prove
-- the app's decisions, not this SQL. This rehearsal proves the SQL compiles
-- and behaves on a real database. It is a hand sequence for Waleed on the
-- STAGING project (.env.staging), DUMMY data only: every fixture hangs off one
-- seeded staging application, uses a channel beginning 'rh059-' and the
-- address 'rehearsal@example.invalid', which no real row uses.
--
-- Every SQL block below is commented out so that pasting this whole file runs
-- only the migration. To run a block, select its lines between its BEGIN and
-- END markers (not the markers), paste into the SQL editor and press Cmd+/ to
-- uncomment.
--
-- Two parts, because one pattern does not fit both:
--   PART A  the outcome cases: one transaction that always rolls back.
--           Nothing to clean up
--   PART B  the race: two sessions, one commits. A real row, explicit delete
-- B is the only part that leaves residue if abandoned half way. B6 and B7
-- recover it.
--
-- There is no PostgREST round trip. The stamp of a first attempt is written by
-- insert_first_attempt_communication_log, inside the database, so nothing in
-- 3a depends on how PostgREST converts the string "now", and proving it would
-- have needed a staging write outside the guard's seed-only convention.
--
-- The order on staging:
--
-- 0. SCHEMA COMPARISON FIRST, on both databases, before 059 is applied to
--    either. Staging is not a copy of production (#68). They must match on
--    communication_logs; if they differ, the rehearsal proves nothing about
--    production, so STOP and reconcile.
--
--    select 'col' as kind, column_name as name,
--           data_type || ', ' || case is_nullable when 'YES' then 'null' else 'not null' end
--             || ', default ' || coalesce(column_default, 'none') as detail
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'communication_logs'
--    union all
--    select 'idx', indexname, indexdef from pg_indexes
--     where schemaname = 'public' and tablename = 'communication_logs'
--    union all
--    select 'con', conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.communication_logs'::regclass
--    union all
--    select 'trg', tgname, pg_get_triggerdef(oid) from pg_trigger
--     where tgrelid = 'public.communication_logs'::regclass and not tgisinternal
--    order by 1, 2;
--
--    Expect on both: attempt_started_at timestamptz, null, default none;
--    created_at timestamptz, not null, default now() (Part A's created_at
--    case relies on it); channel text, no CHECK (the fixtures' 'rh059-'
--    channels rely on that); the event CHECK allowing 'application_received';
--    the partial unique index communication_logs_auto_event_uniq; one
--    trigger, communication_logs_orphaned_at, BEFORE UPDATE OF application_id
--    only, so nothing rewrites created_at or the stamp on insert.
--
-- 1. APPLY 059 on staging: this file, one paste. Expect "Success. No rows
--    returned". If section 5's block raises, nothing was applied; read its
--    message.
--
-- 2. POST-CHECK on staging, the "After running" queries above.
--
-- 3. PART A. Below.
--
-- 4. PART B. Below.
--
-- 5. THE GRANTS, three runs in one tab, each on its own. Nothing is written.
--      begin; set local role authenticated;
--      select * from public.claim_communication_log(gen_random_uuid(), 'application_received', 'rh059-grant', 'failed');
--      rollback;
--    Expect: permission denied for function claim_communication_log.
--      begin; set local role authenticated;
--      select * from public.fail_observed_communication_log(gen_random_uuid(), null, 'E5', 'rehearsal');
--      rollback;
--    Expect: permission denied for function fail_observed_communication_log.
--      begin; set local role authenticated;
--      select * from public.insert_first_attempt_communication_log(gen_random_uuid(), gen_random_uuid(), 'application_received', 'rh059-grant', 'rehearsal@example.invalid', null, null);
--      rollback;
--    Expect: permission denied for function insert_first_attempt_communication_log.
--
-- 6. Fill in APPLIED TO STAGING at the top of this file, and record the new
--    staging-versus-production difference in #68.
--
-- ── PART A. The outcome cases, one transaction, always rolled back ──
--
-- Why one rolled-back transaction works: now() is TRANSACTION START, so it is
-- one constant instant across the whole block, in the fixtures and inside both
-- functions alike. A fixture inserted at now() - interval '25 hours' is
-- exactly 25 hours old to the functions' own comparisons. Nothing drifts
-- between an insert and a call, and no wall clock is read. That is why every
-- age below is an offset from now(), never a literal timestamp, and why the
-- stamp a claim writes is expected to be exactly now(), an age of 0.
--
-- The fixtures and every write live in an inner block whose only exit is an
-- exception, so they ALWAYS roll back: on PASS, on FAIL and on an error part
-- way. Only the temp table of results survives. So there is no cleanup step,
-- because a cleanup after a failure may never run. The pattern is
-- scripts/backfills/054-proof-P1.sql. The refusal at the top is the staging
-- guard's own premise (scripts/staging/guard-db-checks.mjs): production has
-- no staging_guard schema, so on production the block writes nothing.
--
-- The 27 cases. The 16 from before (a to p), seven on the first-attempt
-- insert (u to aa), plus four: q, the scheduled row
-- going on to E9; r, a misspelled rule on an unchanged row, which before the
-- bad_rule fix read as not_due and yielded for ever; s, a NULL rule on a
-- changed row, which proves bad_rule is tested before changed and closes the
-- NOT IN NULL trap; t, a transition on a row that does not exist.
--
--   a  failed, 1h, error 'old failure', claim from failed  -> claimed; queued, stamp now(), error NULL
--   b  failed, 25h, error 'old failure'                    -> too_old; untouched, error 'old failure'
--   c  failed, 23h45m, error 'old failure'                 -> claimed, NOT too_old; error NULL
--   d  queued, stamp 2 min, from queued                    -> too_fresh; untouched
--   e  queued, stamp 20 min                                -> claimed; stamp now(), later than before
--   f  queued, NULL stamp, 5 min old                       -> unclocked; untouched
--   g  queued, NULL stamp, 25h old                         -> unclocked, NOT too_old; untouched
--   h  queued, scheduled tomorrow, NULL stamp              -> scheduled; untouched
--   i  sent, claim from failed                             -> wrong_status; untouched
--   j  no row                                              -> missing, one row
--   k  g's row, observed NULL, E10                         -> failed, error 'rehearsal' (25h end written)
--   l  f's row, observed NULL, E10                         -> not_due; untouched (5 min end refused)
--   m  queued, 25h, observed its stamp, E1                 -> failed
--   n  queued, 23h, observed its stamp, E1                 -> not_due; untouched
--   o  queued, observed a DIFFERENT stamp, E5              -> changed; untouched
--   p  cancelled, observed its stamp, E1                   -> changed; stays cancelled
--   q  h's row, observed NULL, E9                          -> failed
--   r  queued, observed its stamp, rule 'e5'               -> bad_rule; untouched
--   s  p's row, observed its stamp, rule NULL              -> bad_rule, not changed; untouched
--   t  no row, E5                                          -> missing
--   u  first-attempt insert                                -> returned stamp NOT NULL
--   v  the same call                                       -> returned stamp = stored attempt_started_at
--   w  the same call                                       -> returned stamp = now(), the transaction's
--                                                             instant: the proof the DATABASE made it,
--                                                             since a caller-supplied stamp could not
--                                                             equal a value it never saw
--   x  the same call                                       -> created_at = the stamp (created_at's
--                                                             default is now(), read from the 14 Nov
--                                                             production dump; step 0 checks staging)
--   y  the function's signature                            -> exactly one overload, no date or time
--                                                             argument of any kind
--   z  a second call, same key                             -> raises 23505
--   aa after z                                             -> still exactly one row for that key, the
--                                                             first one
--
-- NOT A CASE, ON PURPOSE: two inserts in Part A producing DIFFERENT stamps.
-- That is impossible here and must not be added. now() is transaction start,
-- one fixed instant for the whole block; it is the same property that makes
-- every age offset above exact. Freshness ACROSS transactions is proven by
-- Part B: the claim stamps now() inside a real committed transaction, and B4
-- reads that stamp back.
--
-- PASS: 28 rows. Row 0 is TOTAL with outcome PASS and "27 of 27". A STOPPED
-- row, a FAIL, or a TOTAL short of 20 is not a pass. Each detail is what the
-- call returned, then the row after it as (status, stamp age, error).
--
-- PART A BEGIN
-- drop table if exists pg_temp.p_result;
-- create temp table p_result(ord int, rehearsal_case text, outcome text, detail text);
-- do $$
-- declare
--   v_app uuid;
--   v_co uuid;
--   v_id uuid;
--   v_outs text[];
--   v_stamp timestamptz;
--   ok boolean;
--   c record;
--   l public.communication_logs;
--   cases text[] := '{}';
--   oks boolean[] := '{}';
--   details text[] := '{}';
--   v_state text;
--   n bigint;
-- begin
--   begin
--     if to_regclass('staging_guard.sentinel') is null then
--       raise exception using errcode = 'P0060',
--         message = 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was written';
--     end if;
--     select a.id, a.company_id_snapshot into v_app, v_co
--       from public.job_applications a
--      where a.company_id_snapshot is not null
--      limit 1;
--     if v_app is null then
--       raise exception using errcode = 'P0060',
--         message = 'NOFIXTURE: no job_applications row with a company to own the fixtures';
--     end if;
--
--     -- One fixture per slot, keyed by channel. Ages are offsets from now(); a
--     -- NULL offset is a NULL column.
--     insert into public.communication_logs
--       (company_id, application_id, event, channel, to_address, status,
--        created_at, attempt_started_at, scheduled_for, error)
--     select v_co, v_app, 'application_received', 'rh059-' || f.slot,
--            'rehearsal@example.invalid', f.status,
--            now() - f.age, now() - f.stamp_age, now() + f.scheduled_in, f.err
--       from (values
--         ('a', 'failed',    interval '1 hour',              null::interval,                 null::interval,   'old failure'),
--         ('b', 'failed',    interval '25 hours',            null,                           null,             'old failure'),
--         ('c', 'failed',    interval '23 hours 45 minutes', interval '23 hours 44 minutes', null,             'old failure'),
--         ('d', 'queued',    interval '1 hour',              interval '2 minutes',           null,             null),
--         ('e', 'queued',    interval '1 hour',              interval '20 minutes',          null,             null),
--         ('f', 'queued',    interval '5 minutes',           null,                           null,             null),
--         ('g', 'queued',    interval '25 hours',            null,                           null,             null),
--         ('h', 'queued',    interval '1 hour',              null,                           interval '1 day', null),
--         ('i', 'sent',      interval '1 hour',              interval '1 hour',              null,             null),
--         ('m', 'queued',    interval '25 hours',            interval '2 minutes',           null,             null),
--         ('n', 'queued',    interval '23 hours',            interval '20 minutes',          null,             null),
--         ('o', 'queued',    interval '1 hour',              interval '20 minutes',          null,             null),
--         ('p', 'cancelled', interval '1 hour',              interval '1 hour',              null,             null),
--         ('r', 'queued',    interval '1 hour',              interval '20 minutes',          null,             null)
--       ) f(slot, status, age, stamp_age, scheduled_in, err);
--
--     -- The cases, in order: k, l and q act on rows a claim case read first.
--     -- arg is the claim's from-status or the transition's rule. observed_age
--     -- is the stamp the worker observed, as an age; NULL is an observed NULL.
--     -- The want_* columns are the row AFTER the call; stamp age 0 is now().
--     for c in
--       select * from (values
--         ( 1, 'a', 'claim', 'a', 'failed', null::interval,       'claimed',      'queued',    interval '0',          null::text),
--         ( 2, 'b', 'claim', 'b', 'failed', null,                 'too_old',      'failed',    null,                  'old failure'),
--         ( 3, 'c', 'claim', 'c', 'failed', null,                 'claimed',      'queued',    interval '0',          null),
--         ( 4, 'd', 'claim', 'd', 'queued', null,                 'too_fresh',    'queued',    interval '2 minutes',  null),
--         ( 5, 'e', 'claim', 'e', 'queued', null,                 'claimed',      'queued',    interval '0',          null),
--         ( 6, 'f', 'claim', 'f', 'queued', null,                 'unclocked',    'queued',    null,                  null),
--         ( 7, 'g', 'claim', 'g', 'queued', null,                 'unclocked',    'queued',    null,                  null),
--         ( 8, 'h', 'claim', 'h', 'queued', null,                 'scheduled',    'queued',    null,                  null),
--         ( 9, 'i', 'claim', 'i', 'failed', null,                 'wrong_status', 'sent',      interval '1 hour',     null),
--         (10, 'j', 'claim', 'j', 'failed', null,                 'missing',      null,        null,                  null),
--         (11, 'k', 'fail',  'g', 'E10',    null,                 'failed',       'failed',    null,                  'rehearsal'),
--         (12, 'l', 'fail',  'f', 'E10',    null,                 'not_due',      'queued',    null,                  null),
--         (13, 'm', 'fail',  'm', 'E1',     interval '2 minutes', 'failed',       'failed',    interval '2 minutes',  'rehearsal'),
--         (14, 'n', 'fail',  'n', 'E1',     interval '20 minutes','not_due',      'queued',    interval '20 minutes', null),
--         (15, 'o', 'fail',  'o', 'E5',     interval '21 minutes','changed',      'queued',    interval '20 minutes', null),
--         (16, 'p', 'fail',  'p', 'E1',     interval '1 hour',    'changed',      'cancelled', interval '1 hour',     null),
--         (17, 'q', 'fail',  'h', 'E9',     null,                 'failed',       'failed',    null,                  'rehearsal'),
--         (18, 'r', 'fail',  'r', 'e5',     interval '20 minutes','bad_rule',     'queued',    interval '20 minutes', null),
--         (19, 's', 'fail',  'p', null,     interval '1 hour',    'bad_rule',     'cancelled', interval '1 hour',     null),
--         (20, 't', 'fail',  't', 'E5',     null,                 'missing',      null,        null,                  null)
--       ) v(ord, rehearsal_case, fn, slot, arg, observed_age,
--           want_outcome, want_status, want_stamp_age, want_error)
--       order by ord
--     loop
--       v_id := null;
--       select x.id into v_id from public.communication_logs x
--        where x.application_id = v_app and x.channel = 'rh059-' || c.slot;
--       v_stamp := null;
--       if c.fn = 'claim' then
--         select array_agg(r.out_outcome), max(r.out_attempt_started_at) into v_outs, v_stamp
--           from public.claim_communication_log(
--                  v_app, 'application_received', 'rh059-' || c.slot, c.arg) r;
--       else
--         select array_agg(r.out_outcome) into v_outs
--           from public.fail_observed_communication_log(
--                  coalesce(v_id, gen_random_uuid()), now() - c.observed_age, c.arg, 'rehearsal') r;
--       end if;
--       l := null;
--       select * into l from public.communication_logs x where x.id = v_id;
--       ok := v_outs = array[c.want_outcome]
--             and l.status is not distinct from c.want_status
--             and (now() - l.attempt_started_at) is not distinct from c.want_stamp_age
--             and l.error is not distinct from c.want_error
--             and (c.want_outcome <> 'claimed' or v_stamp = l.attempt_started_at);
--       cases := array_append(cases, c.rehearsal_case);
--       oks := array_append(oks, ok);
--       details := array_append(details, coalesce(v_outs::text, '{}') || ' '
--         || row(l.status, now() - l.attempt_started_at, l.error)::text);
--     end loop;
--
--     -- The first-attempt insert, u to aa. channel 'rh059-ins' has no fixture.
--     v_id := null;
--     v_stamp := null;
--     select r.out_id, r.out_attempt_started_at into v_id, v_stamp
--       from public.insert_first_attempt_communication_log(
--              v_co, v_app, 'application_received', 'rh059-ins',
--              'rehearsal@example.invalid', 'first', 'first') r;
--     l := null;
--     select * into l from public.communication_logs x where x.id = v_id;
--     cases := cases || array['u', 'v', 'w', 'x'];
--     oks := oks || array[v_stamp is not null,
--                         v_stamp = l.attempt_started_at,
--                         v_stamp = now(),
--                         l.created_at = v_stamp];
--     details := details || array[
--       format('returned stamp %s', coalesce((now() - v_stamp)::text || ' ago', 'NULL')),
--       format('stored stamp %s', coalesce((now() - l.attempt_started_at)::text || ' ago', 'NULL')),
--       format('returned minus now() %s', coalesce((v_stamp - now())::text, 'NULL')),
--       format('created_at minus stamp %s', coalesce((l.created_at - v_stamp)::text, 'NULL'))];
--
--     select count(*) = 1
--            and not exists (
--              select 1
--                from pg_proc p
--                join pg_namespace pn on pn.oid = p.pronamespace
--               cross join lateral unnest(p.proargtypes::oid[]) a(t)
--                join pg_type ty on ty.oid = a.t
--               where pn.nspname = 'public'
--                 and p.proname = 'insert_first_attempt_communication_log'
--                 and ty.typcategory in ('D', 'T')),
--            string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
--       into ok, v_state
--       from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace
--      where pn.nspname = 'public' and p.proname = 'insert_first_attempt_communication_log';
--     cases := array_append(cases, 'y'); oks := array_append(oks, ok);
--     details := array_append(details, coalesce(v_state, 'no such function'));
--
--     v_state := 'no error';
--     begin
--       perform public.insert_first_attempt_communication_log(
--                 v_co, v_app, 'application_received', 'rh059-ins',
--                 'rehearsal@example.invalid', 'second', 'second');
--     exception when others then
--       v_state := sqlstate;
--     end;
--     cases := array_append(cases, 'z'); oks := array_append(oks, v_state = '23505');
--     details := array_append(details, 'second call: ' || v_state);
--
--     select count(*), min(x.subject) into n, v_state
--       from public.communication_logs x
--      where x.application_id = v_app and x.event = 'application_received'
--        and x.channel = 'rh059-ins' and x.sent_by_name is null;
--     cases := array_append(cases, 'aa'); oks := array_append(oks, n = 1 and v_state = 'first');
--     details := array_append(details, format('%s row(s) for the key, subject %s', n, coalesce(v_state, 'NULL')));
--
--     -- the only exit: rolls back every fixture and every write above
--     raise exception using errcode = 'P0059', message = 'rehearsal complete, rolled back';
--   exception
--     when sqlstate 'P0059' then
--       insert into p_result
--       select u.ord, u.rehearsal_case, case when u.ok then 'PASS' else 'FAIL' end, u.detail
--         from unnest(cases, oks, details) with ordinality u(rehearsal_case, ok, detail, ord);
--       insert into p_result
--       select 0, 'TOTAL',
--              case when count(*) = 27 and bool_and(outcome = 'PASS') then 'PASS' else 'FAIL' end,
--              format('%s of %s cases passed; expect 27 of 27',
--                     count(*) filter (where outcome = 'PASS'), count(*))
--         from p_result;
--     when others then
--       insert into p_result
--       select u.ord, u.rehearsal_case, case when u.ok then 'PASS' else 'FAIL' end, u.detail
--         from unnest(cases, oks, details) with ordinality u(rehearsal_case, ok, detail, ord);
--       insert into p_result values (99, 'STOPPED', 'FIXTURE ERROR', sqlstate || ' ' || sqlerrm);
--   end;
-- end $$;
-- select * from p_result order by ord;
-- PART A END
--
-- ── PART B. The race, two sessions, a real row ──────────────
--
-- It cannot use Part A's pattern. A race needs two sessions, and needs one of
-- them to COMMIT while the other waits on it. Part A is one session that
-- never commits, so it cannot stand in for either side. So this part writes
-- one real row and deletes it by id at the end (B5). If it is abandoned half
-- way, the row stays, and B6 and B7 recover it.
--
-- The SQL editor cannot be relied on to keep a transaction open from one run
-- of a tab to the next, so tab 1 holds the row inside ONE statement, with
-- pg_sleep, rather than a begin in one run and a commit in another.
--
-- Why B2's order is safe, settled, not to be re-argued: the claim is a
-- set-returning function in FROM. It is VOLATILE, so the planner never inlines
-- it, and a function scan runs the function to completion, UPDATE included,
-- before the target list of the first row is evaluated. So pg_sleep runs
-- strictly after the claim has written. The row lock the UPDATE took is held
-- until the transaction ends, and a single statement in the editor is its own
-- transaction, which ends after pg_sleep returns. So tab 1 holds the lock for
-- the full 20 seconds after claiming.
--
-- The guard on B2 and B3, without changing that order: <RACE_APP> comes from
-- a MATERIALIZED CTE g, which has a row only where staging_guard.sentinel
-- exists, and reaches the claim through a correlated LATERAL. The function's
-- argument comes FROM g, so the function scan can only be the inner side of a
-- nested loop with g outer, and a nested loop whose outer side is empty never
-- runs its inner side: off staging the claim is never executed and the
-- statement returns 0 rows at once. Inside the loop nothing changes: the
-- function scan still runs the claim to completion before the target list,
-- pg_sleep and clock_timestamp included, is evaluated. B2p shows the plan,
-- read-only, before anything runs.
--
-- B1. Tab 1, one run. Refuses unless staging, then inserts the fixture: a
--     failed row, 1 hour old, with an OLD stamp 50 minutes back, cut to the
--     whole second so it can be copied exactly. RECORD race_id as <RACE_ID>,
--     race_app as <RACE_APP> and old_stamp as <OLD_STAMP> before going on.
--     The insert carries the sentinel check in its own WHERE as well, so even
--     run on its own, off staging, it inserts and returns 0 rows.
--     It also picks only a seeded application: the staging seed gives every
--     one the email staging+N@example.invalid, so no other row can be used.
--     Part A's selector does NOT carry this filter, on purpose: it passed 27
--     of 27, it is guarded by the same sentinel, and every write it makes
--     rolls back, so changing it would mean re-running a proven artifact for
--     nothing.
-- PART B1 BEGIN
-- do $$
-- begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was written';
--   end if;
-- end $$;
-- insert into public.communication_logs
--   (company_id, application_id, event, channel, to_address, status,
--    created_at, attempt_started_at, error)
-- select a.company_id_snapshot, a.id, 'application_received', 'rh059-race',
--        'rehearsal@example.invalid', 'failed',
--        now() - interval '1 hour', date_trunc('second', now()) - interval '50 minutes',
--        'old failure'
--   from public.job_applications a
--  where a.company_id_snapshot is not null
--    and a.email like 'staging+%@example.invalid'
--    and to_regclass('staging_guard.sentinel') is not null
--  limit 1
-- returning id as race_id, application_id as race_app, attempt_started_at as old_stamp;
-- PART B1 END
--
-- B2a. Before B2, in BOTH tabs, one read:
--       show statement_timeout;
--     NORMAL PATH: 0 (no limit) or at least 30s. Then B2 and B3 run BARE,
--     exactly as written below, with no begin and no commit, and nothing
--     else in B2a or B3p applies.
--
--     FALLBACK, only if it is lower. B2 and B3 each run for up to 20
--     seconds, and a timed-out B2 rolls back its claim, so the race never
--     happens.
--     B2 on the fallback path, as ONE submission in tab 1:
--       begin; set local statement_timeout = '60s';
--       with g as materialized (
--         select '<RACE_APP>'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select c.out_id, c.out_attempt_started_at, c.out_outcome, pg_sleep(20)
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') c;
--       commit;
--     If the editor shows no rows for it, take <T1_STAMP> from B4's select.
--     B3 on the fallback path is different: its result IS the proof
--     (out_outcome, saw_old_stamp, waited) and is stored nowhere, and B4
--     cannot recover saw_old_stamp or waited. So B3 writes its row into a
--     temp table and reads it back at the end of the SAME submission, which
--     the editor then shows. ONLY if B3p returned exactly one row, as ONE
--     submission in tab 2:
--       drop table if exists pg_temp.b3_result;
--       begin; set local statement_timeout = '60s';
--       create temp table b3_result as
--       with g as materialized (
--         select '<RACE_APP>'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select r.out_id, r.out_attempt_started_at, r.out_outcome,
--              r.out_attempt_started_at = '<OLD_STAMP>' as saw_old_stamp,
--              clock_timestamp() - now() as waited
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') r;
--       commit;
--       select * from pg_temp.b3_result;
--     The read is qualified as pg_temp.b3_result for the same reason as
--     Part A's drop: if the temp table is not there, an unqualified name
--     could resolve to a real table through search_path. The drop first
--     lets the race be repeated in the same tab.
--     All five columns survive as they are. waited is still B3's own wait:
--     now() is the transaction's start, which is the begin a few
--     microseconds before the create, and clock_timestamp() is read after
--     the claim returns, so the only addition is the begin and set local,
--     microseconds. saw_old_stamp is unchanged: the select inside the create
--     takes its snapshot when it starts, exactly as the bare B3 does.
--     If B3p did NOT return exactly one row, do NOT use the temp table:
--     raise the timeout another way, or run B3 bare and accept the risk that
--     a timeout cancels it, and then reset (B4) and repeat.
--
-- B3p. TEMP TABLE PROBE, fallback path only, tab 2, ONE submission, BEFORE
--     the race. It settles whether a temp table made inside begin/commit can
--     still be read after the commit in the same submission. If the
--     connection is pooled per transaction, the read after commit can land on
--     a different backend and see nothing:
--       drop table if exists pg_temp.t_probe;
--       begin;
--       create temp table t_probe as select 1 as x;
--       commit;
--       select * from pg_temp.t_probe;
--     One row: the B3 fallback is safe to use. No rows or an error: it is
--     not; see the last paragraph of B2a.
--
-- B2p. PLAN CHECK, either tab, before B2. READ ONLY.
--     Plain EXPLAIN only. NEVER EXPLAIN ANALYZE: ANALYZE EXECUTES the
--     statement, which would run the claim, write the row and hold the lock
--     for 20 seconds. The zero uuid is a placeholder for planning only.
--     The guarded form, exactly as B2 runs it:
--       explain
--       with g as materialized (
--         select '00000000-0000-0000-0000-000000000000'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select c.out_id, c.out_attempt_started_at, c.out_outcome, pg_sleep(20)
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') c;
--     PASS: a Nested Loop whose FIRST child is "CTE Scan on g" and whose
--     SECOND child is "Function Scan on claim_communication_log c" (a Memoize
--     node above the Function Scan is fine), and "CTE g" with a One-Time
--     Filter on to_regclass. If the Function Scan is anywhere but the inner
--     side of that Nested Loop, STOP and report: B2 and B3 go back unguarded.
--     For comparison only, the same statement without "materialized":
--       explain
--       with g as (
--         select '00000000-0000-0000-0000-000000000000'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select c.out_id, c.out_attempt_started_at, c.out_outcome, pg_sleep(20)
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') c;
--     Expected: the CTE is inlined, so no Nested Loop and no CTE Scan; the
--     Function Scan sits alone under a Result whose One-Time Filter is the
--     to_regclass check. That gates it too, but through constant folding the
--     planner is free to do differently, which is why B2 uses the fence.
--
-- B2. Tab 1. Claims, holds the row lock for 20 seconds, then commits:
--       with g as materialized (
--         select '<RACE_APP>'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select c.out_id, c.out_attempt_started_at, c.out_outcome, pg_sleep(20)
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') c;
--     Expect, after 20 seconds: claimed. RECORD out_attempt_started_at as <T1_STAMP>.
--     0 rows at once means no sentinel here: the claim never ran.
--
-- B3. Tab 2, started IMMEDIATELY after B2, within its 20 seconds. Bare, on
--     the normal path; on the fallback path, use B2a's B3 form instead:
--       with g as materialized (
--         select '<RACE_APP>'::uuid as app
--          where to_regclass('staging_guard.sentinel') is not null
--       )
--       select r.out_id, r.out_attempt_started_at, r.out_outcome,
--              r.out_attempt_started_at = '<OLD_STAMP>' as saw_old_stamp,
--              clock_timestamp() - now() as waited
--         from g
--         cross join lateral public.claim_communication_log(
--           g.app, 'application_received', 'rh059-race', 'failed') r;
--     now() is this statement's start and clock_timestamp() is read after the
--     claim returns, so waited is how long it sat behind tab 1's lock.
--     PASS needs ALL THREE:
--       out_outcome   too_fresh, never claimed;
--       saw_old_stamp true: out_attempt_started_at is <OLD_STAMP>, NOT
--                     <T1_STAMP>. Its snapshot was taken before tab 1
--                     committed. This is the STRONGER discriminator: it does
--                     not depend on wall-clock timing;
--       waited        clearly not instant, close to 20 seconds less the delay
--                     before B3 was started, and never under 2 seconds.
--     A session that arrived after tab 1 committed would wait about 0 seconds
--     and see <T1_STAMP>. That is a late arrival, not a race: it proves
--     nothing, even with a plausible outcome. Reset (B4) and repeat B2, B3.
--     If B3 returns claimed, STOP and report it.
--
-- B4. Either tab:
--       select status, attempt_started_at = '<T1_STAMP>' as tab1_stamp, error
--         from public.communication_logs where id = '<RACE_ID>';
--     Expect: queued, true, NULL. Exactly one claim landed.
--     To repeat the race, reset the row first. Expect 1 row; 0 means the id,
--     the tab or the database is wrong, and nothing was touched:
--       update public.communication_logs
--          set status = 'failed', attempt_started_at = '<OLD_STAMP>', error = 'old failure'
--        where id = '<RACE_ID>'
--          and channel = 'rh059-race' and to_address = 'rehearsal@example.invalid'
--          and to_regclass('staging_guard.sentinel') is not null;
--
-- B5. THE NORMAL DELETE, always, last:
--       delete from public.communication_logs
--        where id = '<RACE_ID>'
--          and channel = 'rh059-race' and to_address = 'rehearsal@example.invalid'
--          and to_regclass('staging_guard.sentinel') is not null
--       returning id;   -- 1 row
--     0 rows means the id, the tab or the database is wrong: nothing was
--     deleted, so check before trying again. Done. B6 and B7 are only for a
--     run abandoned before the ids were written down, which a delete by id
--     cannot recover.
--
-- B6. RECOVERY PREVIEW, its own run, READ before B7 is run at all:
--       select id, channel, status, created_at, to_address
--         from public.communication_logs
--        where channel like 'rh059-%' and to_address = 'rehearsal@example.invalid';
--     Expect only rehearsal rows: every channel begins 'rh059-'. If anything
--     else appears, or this is not the staging tab, STOP: do not run B7.
--
-- B7. RECOVERY DELETE. The staging_guard.sentinel refusal and the DELETE are
--     in the SAME block, one statement, so the delete cannot run unless the
--     check passed in that same statement. Production has no staging_guard
--     schema (the 14 Nov production dump contains no reference to it), so in
--     a production tab this block raises and deletes nothing.
-- PART B7 BEGIN
-- do $$
-- begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was deleted';
--   end if;
--   delete from public.communication_logs
--    where channel like 'rh059-%'
--      and to_address = 'rehearsal@example.invalid';
-- end $$;
-- PART B7 END
--     Then run B6 again. Expect 0 rows.
--
-- ── Production order ─────────────────────────────────────────
--
-- 1. Waleed runs the legacy count in "Before running" on production and
--    reports the number.
-- 2. The staging rehearsal above, all steps as expected.
-- 3. This file on production, then the "After running" queries.
-- 4. #85 step 3a, built against these functions, to staging.
-- 5. #85 step 3b, the Resend idempotency key, with 3a or before it. 3a never
--    reaches production without 3b: the queued claim can resend after a crash
--    the provider had already accepted, and the failed claim after a timeout
--    the provider accepted. 3b closes both for email. WhatsApp has no
--    equivalent key, so that duplicate risk stays open there.
--
-- What runs in the window between this file and 3a: nothing calls either
-- function, and the current code never names them. The window is safe. The
-- reverse order would make every claim call a function that does not exist and
-- fail; loud, but a reason to keep the order.
