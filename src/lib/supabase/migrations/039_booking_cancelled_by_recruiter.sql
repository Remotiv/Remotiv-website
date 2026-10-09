-- ============================================================================
-- Migration 039 - interview_bookings.cancelled_by accepts 'recruiter'
-- ----------------------------------------------------------------------------
-- Run by hand in Supabase on 2026-10-09. Recruiter-side cancel always failed:
-- cancelled_by_check allowed only candidate/company while the code writes
-- 'recruiter' (cancelBooking in src/lib/calendar/bookings.ts).
-- ============================================================================

begin;

alter table public.interview_bookings
  drop constraint interview_bookings_cancelled_by_check,
  add constraint interview_bookings_cancelled_by_check
    check (cancelled_by in ('candidate', 'company', 'recruiter'));

commit;
