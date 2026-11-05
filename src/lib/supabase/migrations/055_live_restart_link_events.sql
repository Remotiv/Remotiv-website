-- ============================================================================
-- Migration 055 - live restart link events, and no new first attempt for an
--                 interview already restarted or decided (F10-LOG)
-- ----------------------------------------------------------------------------
-- APPLIED. Per the F10 records, staging and production 3 Nov 2026; this
-- repository holds no record of that date, and the catalog reads below
-- establish what is present on 5 Nov 2026, not when it appeared.
--
-- OBJECTS CONFIRMED PRESENT ON PRODUCTION, from the 5 Nov 2026 catalog read
-- described in 053's header (catalog only, unscoped, every object in public
-- whose name contains restart, decide or decision). Of this file's objects it
-- lists: table live_restart_link_events; its constraints
-- live_restart_link_events_pkey, live_restart_link_events_session_id_fkey,
-- live_restart_link_events_event and live_restart_link_events_actor_role; its
-- indexes live_restart_link_events_pkey, live_restart_link_events_session and
-- live_restart_link_events_company; functions live_restart_link_events_rules,
-- live_restart_link_events_append_only,
-- interview_sessions_no_first_attempt_after_restart,
-- live_interview_actions_restart_rules and live_restart_session (the last two
-- are replaced here, and the read cannot tell 053's body from this file's).
-- Present means present on 5 Nov 2026, not when they appeared. Also confirmed
-- by that read's indexdef: interview_sessions_live_application is
-- btree (application_id) WHERE kind = 'live'.
--
-- TRIGGERS CONFIRMED ATTACHED AND ENABLED ON PRODUCTION, from a second
-- catalog read on 5 Nov 2026 by Waleed in the Supabase SQL editor (pg_trigger
-- with tgenabled, catalog only, no rows): all five this file attaches, the
-- four on live_restart_link_events (live_restart_link_events_rules,
-- live_restart_link_events_no_update, live_restart_link_events_no_delete,
-- live_restart_link_events_no_truncate) and
-- interview_sessions_no_first_attempt_after_restart on interview_sessions,
-- every one enabled. An enabled trigger names its function, not that
-- function's body: the read cannot tell this file's replacement of
-- live_interview_actions_restart_rules and live_restart_session from 053's.
--
-- ROW LEVEL SECURITY AND TABLE PRIVILEGES CONFIRMED ON PRODUCTION, from a
-- third catalog read on 5 Nov 2026 by Waleed in the Supabase SQL editor
-- (pg_class including relowner, pg_policies,
-- information_schema.role_table_grants, pg_roles, has_table_privilege and
-- has_any_column_privilege; catalog only, no rows). Two barriers keep
-- live_restart_link_events server-only. They are independent but not
-- interchangeable: RLS covers SELECT, INSERT, UPDATE and DELETE for roles
-- subject to it, and nothing else; the privilege layer covers those four
-- plus TRUNCATE, REFERENCES and TRIGGER, which RLS never sees. For
-- TRUNCATE, REFERENCES and TRIGGER the privilege layer is the only barrier.
-- For the four row operations both hold, and RLS is the one that would
-- survive a grant added later.
--
--   Privilege layer. role_table_grants lists postgres and service_role only,
--   each with SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
--   TRIGGER; no row for anon, none for authenticated. has_table_privilege
--   returned false for all 14 combinations of anon and authenticated with
--   those seven privileges, so nothing reaches them through PUBLIC or an
--   inherited role either. A statement from anon or authenticated is refused
--   here, before RLS is consulted.
--
--   RLS layer. pg_class: rowsecurity = true. pg_policies: no rows, zero
--   policies. pg_roles: anon and authenticated are rolsuper = false and
--   rolbypassrls = false, so both are subject to RLS. A table with RLS on
--   and no policy is default-deny for SELECT, INSERT, UPDATE and DELETE by
--   every role subject to RLS: even a grant added later would still be
--   refused. No policy is stronger than a permissive policy, not weaker.
--
--   TRUNCATE, REFERENCES and TRIGGER are outside RLS; the privilege layer
--   is the load-bearing barrier for them, and it holds: no grant, and
--   has_table_privilege false for both roles.
--
--   Column privileges. has_table_privilege answers for table-level grants
--   only; a column-level grant is a separate thing, so the read also ran
--   has_any_column_privilege for the four privileges a column can carry.
--   All eight are false: anon SELECT, INSERT, UPDATE, REFERENCES; and
--   authenticated SELECT, INSERT, UPDATE, REFERENCES. That is NO EFFECTIVE
--   COLUMN PRIVILEGE for either role, now, including through PUBLIC and
--   role membership; it is not proof that no GRANT was ever issued, since
--   the function says nothing about a grant later revoked. The read
--   mattered although the table-level answer was already no: SELECT,
--   INSERT and UPDATE through a column grant would still meet the
--   zero-policy denial, but REFERENCES sits outside RLS, so it is the only
--   privilege a column grant could ever have opened. TRUNCATE and TRIGGER
--   are absent from this read because neither is a column-level privilege;
--   has_any_column_privilege does not apply to them, and the table-level
--   has_table_privilege result is the whole answer for both.
--
--   service_role is rolbypassrls = true and holds the grants above. That is
--   why the server can write to a table with zero policies: it is exempt from
--   RLS, not let through by a policy. Without this the configuration would
--   read as broken; it is not.
--
--   forced = false (relforcerowsecurity) is not a weakness. It exempts only
--   the table owner from RLS. pg_class.relowner: the owner is postgres.
--   pg_roles for postgres: rolsuper = false, rolbypassrls = true. postgres
--   is exempt from RLS by BYPASSRLS, not by being a superuser, and a role
--   with BYPASSRLS is exempt whether or not RLS is forced. FORCE ROW LEVEL
--   SECURITY would not subject this owner to RLS; relforcerowsecurity =
--   false changes nothing. Do not "fix" it.
--
-- WHAT THE THREE CATALOG READS ESTABLISH, all as of 5 Nov 2026: that the
-- objects exist, that the triggers are attached and enabled, the RLS state,
-- the policy count, the table owner, and the table and column privileges.
-- WHAT THEY DO NOT ESTABLISH: any function's body (the reads name
-- live_interview_actions_restart_rules and live_restart_session and cannot
-- tell this file's replacement from 053's), and any date. The "After running"
-- queries at the end of this file are kept as the record of what to check;
-- they are no longer a pending post-check.
--
-- Run by hand in the Supabase SQL editor, after 053 (production 31 Oct 2026,
-- staging 3 Nov 2026, per Waleed's records; 054 is unrelated and may run in
-- either order). Run the pre-check from the F10-LOG report first: it confirms
-- 053 is applied and that the names used here are free, and lists the
-- triggers already on interview_sessions. This file also stops before changing
-- anything if 053 is missing.
--
-- ── 1. live_restart_link_events ──────────────────────────────
--
-- The record of a restart's link (F10 C5): sent, failed, or re-issued, by
-- whom. A new table rather than another action on live_interview_actions:
-- that log is decisions, each with a required note (042), and a link email is
-- not a decision. One row per event, on the restart (attempt 2) only:
--
--   sent      the email provider accepted the link's email (not proof that
--             it reached the candidate's inbox)
--   failed    the email provider did not accept it (nothing else changed)
--   reissued  a new token replaced the link, before its email
--
-- Codes, never text: no email address, no token, no note. The session's
-- company is checked by the database (as 042 and 050 do), the time is the
-- database's (the caller cannot backdate a row), and the table is
-- append-only: a row goes only with its session (ON DELETE CASCADE), so
-- deleting an interview (C6c, B7) takes its link record with it. RLS on, no
-- policies, no rights for anon or authenticated: server-only, service role.
--
-- actor_role is limited to the values 'owner' and 'admin'; this migration does
-- NOT check that actor_user_id is a member of the company with that role. The
-- writer must pass the real company context: when this is wired, the rows are
-- written in lib/interviews/live-restart-flow.ts, after gateForAction (the
-- review gate, canActOnLiveReview, latest attempt), with ctx.user.id and
-- ctx.role.
--
-- ── 2. No new first attempt after a restart or a decision ────
--
-- The applicant drawer's own send already refuses (F10 C6a: a read guard and
-- the cancel's own filter). This is the database's half: a new live first
-- attempt (attempt 1, no predecessor) for an application that already has a
-- live restart (attempt 2), or a restart decision on any of its live sessions,
-- is refused, whoever inserts it. Within the same company only. It never
-- touches an async session, a restart itself (attempt 2, inserted by 053's
-- live_restart_session), a session with no application, or an application
-- whose interview was never restarted or decided.
--
-- ── 3. The decision, the other way round ─────────────────────
--
-- 053's decision trigger (live_interview_actions_restart_rules) is replaced
-- here with every 053 rule unchanged, plus one: a first attempt cannot be
-- decided once its application has another live first attempt (not
-- cancelled) created at the same time or later. A later one means a re-send
-- landed first and this attempt is no longer the candidate's latest; an exact
-- tie cannot be ordered, so it fails closed and the decision is refused.
--
-- ── What is serialized, and how ──────────────────────────────
--
-- Three paths take the same transaction-scoped advisory lock, keyed on the
-- application: pg_advisory_xact_lock(hashtextextended('live-restart:' ||
-- application_id, 0)).
--
--   the guard (a new live first attempt with an application)
--   the decision trigger (a decide_restart row; a session with an application)
--   live_restart_session (replaced here from 053, its body otherwise unchanged)
--
-- A second transaction for the same application waits at the lock until the
-- first commits or rolls back, and then reads what the first committed: a new
-- first attempt, a decision and a restart for one application are checked one
-- after the other, never against the state before another one. Different
-- applications use different keys and do not wait on each other (two whose
-- keys collide in the 64-bit hash would wait, never be refused).
--
-- The order is the same in every path: the application lock first, then the
-- session row. Each path reads application_id without a lock, takes the
-- advisory lock, and only then reads the session FOR UPDATE (the guard takes
-- no row lock). Under 053 alone, a restart locked the first attempt's row and
-- then, in its decision insert, waited for nothing; with a lock added only to
-- the decision trigger, a restart (row, then application lock) and a
-- concurrent no_restart insert (application lock, then row) could each hold
-- what the other waits for. With one order in all three, the second
-- transaction waits at the application lock while holding nothing it needs.
-- live_restart_extend_deadline (053) takes only a session row lock and never
-- the advisory lock.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- create ... if not exists, constraints dropped before they are added,
-- functions replaced, triggers dropped before they are created, rights
-- revoked and granted again. All in one transaction. No existing row is read
-- for a change or changed.
-- ============================================================================

begin;

do $$
begin
  if to_regprocedure(
       'public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)'
     ) is null
     or to_regclass('public.live_interview_actions_one_restart_decision') is null then
    raise exception '055: migration 053 (live restart decision) is missing. Apply 053 first. Not proceeding.';
  end if;
end;
$$;

-- ── 1. live_restart_link_events ──────────────────────────────

create table if not exists public.live_restart_link_events (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.interview_sessions (id) on delete cascade,
  company_id     uuid not null,
  event          text not null,
  actor_user_id  uuid not null,
  actor_role     text not null,
  created_at     timestamptz not null default now()
);

alter table public.live_restart_link_events
  drop constraint if exists live_restart_link_events_event,
  add constraint live_restart_link_events_event
    check (event in ('sent', 'failed', 'reissued'));

-- Only an owner or admin manages a restart (F10 C5).
alter table public.live_restart_link_events
  drop constraint if exists live_restart_link_events_actor_role,
  add constraint live_restart_link_events_actor_role
    check (actor_role in ('owner', 'admin'));

create index if not exists live_restart_link_events_session
  on public.live_restart_link_events (session_id, created_at);
create index if not exists live_restart_link_events_company
  on public.live_restart_link_events (company_id);

-- The session's own company, and a live restart (attempt 2) only. The database
-- stamps the time.
create or replace function public.live_restart_link_events_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  s_company uuid;
  s_kind text;
  s_attempt smallint;
begin
  select company_id, kind, attempt into s_company, s_kind, s_attempt
    from public.interview_sessions where id = new.session_id;
  if not found then
    raise exception 'live_restart_link_events: session % not found', new.session_id
      using errcode = 'check_violation';
  end if;
  if s_kind is distinct from 'live' or s_attempt is distinct from 2 then
    raise exception 'live_restart_link_events: session % is not a live restart (attempt 2)', new.session_id
      using errcode = 'check_violation';
  end if;
  if new.company_id is distinct from s_company then
    raise exception 'live_restart_link_events: company does not own session %', new.session_id
      using errcode = 'check_violation';
  end if;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists live_restart_link_events_rules on public.live_restart_link_events;
create trigger live_restart_link_events_rules
  before insert on public.live_restart_link_events
  for each row execute function public.live_restart_link_events_rules();

-- Append-only: never updated; deleted only once its session is gone.
create or replace function public.live_restart_link_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'live_restart_link_events is append-only: rows are never updated';
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'live_restart_link_events is append-only: never truncated';
  end if;
  if exists (select 1 from public.interview_sessions where id = old.session_id) then
    raise exception 'live_restart_link_events is append-only: a row goes only with its session';
  end if;
  return old;
end;
$$;

drop trigger if exists live_restart_link_events_no_update on public.live_restart_link_events;
create trigger live_restart_link_events_no_update
  before update on public.live_restart_link_events
  for each row execute function public.live_restart_link_events_append_only();

drop trigger if exists live_restart_link_events_no_delete on public.live_restart_link_events;
create trigger live_restart_link_events_no_delete
  before delete on public.live_restart_link_events
  for each row execute function public.live_restart_link_events_append_only();

drop trigger if exists live_restart_link_events_no_truncate on public.live_restart_link_events;
create trigger live_restart_link_events_no_truncate
  before truncate on public.live_restart_link_events
  for each statement execute function public.live_restart_link_events_append_only();

alter table public.live_restart_link_events enable row level security;

-- Server-only: a second lock behind RLS. The service role reads and appends.
revoke all on table public.live_restart_link_events from public, anon, authenticated;
grant select, insert on table public.live_restart_link_events to service_role;

revoke all on function public.live_restart_link_events_rules() from public, anon, authenticated;
revoke all on function public.live_restart_link_events_append_only() from public, anon, authenticated;

-- ── 2. No new first attempt after a restart or a decision ────

-- The guard's lookup, and the decision's newer-attempt lookup: an application's live sessions.
create index if not exists interview_sessions_live_application
  on public.interview_sessions (application_id)
  where kind = 'live';

create or replace function public.interview_sessions_no_first_attempt_after_restart()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.kind = 'live'
     and new.attempt = 1
     and new.previous_attempt_id is null
     and new.application_id is not null then
    -- Serialized with the decision trigger below, per application.
    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || new.application_id::text, 0));
    if exists (
      select 1
        from public.interview_sessions s
       where s.application_id = new.application_id
         and s.company_id = new.company_id
         and s.kind = 'live'
         and s.attempt = 2
    ) or exists (
      select 1
        from public.live_interview_actions a
        join public.interview_sessions s on s.id = a.session_id
       where s.application_id = new.application_id
         and s.company_id = new.company_id
         and s.kind = 'live'
         and a.company_id = new.company_id
         and a.action = 'decide_restart'
    ) then
      raise exception 'interview_sessions: application % has a restarted or decided AI Video Interview; it is managed from its interview page, not sent again',
        new.application_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists interview_sessions_no_first_attempt_after_restart on public.interview_sessions;
create trigger interview_sessions_no_first_attempt_after_restart
  before insert on public.interview_sessions
  for each row execute function public.interview_sessions_no_first_attempt_after_restart();

revoke all on function public.interview_sessions_no_first_attempt_after_restart()
  from public, anon, authenticated;

-- ── 3. 053's decision trigger and restart: the same lock, application first ──
--
-- Every check below up to "newer first attempt" is 053's, word for word, in
-- 053's order. The trigger itself (053) is unchanged and still calls this.
create or replace function public.live_interview_actions_restart_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  s public.interview_sessions%rowtype;
  app uuid;
begin
  -- Serialized with the guard above, per application: the lock before the row.
  select application_id into app from public.interview_sessions where id = new.session_id;
  if app is not null then
    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || app::text, 0));
  end if;

  select * into s from public.interview_sessions where id = new.session_id for update;
  if not found then
    raise exception 'decide_restart: session % not found', new.session_id
      using errcode = 'check_violation';
  end if;
  if s.kind is distinct from 'live' or s.attempt <> 1 then
    raise exception 'decide_restart: only a live first attempt can be decided (session %)', s.id
      using errcode = 'check_violation';
  end if;
  if s.status <> 'started' then
    raise exception 'decide_restart: session % is %, not started', s.id, s.status
      using errcode = 'check_violation';
  end if;
  if s.live_ended_at is null then
    raise exception 'decide_restart: session % has no verified end yet', s.id
      using errcode = 'check_violation';
  end if;
  if s.live_outcome is null then
    if s.live_ended_at > now() - interval '1 hour' then
      raise exception 'decide_restart: session % has no export and ended less than an hour ago', s.id
        using errcode = 'check_violation';
    end if;
  elsif coalesce(s.live_outcome ->> 'final', 'false') <> 'true' then
    raise exception 'decide_restart: session %''s outcome is not final yet', s.id
      using errcode = 'check_violation';
  elsif coalesce(s.live_outcome ->> 'outcome', '')
          not in ('ending_unconfirmed', 'technical_failure', 'abandoned') then
    raise exception 'decide_restart: session %''s outcome % is never restarted', s.id,
      coalesce(s.live_outcome ->> 'outcome', 'unknown')
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.live_interview_actions a
     where a.session_id = s.id and a.action = 'decide_restart'
  ) then
    raise exception 'decide_restart: session % is already decided', s.id
      using errcode = 'unique_violation';
  end if;
  -- 055: never once another first attempt (not cancelled) exists created at the
  -- same time or later. An exact tie cannot be ordered: refused (fail closed).
  if s.application_id is not null and exists (
    select 1 from public.interview_sessions n
     where n.application_id = s.application_id
       and n.company_id = s.company_id
       and n.kind = 'live'
       and n.attempt = 1
       and n.id <> s.id
       and n.created_at >= s.created_at
       and n.status <> 'cancelled'
  ) then
    raise exception 'decide_restart: session % has a newer first attempt; it is no longer the latest', s.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.live_interview_actions_restart_rules() from public, anon, authenticated;

-- 053's restart, with the application lock taken before its row lock. The rest
-- of the body is 053's, word for word; the rights are 053's, stated again.
create or replace function public.live_restart_session(
  p_session_id uuid,
  p_company_id uuid,
  p_new_session_id uuid,
  p_token_hash text,
  p_note text,
  p_actor_user_id uuid,
  p_actor_name text,
  p_actor_role text,
  p_invited_by uuid,
  p_invited_by_name text
)
returns timestamptz
language plpgsql
set search_path = public
as $$
declare
  prev public.interview_sessions%rowtype;
  deadline timestamptz;
  app uuid;
begin
  -- The application lock before the row, as in every path (see the header).
  select application_id into app
    from public.interview_sessions
   where id = p_session_id and company_id = p_company_id;
  if app is not null then
    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || app::text, 0));
  end if;

  select * into prev
    from public.interview_sessions
   where id = p_session_id and company_id = p_company_id
   for update;
  if not found then
    raise exception 'live_restart_session: session % not found in company %', p_session_id, p_company_id
      using errcode = 'no_data_found';
  end if;

  insert into public.live_interview_actions
    (session_id, company_id, action, decision, note, actor_user_id, actor_name, actor_role)
  values
    (prev.id, prev.company_id, 'decide_restart', 'restart', p_note,
     p_actor_user_id, p_actor_name, p_actor_role);

  deadline := greatest(prev.expires_at, now() + interval '72 hours');
  if prev.delete_after is not null and deadline >= prev.delete_after then
    raise exception 'live_restart_session: session %''s retention date % is before a restart''s deadline %; not restarted',
      prev.id, prev.delete_after, deadline
      using errcode = 'check_violation';
  end if;

  -- 020 allows this only from 'started'; the decision's trigger required it.
  update public.interview_sessions set status = 'abandoned' where id = prev.id;

  insert into public.interview_sessions
    (id, company_id, application_id, job_id, token_hash, status, kind, live_settings,
     attempt, previous_attempt_id, allow_rerecord, questions_snapshot, scoring_snapshot,
     expires_at, delete_after, invited_by, invited_by_name)
  values
    (p_new_session_id, prev.company_id, prev.application_id, prev.job_id, p_token_hash,
     'invited', 'live', prev.live_settings, 2, prev.id, false,
     prev.questions_snapshot, prev.scoring_snapshot,
     deadline, prev.delete_after, p_invited_by, p_invited_by_name);

  return deadline;
end;
$$;

revoke all on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)
  to service_role;

commit;

-- ── After running ────────────────────────────────────────────
-- The table, its two constraints, its triggers, RLS on, no rights for anon or
-- authenticated; the guard trigger on interview_sessions; all three functions
-- take the live-restart: advisory lock (the last query returns three rows):
--
-- select to_regclass('public.live_restart_link_events') as table_exists,
--        (select relrowsecurity from pg_class where oid = 'public.live_restart_link_events'::regclass) as rls_on;
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.live_restart_link_events'::regclass and contype in ('c', 'f') order by 1;
-- select tgname from pg_trigger
--  where tgrelid in ('public.live_restart_link_events'::regclass, 'public.interview_sessions'::regclass)
--    and not tgisinternal order by 1;
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'live_restart_link_events' order by 1, 2;
-- select proname from pg_proc
--  where proname in ('interview_sessions_no_first_attempt_after_restart',
--                     'live_interview_actions_restart_rules', 'live_restart_session')
--    and prosrc like '%pg_advisory_xact_lock(hashtextextended(''live-restart:''%';
