-- ============================================================================
-- Migration 069 - a live interview's end can be stamped at the moment the
--                 backstop was due, not only at now() (#17)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production. Replaces one trigger
-- function from migration 044; the trigger itself is unchanged.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- A live call that runs over its time limit is ended by the server's backstop
-- (lib/interviews/live-events.ts): when a report, a video request or the
-- worker's sweep finds it past started_at + its limit + the 10-minute grace.
-- The 30-minute windows for late reports and video pieces run from
-- live_ended_at. 044 stores now() for ANY value written, so the end was the
-- moment the backstop happened to NOTICE the overrun: a request arriving a day
-- later stamped "now" and opened a fresh 30 minutes. The backend now writes
-- the due time; this lets that value stand.
--
-- ── The rule ─────────────────────────────────────────────────
--
-- Unchanged from 044: set once, never changed or cleared; a terminal status
-- with no end stamps now(); a value written for a non-live session is refused
-- by the existing check constraint.
--
-- Changed: a value written by the server is KEPT when it is not in the future
-- and not before the session's started_at, so it can only move the end
-- earlier, never later, and never before the call began. Anything else
-- (future, before the start, no started_at) still becomes now(), as in 044.
-- Only server code writes interview_sessions (service role; RLS has no
-- policies for it), and the only writers are stampLiveEnded's callers.
-- ============================================================================

create or replace function public.interview_sessions_live_ended()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.live_ended_at is not null then
    if new.live_ended_at is distinct from old.live_ended_at then
      raise exception 'interview_sessions: live_ended_at is set once and never changed or cleared';
    end if;
    return new;
  end if;
  if new.live_ended_at is not null then
    -- #17: a past end within the call (the backstop's due time) stands.
    if not (new.started_at is not null
            and new.live_ended_at >= new.started_at
            and new.live_ended_at <= now()) then
      new.live_ended_at := now();
    end if;
  elsif new.status in ('submitted', 'expired', 'cancelled', 'abandoned') then
    new.live_ended_at := now();
  end if;
  return new;
end;
$$;
