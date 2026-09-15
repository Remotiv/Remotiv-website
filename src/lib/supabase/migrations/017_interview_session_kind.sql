-- ============================================================================
-- Migration 017 — interview_sessions.kind
-- ----------------------------------------------------------------------------
-- Which interview option a session is: 'async' (the shipped one-way recording)
-- or 'live' (AI Video Interview). Set at invite, never changed.
--
-- WHY A COLUMN AND NOT A FLAG READ OFF THE JOB. A job may run BOTH options
-- (AI-VIDEO-INTERVIEW-PHASE-1.md, decision 1), so the job cannot say which one
-- a given session is. And the one-open-session-per-application rule in
-- sendInterviewInvite cancels the previous open session when a new invite is
-- sent — without a kind, an Async invite followed by a Live invite for the same
-- shortlisted candidate cancels the Async one. The rule becomes per
-- (application_id, kind), which needs the column.
--
-- BACKFILL IS THE DEFAULT. Every session that exists today is async — the live
-- option has never sent an invite — so `default 'async'` is the backfill, with
-- no UPDATE and no window where a row has no kind. The default stays after the
-- backfill deliberately: any writer that predates this column keeps producing
-- correct async rows rather than failing NOT NULL.
--
-- "NEVER CHANGED" IS ENFORCED, NOT DOCUMENTED. A trigger refuses any UPDATE
-- that alters kind. Positions, storage paths, the scorer's prompt and the
-- review screen all branch on it; a session that changed kind mid-life would
-- have half its rows written under each set of assumptions.
-- ============================================================================

alter table public.interview_sessions
  add column if not exists kind text not null default 'async';

alter table public.interview_sessions
  drop constraint if exists interview_sessions_kind_check;

alter table public.interview_sessions
  add constraint interview_sessions_kind_check
  check (kind in ('async', 'live'));

-- The supersede lookup and the drawer's "latest session" read both filter on
-- application_id (+ company_id) and take the newest. They now filter on kind
-- too. idx_is_application (application_id) is superseded by this one for those
-- reads; left in place — dropping an index is a separate, deliberate step.
create index if not exists idx_is_application_kind
  on public.interview_sessions (application_id, kind, created_at desc);

create or replace function public.interview_sessions_kind_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'interview_sessions.kind is set at invite and cannot be changed (session %, % -> %)',
      old.id, old.kind, new.kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists interview_sessions_kind_immutable on public.interview_sessions;

create trigger interview_sessions_kind_immutable
  before update of kind on public.interview_sessions
  for each row
  execute function public.interview_sessions_kind_immutable();

-- ----------------------------------------------------------------------------
-- OPTIONAL, and NOT part of this migration — see the report.
--
-- The one-open-session-per-(application, kind) rule is enforced in application
-- code (read newest, cancel it, insert). A partial unique index would make the
-- database enforce it too and close the read-then-insert race:
--
--   create unique index interview_sessions_one_open_per_kind
--     on public.interview_sessions (application_id, kind)
--     where status in ('invited', 'started');
--
-- It is NOT included here because CREATE UNIQUE INDEX fails if any application
-- already has two open sessions, and that has to be checked on live data first
-- (query in the report). Add it as 018 once the check comes back clean.
-- ----------------------------------------------------------------------------
