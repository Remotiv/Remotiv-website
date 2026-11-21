-- ============================================================================
-- Migration 071 - an applicant delete in one closing step and one finishing
--                 step, with nothing new able to start in between (#16)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production. Apply AFTER 070 (it
-- activates 070's calendar_cleanups) and BEFORE deploying the code that calls
-- these functions: the applicant delete calls close_application_for_deletion
-- first and refuses, with a message, when it cannot.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- The delete used to be a dozen separate writes. One that failed half way left
-- some of the candidate's links open and some closed, the CV gone and the row
-- kept, or bells removed from someone still listed. Now:
--
--   1. CLOSE, one transaction (close_application_for_deletion):
--        the applicant is marked (deletion_started_at, set once, never
--        cleared); every interview session is closed (delete_after now,
--        invited or started becomes cancelled); its queued transcription,
--        scorecard and message jobs are failed; every open booking, of every
--        purpose, is cancelled with its Google event id kept; every active
--        final interview is cancelled.
--      Either every candidate link is closed, or none is.
--   2. The app, each step safe to repeat: Google deletes the events (a first
--      failure is recorded on the row, deletion_calendar_failed_at); storage
--      deletes the files.
--   3. FINISH, one transaction (finish_application_deletion): the sessions,
--      the bells, the row (with its cascades) go, and the applicant's
--      calendar cleanups (070) become lasting alerts. All or nothing.
--
-- ── Nothing new while it is marked ───────────────────────────
--
-- application_deletion_guard() runs BEFORE INSERT on interview_sessions,
-- interview_bookings and final_interviews, and before a communication_logs
-- row becomes 'queued' (a first attempt, an automatic or manual claim, a
-- Retry, a manual WhatsApp). It reads the applicant FOR SHARE: that waits for
-- a Close still running, then sees its committed marker, so an invite, a
-- booking, a restart or a message claim that raced the Close is refused, not
-- let through. A plain read would not wait (the trigger runs before the
-- foreign-key check), which is why it locks. The refusal is SQLSTATE RD071,
-- which the app reads as "this applicant is being deleted".
--
-- A message claimed BEFORE the Close and sent after it is the case no claim
-- can see: the app checks the marker again immediately before every provider
-- call (lib/applicant-deletion.ts). A message the provider has already
-- accepted cannot be recalled.
--
-- ── Who can run it ───────────────────────────────────────────
--
-- Close and Finish: SECURITY INVOKER (the guard trigger is DEFINER, see it),
-- empty search_path, schema-qualified names,
-- EXECUTE for service_role only (Supabase grants it to anon and authenticated
-- on new public functions by default, so both are revoked). Every statement is
-- on the company passed in; the app passes the signed-in member's company.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- `if not exists`, `create or replace` and `drop trigger if exists` throughout.
-- ============================================================================

begin;

alter table public.job_applications
  add column if not exists deletion_started_at timestamptz,
  add column if not exists deletion_calendar_failed_at timestamptz;

comment on column public.job_applications.deletion_started_at is
  '#16: set once by close_application_for_deletion, never cleared. While set, nothing new may start for this applicant (application_deletion_guard).';
comment on column public.job_applications.deletion_calendar_failed_at is
  '#16: the first time Google, while connected, did not confirm an event of this applicant was removed. "Delete anyway" is offered only once this is set.';

-- ── The guard ────────────────────────────────────────────────

-- SECURITY DEFINER, unlike the two functions below: a trigger runs as whoever
-- inserts, and its FOR SHARE read needs a privilege not every inserting role
-- has. It reads one column of one row and returns nothing, so running as its
-- owner reveals nothing to anyone.
create or replace function public.application_deletion_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  marked timestamptz;
begin
  if new.application_id is null then
    return new;
  end if;
  if tg_table_schema = 'public' and tg_table_name = 'communication_logs' then
    -- Only a row becoming 'queued' starts a send: a first attempt, a claim of
    -- a failed row, a stale re-claim (a new stamp). Failed, skipped and sent
    -- writes, and the pre-send refresh, go through.
    if new.status is distinct from 'queued' then
      return new;
    end if;
    if tg_op = 'UPDATE'
       and old.status = 'queued'
       and old.attempt_started_at is not distinct from new.attempt_started_at then
      return new;
    end if;
  end if;
  select a.deletion_started_at
    into marked
    from public.job_applications a
   where a.id = new.application_id
     for share;
  if marked is not null then
    raise exception 'application_deletion_in_progress'
      using errcode = 'RD071',
            detail = 'This applicant is being deleted; nothing new may start for them.';
  end if;
  return new;
end;
$$;

drop trigger if exists application_deletion_guard on public.interview_sessions;
create trigger application_deletion_guard
  before insert on public.interview_sessions
  for each row execute function public.application_deletion_guard();

drop trigger if exists application_deletion_guard on public.interview_bookings;
create trigger application_deletion_guard
  before insert on public.interview_bookings
  for each row execute function public.application_deletion_guard();

drop trigger if exists application_deletion_guard on public.final_interviews;
create trigger application_deletion_guard
  before insert on public.final_interviews
  for each row execute function public.application_deletion_guard();

drop trigger if exists application_deletion_guard on public.communication_logs;
create trigger application_deletion_guard
  before insert or update on public.communication_logs
  for each row execute function public.application_deletion_guard();

-- ── 1. Close ─────────────────────────────────────────────────
--
-- Returns {"outcome": "not_found"} or {"outcome": "closed", "first": bool,
-- "session_ids": [...], "final_booking_ids": [...]}. Safe to repeat: a second
-- Close finds nothing open and returns the same ids.

create or replace function public.close_application_for_deletion(
  p_company_id uuid, p_application_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  app record;
  sessions uuid[];
  finals uuid[];
begin
  select a.id, a.deletion_started_at
    into app
    from public.job_applications a
   where a.id = p_application_id
     and a.company_id_snapshot = p_company_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  update public.job_applications a
     set deletion_started_at = pg_catalog.now()
   where a.id = p_application_id
     and a.company_id_snapshot = p_company_id
     and a.deletion_started_at is null;

  select coalesce(array_agg(s.id), '{}')
    into sessions
    from public.interview_sessions s
   where s.company_id = p_company_id
     and s.application_id = p_application_id;

  -- Closed with existing states only, as application-deletion.ts did.
  update public.interview_sessions s
     set delete_after = pg_catalog.now()
   where s.company_id = p_company_id
     and s.id = any (sessions)
     and (s.delete_after is null or s.delete_after > pg_catalog.now());
  update public.interview_sessions s
     set status = 'cancelled'
   where s.company_id = p_company_id
     and s.id = any (sessions)
     and s.status in ('invited', 'started');

  -- Their queued jobs, failed: transcription and scorecards by session or by
  -- answer, and the applicant's own messages and CV scoring (nothing may write
  -- about an applicant being deleted).
  update public.background_jobs j
     set status = 'failed',
         last_error = 'session deleted',
         updated_at = pg_catalog.now()
   where j.status = 'queued'
     and (
       (j.type in ('transcribe', 'ai_scorecard')
         and j.payload->>'sessionId' = any (sessions::text[]))
       or (j.type = 'transcribe'
         and j.payload->>'answerId' in (
           select a.id::text
             from public.interview_answers a
            where a.session_id = any (sessions)))
     );
  update public.background_jobs j
     set status = 'failed',
         last_error = 'application being deleted',
         updated_at = pg_catalog.now()
   where j.status = 'queued'
     and j.type in ('send_message', 'ai_cv_score')
     and j.payload->>'applicationId' = p_application_id::text;

  -- Every open booking, of every purpose: invited, and booked still ahead.
  -- The Google event id is KEPT: the app removes the event next, and a retry
  -- finds it here until Google confirms.
  select coalesce(array_agg(b.id) filter (where b.purpose = 'final'), '{}')
    into finals
    from public.interview_bookings b
   where b.company_id = p_company_id
     and b.application_id = p_application_id
     and (b.status = 'invited'
       or (b.status = 'booked' and b.scheduled_start > pg_catalog.now()));
  update public.interview_bookings b
     set status = 'cancelled',
         cancelled_at = pg_catalog.now(),
         cancelled_by = 'company',
         cancel_reason = null
   where b.company_id = p_company_id
     and b.application_id = p_application_id
     and (b.status = 'invited'
       or (b.status = 'booked' and b.scheduled_start > pg_catalog.now()));

  update public.final_interviews f
     set status = 'cancelled',
         cancelled_at = pg_catalog.now()
   where f.company_id = p_company_id
     and f.application_id = p_application_id
     and f.status = 'active';

  return jsonb_build_object(
    'outcome', 'closed',
    'first', app.deletion_started_at is null,
    'session_ids', to_jsonb(sessions),
    'final_booking_ids', to_jsonb(finals));
end;
$$;

-- ── 3. Finish ────────────────────────────────────────────────
--
-- Only after Close (not_closed otherwise) and after the app has removed every
-- file and every event it can. Returns {"outcome": "not_found" | "not_closed"
-- | "deleted"}. A failure rolls the whole of it back; a retry runs it again.

create or replace function public.finish_application_deletion(
  p_company_id uuid, p_application_id uuid, p_hrefs text[])
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  app record;
begin
  -- The row lock also holds back a bell or a message being written for this
  -- applicant until this commits, after which the row is gone.
  select a.id, a.deletion_started_at
    into app
    from public.job_applications a
   where a.id = p_application_id
     and a.company_id_snapshot = p_company_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if app.deletion_started_at is null then
    return jsonb_build_object('outcome', 'not_closed');
  end if;

  -- One statement: a restart points at its first attempt. The cascades take
  -- answers, turns, scores, review actions, page events and video pieces.
  delete from public.interview_sessions s
   where s.company_id = p_company_id
     and s.application_id = p_application_id;

  -- Their bells: by the applicant, and orphaned ones by the links that name
  -- them (an interview_expired bell links to the interview page).
  delete from public.notifications_company n
   where n.company_id = p_company_id
     and (n.application_id = p_application_id
       or (n.application_id is null and n.href = any (coalesce(p_hrefs, '{}'))));

  delete from public.job_applications a
   where a.id = p_application_id
     and a.company_id_snapshot = p_company_id;

  -- 070: the row's deletion just set pending_application_id to NULL on its
  -- cleanups; they become the bell's lasting alerts now, in this transaction.
  update public.calendar_cleanups c
     set status = 'open',
         activated_at = pg_catalog.now()
   where c.company_id = p_company_id
     and c.status = 'pending'
     and c.pending_application_id is null;

  return jsonb_build_object('outcome', 'deleted');
end;
$$;

revoke all on function public.application_deletion_guard() from public;
revoke all on function public.application_deletion_guard() from anon, authenticated;
revoke all on function public.close_application_for_deletion(uuid, uuid) from public;
revoke all on function public.close_application_for_deletion(uuid, uuid) from anon, authenticated;
grant execute on function public.close_application_for_deletion(uuid, uuid) to service_role;
revoke all on function public.finish_application_deletion(uuid, uuid, text[]) from public;
revoke all on function public.finish_application_deletion(uuid, uuid, text[]) from anon, authenticated;
grant execute on function public.finish_application_deletion(uuid, uuid, text[]) to service_role;

commit;
