-- ============================================================================
-- Migration 020 — live interview restart: interview_sessions.attempt,
--                 previous_attempt_id, and the 'abandoned' status
-- ----------------------------------------------------------------------------
-- Reconnecting is cut from Phase 1. A live interview whose connection drops is
-- ABANDONED: the partial attempt is never scored, never combined with another,
-- and the candidate may restart ONCE.
--
-- ── A restart is a new session, not an attempt number ────────
--
-- The alternative was an `attempt` column on turns and answers under the SAME
-- session. Every reader in the interview pipeline keys on session_id: the
-- (session_id, position) unique on interview_answers, the video paths, the
-- transcription trigger, the scorer, the review screen, both score tables.
-- With attempts inside a session, every one of those reads must ALSO filter on
-- attempt, and one missed filter silently merges two attempts into one
-- scorecard — the exact thing the Phase 1 decision forbids. As a new session,
-- the partial attempt is excluded by construction: nothing that reads the
-- restart can see its rows.
--
-- So `attempt` lives HERE, on the session, and only to cap restarts and link
-- the two rows. interview_turns and interview_answers carry no attempt.
--
-- ── Why 'abandoned' and not 'cancelled' ──────────────────────
--
-- 'cancelled' means the recruiter superseded an invite. 'abandoned' means the
-- candidate started and the call dropped. The review screen shows them
-- differently (below), and a status that meant both could not.
--
-- ── What keeps an abandoned attempt out of scoring ───────────
--
-- Scoring already requires status = 'submitted', at the trigger
-- (lib/interviews/transcribe.ts) and in the scorer (lib/ai/interview-scoring.ts).
-- The trigger below makes 'abandoned' TERMINAL, so an abandoned attempt can
-- never become submitted — not by a late submit, not by a bug. Every existing
-- status writer (submit, expiry, confirm, cancel) is guarded on the current
-- status and none of them matches 'abandoned', so none of them can trip it.
--
-- Late provider events for a dropped call are STORED on the abandoned session
-- (interview_turns, migration 021) so the provider's retries settle and its
-- deletion proceeds. Nothing reads them: no scorer, no review screen.
--
-- ── What the review screen must do — CODE, NOT THIS MIGRATION ──
--
-- Ship these with the restart path, not after it:
--   · lib/interviews/types.ts and review-types.ts: add 'abandoned'.
--   · review.ts deriveStatus: handle 'abandoned' FIRST. Today an unknown status
--     falls through to "invited", so without this an abandoned attempt would
--     be shown to a recruiter as a pending invite.
--   · A first attempt that HAS a restart is hidden from the list.
--   · A final abandoned attempt is shown as "Interview interrupted — not
--     scored", with no transcript and no video.
--   · expiry.ts SETTLED_STATUSES: add 'abandoned'.
--   · Turn transcription skips abandoned sessions.
--   · deleteInterview removes BOTH attempts. The FK below refuses deleting a
--     first attempt that a restart points at, so deleting the visible restart
--     alone would strand the hidden first attempt and its media.
--   · The token handoff: one database function, called at restart, that moves
--     the candidate's token_hash onto the new session and gives the abandoned
--     one a hash nobody holds, in a single transaction. Added with the code
--     that calls it, as 019 did for provider_deleted_at.
--
-- Until that code ships nothing writes 'abandoned' or attempt = 2, so running
-- this changes no behaviour. Every existing row is attempt 1 with no link, and
-- every existing status is already in the new list.
-- ============================================================================

alter table public.interview_sessions
  add column if not exists attempt smallint not null default 1,
  add column if not exists previous_attempt_id uuid;

-- NO ACTION (the default), not CASCADE and not RESTRICT. NO ACTION is checked at
-- the end of the statement, so one statement that removes both attempts
-- succeeds; deleting a first attempt on its own while
-- its restart still points at it is refused.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_previous_attempt_fk;
alter table public.interview_sessions
  add constraint interview_sessions_previous_attempt_fk
  foreign key (previous_attempt_id) references public.interview_sessions (id);

-- One restart: two attempts, ever.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_attempt_range;
alter table public.interview_sessions
  add constraint interview_sessions_attempt_range
  check (attempt in (1, 2));

-- Attempt 1 has no predecessor; attempt 2 always has one.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_attempt_link;
alter table public.interview_sessions
  add constraint interview_sessions_attempt_link
  check ((attempt = 1) = (previous_attempt_id is null));

-- An async interview has nothing to restart.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_attempt_live_only;
alter table public.interview_sessions
  add constraint interview_sessions_attempt_live_only
  check (kind = 'live' or attempt = 1);

-- One restart per first attempt, enforced by the database rather than by the
-- read-then-insert in application code.
create unique index if not exists interview_sessions_one_restart
  on public.interview_sessions (previous_attempt_id)
  where previous_attempt_id is not null;

-- Name confirmed against the live database. Previously allowed invited,
-- started, submitted, expired, cancelled.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_status_check;
alter table public.interview_sessions
  add constraint interview_sessions_status_check
  check (status in ('invited', 'started', 'submitted', 'expired', 'cancelled', 'abandoned'));

alter table public.interview_sessions
  drop constraint if exists interview_sessions_abandoned_live_only;
alter table public.interview_sessions
  add constraint interview_sessions_abandoned_live_only
  check (status <> 'abandoned' or kind = 'live');

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

  -- A restart is the same interview run again: same candidate, same frozen
  -- settings and questions, same deadline, same retention date. Rebuilding any
  -- of them from the live job would let a job edit reach an interview already
  -- in flight, and a fresh deadline would turn a dropped call into an extension.
  if (new.company_id, new.application_id, new.job_id, new.kind)
       is distinct from (prev.company_id, prev.application_id, prev.job_id, prev.kind)
     or new.questions_snapshot is distinct from prev.questions_snapshot
     or new.live_settings is distinct from prev.live_settings
     or new.expires_at is distinct from prev.expires_at
     or new.delete_after is distinct from prev.delete_after then
    raise exception 'interview_sessions: a restart must copy its first attempt''s candidate, settings, questions and deadline unchanged (previous %)',
      prev.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists interview_sessions_attempt_rules on public.interview_sessions;

create trigger interview_sessions_attempt_rules
  before insert or update on public.interview_sessions
  for each row
  execute function public.interview_sessions_attempt_rules();
