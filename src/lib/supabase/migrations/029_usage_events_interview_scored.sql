-- ============================================================================
-- Migration 029 — usage_events.type: add interview_scored
-- ----------------------------------------------------------------------------
-- Step 0 (run by hand on 2026-09-30) showed usage_events_type_check allowing
-- exactly six values:
--   interview_sent, interview_completed, cv_scored, message_sent,
--   live_minutes, whatsapp_sent
-- Of those, only cv_scored and whatsapp_sent have ever been written. The code,
-- meanwhile, emits three via recordUsage: cv_scored, whatsapp_sent and
-- interview_scored — and interview_scored is not in the list, so every
-- interview scorecard's metering insert has been rejected (SQLSTATE 23514)
-- and swallowed by recordUsage since interview scoring began. The admin
-- analytics rollup already queries interview_scored and has been reporting
-- zero for it.
--
-- Four allowed values have never been used; one used value was never allowed.
-- The vocabulary and the code drifted in both directions because neither is
-- in the repository: there is no DDL for usage_events here, the same drift
-- already recorded for communication_logs and background_jobs.
--
-- This preserves ALL SIX existing values — nothing is removed, including the
-- four unused ones, because a value in a live CHECK is a promise some caller
-- may rely on — and adds the one the code emits. Idempotent: dropping IF
-- EXISTS and re-adding the same definition twice leaves the same constraint.
--
-- Run by hand in the Supabase SQL editor. Nothing in the repository executes
-- it. Until it runs, interview metering stays lost and is logged as
-- "[usage] REJECTED type=interview_scored (23514)".
-- ============================================================================

-- 0. Look first. Expect one row, the six-value definition above.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.usage_events'::regclass
   and contype = 'c';

begin;

alter table public.usage_events
  drop constraint if exists usage_events_type_check;

alter table public.usage_events
  add constraint usage_events_type_check
  check (type in (
    'interview_sent',
    'interview_completed',
    'cv_scored',
    'message_sent',
    'live_minutes',
    'whatsapp_sent',
    'interview_scored'
  ));

commit;

-- 1. Confirm: seven values.
select pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.usage_events'::regclass
   and conname = 'usage_events_type_check';
