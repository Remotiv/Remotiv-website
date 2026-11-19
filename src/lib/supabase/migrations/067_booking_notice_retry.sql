-- ============================================================================
-- Migration 067 - booking emails: one per booking EVENT, not one per
--                 applicant; and a safe Retry for a cancellation email that
--                 failed (#59, QA #104)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Approved 19 Nov 2026 to be WRITTEN, not applied. Apply by hand
-- in the Supabase SQL editor: STAGING first, then PRODUCTION, BEFORE the
-- application code that calls claim_failed_email_log is deployed. One paste,
-- one execution, one transaction.
--
-- ── 1. The index ─────────────────────────────────────────────
--
-- communication_logs_auto_event_uniq is UNIQUE on (application_id, event,
-- channel) for rows with no sender. Booking emails are such rows, so the
-- SECOND booking, reschedule or cancellation for one applicant was refused
-- with 23505 and the candidate was never told (staging, read-only, 19 Nov
-- 2026). booking_confirmed, booking_rescheduled and booking_cancelled leave
-- the index. Each is still sent once per booking EVENT, because each comes
-- from ONE conditional UPDATE with one winner:
--   booking_confirmed    claimSlot          status 'invited' -> 'booked'
--   booking_rescheduled  rescheduleBooking  'booked' AND the old start time
--   booking_cancelled    cancelBooking      'booked' -> 'cancelled'
-- (lib/calendar/bookings.ts). Only the winner sends.
--
-- Nothing depends on this index for ON CONFLICT: 059's first-attempt insert
-- relies on the 23505 itself (no ON CONFLICT), and booking emails are sent
-- inline, never claimed by claim_communication_log.
--
-- Production, read-only, 19 Nov 2026: 289 communication_logs rows. A normal
-- rebuild inside this transaction holds a write lock for milliseconds, so the
-- new index is created under a temporary name, the old one dropped and the new
-- one renamed, all or nothing. CONCURRENTLY is not needed (and cannot run
-- inside a transaction).
--
-- ── 2. claim_failed_email_log(p_id, p_company_id) ────────────
--
-- The Retry for one FAILED email row, by its id, with or without a sender.
-- Every time comparison is the database's clock (#85). Returns one row,
-- (out_outcome, out_attempt_started_at):
--   claimed       this call owns the row: status queued, attempt_started_at
--                 now(), error cleared. Only the claimer sends, and guards its
--                 sent / failed write on out_attempt_started_at
--   wrong_status  not 'failed': sent, or queued (its first send never
--                 answered, so it may have arrived: never resent), or claimed
--                 by another Retry a moment ago
--   too_old       failed more than 24 hours after it was created: Resend's
--                 idempotency key lasts 24 hours, so a resend is no longer
--                 provably the same message
--   missing       no email row with that id in that company
-- Two Retries at once: the row lock serialises them; the second re-reads the
-- row, sees 'queued' and answers wrong_status
-- (scripts/staging/checks-059-retry-claim.mjs, 19 Nov 2026).
--
-- SECURITY DEFINER, search_path = '', every reference schema-qualified.
-- EXECUTE for service_role only.
--
-- Rollback (revert the application code first: its Retry calls the function):
--   drop function public.claim_failed_email_log(uuid, uuid);
--   and the index, the other way round:
--   create unique index communication_logs_auto_event_uniq_old
--     on public.communication_logs (application_id, event, channel)
--     where sent_by_name is null;
--   (fails if two booking rows for one applicant now exist; that is the point
--   of this migration, so a rollback must first decide what to do with them)
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ── 1. the index, replaced in one transaction ──

create unique index communication_logs_auto_event_uniq_067
  on public.communication_logs (application_id, event, channel)
  where sent_by_name is null
    and event not in ('booking_confirmed', 'booking_rescheduled', 'booking_cancelled');

drop index public.communication_logs_auto_event_uniq;

alter index public.communication_logs_auto_event_uniq_067
  rename to communication_logs_auto_event_uniq;

-- ── 2. the Retry claim ──

create or replace function public.claim_failed_email_log(p_id uuid, p_company_id uuid)
returns table (out_outcome text, out_attempt_started_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  update public.communication_logs l
     set status = 'queued',
         attempt_started_at = pg_catalog.now(),
         error = null
   where l.id = p_id
     and l.company_id = p_company_id
     and l.channel = 'email'
     and l.status = 'failed'
     and l.created_at > pg_catalog.now() - interval '24 hours'
  returning l.attempt_started_at into r;
  if found then
    return query select 'claimed'::text, r.attempt_started_at;
    return;
  end if;

  select l.status
    into r
    from public.communication_logs l
   where l.id = p_id
     and l.company_id = p_company_id
     and l.channel = 'email';
  if not found then
    return query select 'missing'::text, null::timestamptz;
    return;
  end if;
  if r.status is distinct from 'failed' then
    return query select 'wrong_status'::text, null::timestamptz;
    return;
  end if;
  return query select 'too_old'::text, null::timestamptz;
end;
$$;

revoke all on function public.claim_failed_email_log(uuid, uuid) from public;
revoke all on function public.claim_failed_email_log(uuid, uuid) from anon, authenticated;
grant execute on function public.claim_failed_email_log(uuid, uuid) to service_role;

commit;

-- ── Post-check (read-only) ──────────────────────────────────────────────────
--
--   select indexdef from pg_catalog.pg_indexes
--    where schemaname = 'public' and indexname = 'communication_logs_auto_event_uniq';
--   -- Expect: ... (application_id, event, channel) WHERE ((sent_by_name IS NULL)
--   --         AND (event <> ALL (ARRAY['booking_confirmed'::text,
--   --         'booking_rescheduled'::text, 'booking_cancelled'::text])))
--
--   select p.prosecdef, p.proconfig,
--          pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--          pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_exec
--     from pg_catalog.pg_proc p
--    where p.oid = 'public.claim_failed_email_log(uuid, uuid)'::regprocedure;
--   -- Expect: true, {search_path=""}, false, false, true
