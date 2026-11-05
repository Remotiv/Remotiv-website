-- ============================================================================
-- Migration 053 - live interview restart: the decision, the restart, and its
--                 guards (F10 C2)
-- ----------------------------------------------------------------------------
-- APPLIED. Production on 31 Oct 2026, then staging on 3 Nov 2026: production
-- FIRST, staging three days later, the reverse of the usual order. Those two
-- dates are Waleed's apply records, repeated in the headers of
-- lib/interviews/live-restart.ts and migration-053.test.ts; no file in this
-- repository records the apply itself or a post-check, and the catalog read
-- below does not establish either date.
--
-- OBJECTS CONFIRMED PRESENT ON PRODUCTION, from a catalog read on 5 Nov 2026
-- by Waleed in the Supabase SQL editor: catalog only, no rows, no table
-- scoped, no name guessed; every constraint, index, function, table or column
-- in public whose name contains restart, decide or decision. Of this file's
-- objects it lists: column live_interview_actions.decision; CHECK constraint
-- live_interview_actions_decision; unique index
-- live_interview_actions_one_restart_decision; functions
-- live_interview_actions_restart_rules, live_restart_session and
-- live_restart_extend_deadline. Present means present on 5 Nov 2026; the read
-- says nothing about when they appeared, which body a replaced function holds
-- (055 replaces two of them), or what a constraint's definition contains. No
-- object is NAMED for decide_restart; the word appears only inside
-- definitions. Not covered by that name read, because their names match none
-- of the three words: the CHECKs live_interview_actions_action and
-- live_interview_actions_target, and the function
-- interview_sessions_attempt_rules.
--
-- TRIGGERS CONFIRMED ATTACHED AND ENABLED ON PRODUCTION, from a second
-- catalog read on 5 Nov 2026 by Waleed in the Supabase SQL editor (pg_trigger
-- with tgenabled, catalog only, no rows) covering every trigger on
-- interview_sessions, live_interview_actions and live_restart_link_events,
-- all of them enabled: live_interview_actions_restart_rules (this file's
-- decision trigger) and interview_sessions_attempt_rules (020's trigger,
-- whose function body this file replaces). Five further triggers exist on
-- live_interview_actions (live_interview_actions_company, _stamp, _no_update,
-- _no_delete, _no_truncate), so 042's append-only guards are live. A trigger
-- being enabled says which function it calls, not which body that function
-- holds: the catalog still cannot tell 053's body of
-- live_interview_actions_restart_rules or live_restart_session from 055's
-- replacement of it, nor 020's body of interview_sessions_attempt_rules from
-- this file's.
-- scripts/backfills/tenancy-columns-production-2026-11-04.md (the keys of
-- interview_sessions, read from production on 4 Nov 2026) covers none of these.
--
-- Because staging was applied after the 2 Nov 2026 catalog run,
-- scripts/backfills/054-execution-sequence.md (stage 18, the P7 to P8b scope
-- note) found staging's interview_sessions_attempt_rules to be 020's body: that
-- is one of #68's four staging differences, and the 3 Nov apply resolves it.
-- Never re-run after 055 (the guard below refuses). For a fresh environment:
-- run by hand in the Supabase SQL editor, after 052, with the pre-check from
-- the F10 C2 report first (042, 048-052 applied; the constraints and function
-- replaced here still the ones 049 and 020 wrote). This file also stops before
-- changing anything if 020, 042, 049 or 050 is missing.
--
-- ── What a restart is (decisions of 31 Oct 2026) ─────────────
--
-- A company Owner or Admin decides, once per interview, whether a live first
-- attempt is run again: restart or no restart, with a note. Never automatic.
-- Decidable only when the first attempt's call has a verified end
-- (live_ended_at: the export, the server finalize, or the time-cap backstop)
-- and either:
--
--   · its outcome is final and one of ending_unconfirmed, technical_failure
--     or abandoned (partial and completed never), or
--   · no export ever arrived (live_outcome null) and the end is at least an
--     hour old.
--
-- A restart is a new session (020): attempt 2, linked to attempt 1, with
-- attempt 1's frozen questions, marking scheme and settings. Attempt 1 becomes
-- 'abandoned' (020's terminal status) and keeps its real live_outcome for
-- reporting; nothing may change that outcome afterwards, so a late export can
-- neither rewrite the decision's basis nor make attempt 1 count
-- (countingLiveScore already counts only the latest attempt).
--
-- ── The deadline ─────────────────────────────────────────────
--
-- Attempt 2 gets at least 72 hours after its email is delivered. The restart
-- sets greatest(attempt 1's deadline, now() + 72 hours); when the email is
-- delivered, live_restart_extend_deadline moves it to at least 72 hours from
-- then. A failed email shortens nothing, and a re-send for the same attempt 2
-- extends it again. The deadline only ever moves later, only while attempt 2
-- is still 'invited', and never to or past delete_after: retention stays the
-- original invite's, and a restart that would end after it is refused rather
-- than retention being moved.
--
-- ── What this file does ──────────────────────────────────────
--
--   1. live_interview_actions takes 'decide_restart' with decision 'restart'
--      or 'no_restart', on the session (no question, no turn), at most once per
--      session (a unique index). Its own trigger re-checks the session is
--      decidable before the row lands. "No restart" is that row and nothing
--      else: no session changes.
--   2. 020's trigger function is replaced in full. Its update rules are kept
--      word for word; added: 'abandoned' needs a recorded restart decision; an
--      abandoned attempt's live_outcome never changes; a restart needs the
--      'restart' decision on its first attempt, starts 'invited', copies
--      scoring_snapshot too (028 came after 020); attempt 2's deadline as
--      above. The trigger itself is unchanged and still calls this function.
--   3. live_restart_session: the database half of a restart, in one
--      transaction. live_restart_extend_deadline: the 72 hours after delivery.
--      Both for the service role only.
--
-- No existing row is read for a change or changed: constraints are replaced
-- with a superset (every existing action stays valid), an index is added on a
-- value no row holds yet, and functions and one trigger are created.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- Constraints dropped before they are added, the index and functions created
-- if not exists or replaced, the trigger dropped before it is created, rights
-- revoked and granted again. All in one transaction.
-- ============================================================================

begin;

do $$
begin
  -- 055 replaces two of this file's functions with versions that take a lock;
  -- re-running this file after 055 would silently put the lock-free ones back.
  if to_regclass('public.live_restart_link_events') is not null then
    raise exception '053 must not be re-run after 055 - it would remove 055''s lock. Not proceeding.';
  end if;
  if to_regprocedure('public.interview_sessions_attempt_rules()') is null then
    raise exception '053: public.interview_sessions_attempt_rules() is missing. Apply 020 first. Not proceeding.';
  end if;
  if to_regprocedure('public.live_scoring_session_company()') is null
     or to_regclass('public.live_interview_actions') is null then
    raise exception '053: live_interview_actions (042) is missing. Apply 042 first. Not proceeding.';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.live_interview_actions'::regclass
       and conname = 'live_interview_actions_action'
       and pg_get_constraintdef(oid) like '%resolve_wording_check%'
  ) then
    raise exception '053: live_interview_actions_action does not name resolve_wording_check. Apply 049 first. Not proceeding.';
  end if;
  if to_regclass('public.live_session_events') is null then
    raise exception '053: live_session_events (050) is missing. Apply 050 first. Not proceeding.';
  end if;
end;
$$;

-- ── 1. The decision, on 042's append-only action log ─────────

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_action,
  add constraint live_interview_actions_action
    check (
      action in (
        'retry_transcription',
        'resolve_needs_check',
        'resolve_repeat_check',
        'resolve_wording_check',
        'resolve_style_check',
        'resolve_failed_transcription',
        'decide_restart'
      )
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_decision,
  add constraint live_interview_actions_decision
    check (
      (action = 'retry_transcription' and decision = 'retry')
      or (
        action in (
          'resolve_needs_check',
          'resolve_repeat_check',
          'resolve_wording_check',
          'resolve_style_check'
        )
        and decision in ('score', 'exclude')
      )
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
      or (action = 'decide_restart' and decision in ('restart', 'no_restart'))
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_target,
  add constraint live_interview_actions_target
    check (
      case
        when action in (
          'resolve_needs_check',
          'resolve_repeat_check',
          'resolve_wording_check',
          'resolve_style_check'
        )
          then question_position is not null
        when action = 'decide_restart'
          then question_position is null and turn_id is null and turn_sequence is null
        else turn_id is not null and turn_sequence is not null
      end
    );

-- Decided once per session: a restart or a no-restart, never both, never twice.
create unique index if not exists live_interview_actions_one_restart_decision
  on public.live_interview_actions (session_id)
  where action = 'decide_restart';

-- Whether the session can be decided, checked by the database before the row
-- lands, whoever inserts it. The session row is locked, so two decisions for
-- one session serialise here and the index refuses the second.
create or replace function public.live_interview_actions_restart_rules()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  s public.interview_sessions%rowtype;
begin
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
  return new;
end;
$$;

drop trigger if exists live_interview_actions_restart_rules on public.live_interview_actions;
create trigger live_interview_actions_restart_rules
  before insert on public.live_interview_actions
  for each row
  when (new.action = 'decide_restart')
  execute function public.live_interview_actions_restart_rules();

-- ── 2. 020's trigger function, replaced in full ──────────────

create or replace function public.interview_sessions_attempt_rules()
returns trigger
language plpgsql
as $$
declare
  prev public.interview_sessions%rowtype;
begin
  if tg_op = 'UPDATE' then
    -- Terminal: an abandoned attempt is never reopened, submitted or scored.
    if old.status = 'abandoned' and new.status is distinct from 'abandoned' then
      raise exception 'interview_sessions: session % is abandoned and cannot change status (to %)',
        old.id, new.status
        using errcode = 'check_violation';
    end if;

    -- Only a call that actually began can drop.
    if new.status = 'abandoned'
       and old.status is distinct from 'abandoned'
       and old.status <> 'started' then
      raise exception 'interview_sessions: only a started session can be abandoned (session %, was %)',
        old.id, old.status
        using errcode = 'check_violation';
    end if;

    if new.attempt is distinct from old.attempt
       or new.previous_attempt_id is distinct from old.previous_attempt_id then
      raise exception 'interview_sessions: attempt and previous_attempt_id are set at insert (session %)',
        old.id
        using errcode = 'check_violation';
    end if;

    -- 053: abandoned means restarted, and only a person decides that.
    if new.status = 'abandoned'
       and old.status is distinct from 'abandoned'
       and not exists (
         select 1 from public.live_interview_actions a
          where a.session_id = old.id and a.action = 'decide_restart' and a.decision = 'restart'
       ) then
      raise exception 'interview_sessions: session % can be abandoned only after a recorded restart decision',
        old.id
        using errcode = 'check_violation';
    end if;

    -- 053: a restarted attempt's outcome is kept as it was decided on. A late
    -- export or settle cannot rewrite it.
    if old.status = 'abandoned' and new.live_outcome is distinct from old.live_outcome then
      raise exception 'interview_sessions: session % is abandoned; its live_outcome never changes',
        old.id
        using errcode = 'check_violation';
    end if;

    -- 053: a restart's deadline only moves later, only while it is invited,
    -- and never to or past its retention date.
    if old.attempt = 2 and new.expires_at is distinct from old.expires_at then
      if old.status <> 'invited'
         or new.expires_at < old.expires_at
         or new.expires_at >= new.delete_after then
        raise exception 'interview_sessions: restart %''s deadline may only move later, while invited, and before its retention date',
          old.id
          using errcode = 'check_violation';
      end if;
    end if;

    return new;
  end if;

  if new.previous_attempt_id is null then
    return new;
  end if;

  -- FOR UPDATE: two restarts racing for the same first attempt serialise here,
  -- and the unique index refuses the second.
  select * into prev
  from public.interview_sessions
  where id = new.previous_attempt_id
  for update;

  if not found or prev.attempt <> 1 or prev.status <> 'abandoned' then
    raise exception 'interview_sessions: a restart must follow an abandoned first attempt (previous %)',
      new.previous_attempt_id
      using errcode = 'check_violation';
  end if;

  -- 053: a person decided this restart.
  if not exists (
    select 1 from public.live_interview_actions a
     where a.session_id = prev.id and a.action = 'decide_restart' and a.decision = 'restart'
  ) then
    raise exception 'interview_sessions: a restart needs a recorded restart decision on its first attempt (previous %)',
      prev.id
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from 'invited' then
    raise exception 'interview_sessions: a restart starts invited (previous %)', prev.id
      using errcode = 'check_violation';
  end if;

  -- A restart is the same interview run again: same candidate, same frozen
  -- settings, questions and marking scheme, same retention date. Rebuilding any
  -- of them from the live job would let a job edit reach an interview already
  -- in flight. The deadline may be later (053), never earlier.
  if (new.company_id, new.application_id, new.job_id, new.kind)
       is distinct from (prev.company_id, prev.application_id, prev.job_id, prev.kind)
     or new.questions_snapshot is distinct from prev.questions_snapshot
     or new.scoring_snapshot is distinct from prev.scoring_snapshot
     or new.live_settings is distinct from prev.live_settings
     or new.delete_after is distinct from prev.delete_after then
    raise exception 'interview_sessions: a restart must copy its first attempt''s candidate, settings, questions, marking scheme and retention date unchanged (previous %)',
      prev.id
      using errcode = 'check_violation';
  end if;

  if new.expires_at < prev.expires_at or new.expires_at >= new.delete_after then
    raise exception 'interview_sessions: a restart''s deadline is never earlier than its first attempt''s, and is before its retention date (previous %)',
      prev.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ── 3. The restart, and the 72 hours after delivery ──────────

-- The database half of a restart, in one transaction: the decision (its own
-- trigger re-checks the session is decidable), attempt 1 abandoned, attempt 2
-- created from attempt 1's frozen copy. Returns attempt 2's deadline. The app
-- then emails the link and, once it is delivered, calls
-- live_restart_extend_deadline.
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
begin
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

-- At least 72 hours from now for an invited restart, called when its email is
-- delivered (the first send or a re-send). Never shortens; refused once the
-- candidate has started, and never past the retention date (020's trigger, as
-- replaced above). Returns the deadline.
create or replace function public.live_restart_extend_deadline(
  p_session_id uuid,
  p_company_id uuid
)
returns timestamptz
language plpgsql
set search_path = public
as $$
declare
  s public.interview_sessions%rowtype;
  deadline timestamptz;
begin
  select * into s
    from public.interview_sessions
   where id = p_session_id and company_id = p_company_id
   for update;
  if not found or s.attempt <> 2 then
    raise exception 'live_restart_extend_deadline: no restart % in company %', p_session_id, p_company_id
      using errcode = 'no_data_found';
  end if;
  if s.status <> 'invited' then
    raise exception 'live_restart_extend_deadline: restart % is %, not invited; its deadline stays', s.id, s.status
      using errcode = 'check_violation';
  end if;
  deadline := greatest(s.expires_at, now() + interval '72 hours');
  if deadline is distinct from s.expires_at then
    update public.interview_sessions set expires_at = deadline where id = s.id;
  end if;
  return deadline;
end;
$$;

revoke all on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)
  to service_role;

revoke all on function public.live_restart_extend_deadline(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.live_restart_extend_deadline(uuid, uuid)
  to service_role;

commit;

-- ── After running ────────────────────────────────────────────
-- Each of the 3 constraint definitions contains decide_restart (no object is
-- NAMED for it); the index exists; the action
-- trigger exists; both functions are executable by service_role only:
--
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.live_interview_actions'::regclass
--    and conname in ('live_interview_actions_action', 'live_interview_actions_decision',
--                    'live_interview_actions_target')
--  order by 1;
-- select indexdef from pg_indexes where indexname = 'live_interview_actions_one_restart_decision';
-- select tgname from pg_trigger where tgname = 'live_interview_actions_restart_rules';
-- select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as can_execute
--   from pg_proc p cross join pg_roles r
--  where p.proname in ('live_restart_session', 'live_restart_extend_deadline')
--    and r.rolname in ('anon', 'authenticated', 'service_role')
--  order by 1, 2;
