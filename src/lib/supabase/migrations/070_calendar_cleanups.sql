-- ============================================================================
-- Migration 070 - a lasting alert for calendar events a deleted applicant may
--                 have left in a host's Google Calendar (#56)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production. Apply BEFORE deploying the
-- code that reads it: the applicant delete refuses (and says why) when it
-- cannot record a cleanup, so without this table an applicant whose host's
-- calendar is no longer connected cannot be deleted. The two new columns are
-- written in writes of their own that only log on failure, so connecting a
-- calendar and booking keep working either way.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- An applicant delete goes ahead when the host's calendar is no longer
-- connected, because nothing can reach the event. The event may still be in
-- the host's Google Calendar. One row per such event is kept here, and the
-- company's notification bell shows it to the owners, the admins and the host
-- until it is dealt with (lib/calendar/cleanups.ts):
--
--   pending   written by the delete before anything is removed, with the
--             application id; never shown. The id references the applicant
--             ON DELETE SET NULL, so it turns NULL in the very statement that
--             deletes the applicant: a delete that fails leaves it set, and
--             no alert says "deleted applicant" about someone still there.
--   open      the applicant is gone (pending with a NULL id): shown, pinned,
--             until resolved.
--   resolved  "Mark as removed" (owner, admin or host), or the host
--             reconnected the SAME Google account and the silent delete was
--             confirmed. Deleted after 30 days by the worker.
--
-- ── What a row holds ─────────────────────────────────────────
--
-- No candidate data: the company, the host (and a snapshot of their display
-- name, so the alert stays actionable after they leave), the provider,
-- Google's event id, the calendar, the event's start, and an HMAC of the
-- account (never the address or the id in the clear; lib/calendar/
-- account-key.ts). The application id only while pending, cleared by the
-- applicant's deletion itself.
--
-- Google event ids are unique per calendar, not globally, so the unique key is
-- (company, provider, account key, calendar, event id). A retried delete
-- writes nothing twice.
--
-- ── Who can read it ──────────────────────────────────────────
--
-- RLS on, no policies, no grants to anon or authenticated: only the server
-- (service role) reads or writes it, and every read and write there filters on
-- the company. Same as interview_bookings, calendar_connections and
-- notifications_company.
--
-- ── Also ─────────────────────────────────────────────────────
--
-- calendar_connections.provider_account_key and
-- interview_bookings.provider_account_key: the same account HMAC, on the
-- connection when it is made and on each booking when its event is created,
-- so a cleanup knows which account holds its event. '' = unknown (rows made
-- before this, or no secret): such a cleanup is only ever resolved by hand.
--
-- Nothing existing is changed or backfilled.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- `if not exists` / `create or replace` throughout; the policies-free RLS,
-- the revokes and the grants are idempotent.
-- ============================================================================

begin;

alter table public.calendar_connections
  add column if not exists provider_account_key text not null default '';

alter table public.interview_bookings
  add column if not exists provider_account_key text not null default '';

create table if not exists public.calendar_cleanups (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies(id) on delete cascade,
  -- Set null when the member leaves: the alert stays, for owners and admins.
  host_member_id         uuid references public.company_members(id) on delete set null,
  host_name_snapshot     text,
  provider               text not null,
  account_key            text not null default '',
  calendar_id            text not null default 'primary',
  provider_event_id      text not null,
  event_start            timestamptz,
  status                 text not null default 'pending',
  -- While pending only. ON DELETE SET NULL: deleting the applicant clears it
  -- in the same statement, which is how the app knows the delete succeeded.
  pending_application_id uuid references public.job_applications(id) on delete set null,
  activated_at           timestamptz,
  resolution             text,
  resolved_at            timestamptz,
  resolved_by_member_id  uuid references public.company_members(id) on delete set null,
  last_attempt_at        timestamptz,
  last_error_code        text,
  created_at             timestamptz not null default now(),

  constraint calendar_cleanups_provider check (provider = 'google'),
  constraint calendar_cleanups_event_id check (length(btrim(provider_event_id)) > 0),
  constraint calendar_cleanups_status check (status in ('pending', 'open', 'resolved')),
  constraint calendar_cleanups_resolution check (
    resolution is null or resolution in ('marked_removed', 'deleted_on_reconnect')
  ),
  -- Each state carries exactly its own facts.
  constraint calendar_cleanups_state check (
    (status = 'pending'  and resolved_at is null and resolution is null)
    or (status = 'open'     and pending_application_id is null and resolved_at is null and resolution is null)
    or (status = 'resolved' and pending_application_id is null and resolved_at is not null and resolution is not null)
  ),
  constraint calendar_cleanups_one_per_event
    unique (company_id, provider, account_key, calendar_id, provider_event_id)
);

create index if not exists calendar_cleanups_open_company
  on public.calendar_cleanups (company_id, host_member_id) where status = 'open';
create index if not exists calendar_cleanups_sweep
  on public.calendar_cleanups (last_attempt_at nulls first) where status = 'open';
create index if not exists calendar_cleanups_pending
  on public.calendar_cleanups (company_id, pending_application_id) where status = 'pending';
create index if not exists calendar_cleanups_resolved
  on public.calendar_cleanups (resolved_at) where status = 'resolved';

alter table public.calendar_cleanups enable row level security;
revoke all on table public.calendar_cleanups from public;
revoke all on table public.calendar_cleanups from anon, authenticated;
grant select, insert, update, delete on table public.calendar_cleanups to service_role;

-- The worker's sweep (lib/calendar/cleanups.ts) works one company at a time,
-- every read and write on that company. This is its only step that looks
-- across companies, and it returns company ids that have work, nothing else:
-- pending rows whose applicant is gone, open rows, and resolved rows past 30
-- days. Server only.
--
-- SECURITY INVOKER on purpose, not DEFINER: its only caller is the service
-- role, which already reads this table, so running as the owner would add no
-- access the caller needs and would turn any grant that slipped into a read
-- around RLS. Empty search_path, schema-qualified names; EXECUTE for
-- service_role only (Supabase's default privileges grant it to anon and
-- authenticated on new public functions, so both are revoked explicitly).
create or replace function public.calendar_cleanup_companies(p_limit integer)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct c.company_id
    from public.calendar_cleanups c
   where (c.status = 'pending' and c.pending_application_id is null)
      or c.status = 'open'
      or (c.status = 'resolved' and c.resolved_at < now() - interval '30 days')
   limit greatest(1, least(p_limit, 500));
$$;
revoke all on function public.calendar_cleanup_companies(integer) from public;
revoke all on function public.calendar_cleanup_companies(integer) from anon, authenticated;
grant execute on function public.calendar_cleanup_companies(integer) to service_role;

comment on table public.calendar_cleanups is
  '#56: calendar events a deleted applicant may have left in a host''s Google Calendar. No candidate data. Server only.';

commit;
