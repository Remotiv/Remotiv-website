-- ============================================================================
-- Migration 036 — remove the interview and booking tokens 026 could not reach
-- ----------------------------------------------------------------------------
-- NOT RUN BY ANY CODE PATH. Applied by hand in the Supabase SQL editor.
--
-- ── Why 026 was not enough ───────────────────────────────────────────────────
--
-- 026 scrubbed the rows that existed when it ran, on the understanding that the
-- application now stored a redacted copy. It did not. deliverEmail has two
-- inserts into communication_logs, and the first S2 fix redacted only one of
-- them: the daily-cap insert, which almost never runs. The normal send stored
-- the rendered email as it was, live interview link included. Every invite sent
-- after 026 was therefore stored raw.
--
-- The code now redacts inside the one email insert (writeCommunicationLog) and
-- at both WhatsApp writes, and communication-log-writes.test.ts fails on any
-- write to this column that does not go through the redactor.
--
-- What this finds, read-only, on 2026-10-01: two rows. Both are interview
-- invitations sent by email on 2026-09-29, both sessions since submitted, so
-- neither token opens anything today. No booking link is stored raw. No
-- WhatsApp body carries a link.
--
-- ── Order ────────────────────────────────────────────────────────────────────
--
-- Deploy the code first, then run this. Run it before the deploy and any invite
-- sent in between is stored raw again; running it twice is harmless.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- Same limits as 026. It scrubs this database only. Resend keeps the full sent
-- body, and the token is in the request logs of whatever served the click. The
-- unsubscribe footer is left alone, for the reason 026 gives.
--
-- ── Idempotent ───────────────────────────────────────────────────────────────
--
-- The same statements as 026, unchanged, so code, 026 and this file agree on
-- what a token is: a run of 20 or more [A-Za-z0-9_-] directly after
-- "/interview/" or "/book/". "[link-removed]" starts with "[", so a redacted
-- row never matches and a second run updates nothing.
-- ============================================================================

-- 0. Look first. Expected on 2026-10-01: tokened_rows 2, interview_links 2,
--    booking_links 0, sent_rows 2, whatsapp_rows 0.
select count(*)                                                       as tokened_rows,
       count(*) filter (where body ~ '/interview/[A-Za-z0-9_-]{20,}')  as interview_links,
       count(*) filter (where body ~ '/book/[A-Za-z0-9_-]{20,}')       as booking_links,
       count(*) filter (where status = 'sent')                          as sent_rows,
       count(*) filter (where channel = 'whatsapp')                     as whatsapp_rows,
       min(created_at)                                                  as oldest,
       max(created_at)                                                  as newest
  from public.communication_logs
 where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}';

-- 1. Redact. Only rows that still carry a token are touched. Expect UPDATE 2.
update public.communication_logs
   set body = regexp_replace(
         regexp_replace(body, '(/interview/)[A-Za-z0-9_-]{20,}', '\1[link-removed]', 'g'),
         '(/book/)[A-Za-z0-9_-]{20,}', '\1[link-removed]', 'g')
 where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}';

-- 2. Confirm. Expect tokened_rows 0. redacted_rows was 29 after 026, so expect
--    31 now, or more if invites were sent after the deploy.
select count(*) filter (where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}') as tokened_rows,
       count(*) filter (where body like '%[link-removed]%')                   as redacted_rows
  from public.communication_logs;
