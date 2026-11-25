-- ============================================================================
-- Migration 079 - WhatsApp is strictly opt-in, per application (#67 part 1)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor, BEFORE the code that ships with it is pushed: /api/apply writes
-- these two columns on every application and the WhatsApp dispatcher reads
-- them before every send, so that code fails against a table without them.
-- The old code never names them, so running this first changes nothing for it.
--
-- ── The rule (decided 25 Nov 2026) ───────────────────────────
--
-- A candidate gets WhatsApp only if they ticked the opt-in box on the apply
-- form. Otherwise email only, with no exceptions: interview invitations and
-- reminders included. A STOP received on WhatsApp still wins over a tick
-- (whatsapp_opt_outs, unchanged).
--
--   whatsapp_opt_in      true only when the candidate ticked the box
--   whatsapp_opt_in_at   when the application carrying that tick was received
--
-- The CHECK keeps the two together: a tick always has its time, and a time
-- never stands without a tick.
--
-- ── Existing applications ────────────────────────────────────
--
-- Every existing row gets false and NULL: nobody was asked, so nobody has
-- consented, and those candidates are emailed only. No row is backfilled to
-- true.
--
-- ── Safe to apply, safe to re-run ────────────────────────────
--
-- Two nullable-or-defaulted columns and one CHECK every existing row passes
-- (false, NULL). The default is a constant, so the column is added without a
-- table rewrite. No index, function, trigger, grant or policy is added or
-- changed; job_applications' existing policies cover the new columns.
-- ============================================================================

begin;

alter table public.job_applications
  add column if not exists whatsapp_opt_in boolean not null default false,
  add column if not exists whatsapp_opt_in_at timestamptz;

alter table public.job_applications
  drop constraint if exists job_applications_whatsapp_opt_in_at,
  add constraint job_applications_whatsapp_opt_in_at
    check (whatsapp_opt_in = (whatsapp_opt_in_at is not null));

comment on column public.job_applications.whatsapp_opt_in is
  'True only when the candidate ticked the WhatsApp opt-in box on the apply form (#67). False means email only.';
comment on column public.job_applications.whatsapp_opt_in_at is
  'When the application carrying the WhatsApp opt-in was received. NULL when whatsapp_opt_in is false.';

commit;
