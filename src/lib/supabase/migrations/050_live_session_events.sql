-- ============================================================================
-- Migration 050 - live_session_events: how a live interview ended, as seen
-- ----------------------------------------------------------------------------
-- NOT RUN YET. For review. Run by hand in the Supabase SQL editor, after 049.
--
-- ── What this records ────────────────────────────────────────
--
-- The candidate screen (AVI commit 10) reports what it saw happen during a
-- live interview: the conversation starting, the candidate pressing End, the
-- provider's session_complete or error, the connection dropping, the tab
-- closing, the time limit being reached, and every video piece saved. One
-- row per report, from api/interview/live/event (lib/interviews/live-events.ts).
--
-- These are a reviewer's record, never an outcome. A live interview's
-- outcome comes only from the provider's export (live-ingest.ts, D2/D10):
-- nothing here makes an interview Completed, and the browser can claim
-- anything. A closed tab or a dropped connection is a row here and nothing
-- else: it does not end the interview's video window.
--
-- ── Codes, never text ────────────────────────────────────────
--
-- kind and detail are fixed codes (the CHECKs below, the same lists as
-- live-events.ts). Nothing the browser types is stored: no message, no
-- transcript, no user agent, no address.
--
-- ── Kept with the session ────────────────────────────────────
--
-- Append-only. A row goes only with its session (ON DELETE CASCADE), like
-- live_interview_actions (042). The database stamps created_at; the caller
-- cannot backdate a report. RLS on, no policies: server-only, like the other
-- live tables. Company and live-only are checked by 042's
-- live_scoring_session_company().
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- create ... if not exists, constraints dropped before they are added,
-- functions replaced, triggers dropped before they are created.
-- ============================================================================

begin;

create table if not exists public.live_session_events (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.interview_sessions (id) on delete cascade,
  company_id  uuid not null,
  kind        text not null,
  detail      text,
  created_at  timestamptz not null default now()
);

alter table public.live_session_events
  drop constraint if exists live_session_events_kind,
  add constraint live_session_events_kind
    check (kind in (
      'conversation_started',
      'end_pressed',
      'provider_end_reported',
      'provider_error',
      'connection_lost',
      'tab_closed',
      'timer_reached',
      'video_saved'
    ));

-- provider_end_reported carries the provider's end_reason as one of these codes
-- (anything else is 'other'); provider_error carries 'error'; no other kind
-- carries a detail.
alter table public.live_session_events
  drop constraint if exists live_session_events_detail,
  add constraint live_session_events_detail
    check (
      case kind
        when 'provider_end_reported' then
          detail in ('completed', 'completed_not_graceful', 'candidate_left', 'timed_out', 'other')
        when 'provider_error' then detail = 'error'
        else detail is null
      end
    );

create index if not exists live_session_events_session
  on public.live_session_events (session_id, created_at);
create index if not exists live_session_events_company
  on public.live_session_events (company_id);

drop trigger if exists live_session_events_company on public.live_session_events;
create trigger live_session_events_company
  before insert on public.live_session_events
  for each row execute function public.live_scoring_session_company();

-- The database stamps the time.
create or replace function public.live_session_events_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists live_session_events_stamp on public.live_session_events;
create trigger live_session_events_stamp
  before insert on public.live_session_events
  for each row execute function public.live_session_events_stamp();

-- Append-only: never updated; deleted only once its session is gone.
create or replace function public.live_session_events_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'live_session_events is append-only: rows are never updated';
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'live_session_events is append-only: never truncated';
  end if;
  if exists (select 1 from public.interview_sessions where id = old.session_id) then
    raise exception 'live_session_events is append-only: a row goes only with its session';
  end if;
  return old;
end;
$$;

drop trigger if exists live_session_events_no_update on public.live_session_events;
create trigger live_session_events_no_update
  before update on public.live_session_events
  for each row execute function public.live_session_events_append_only();

drop trigger if exists live_session_events_no_delete on public.live_session_events;
create trigger live_session_events_no_delete
  before delete on public.live_session_events
  for each row execute function public.live_session_events_append_only();

drop trigger if exists live_session_events_no_truncate on public.live_session_events;
create trigger live_session_events_no_truncate
  before truncate on public.live_session_events
  for each statement execute function public.live_session_events_append_only();

alter table public.live_session_events enable row level security;

commit;
