-- ============================================================================
-- Migration 026 — remove interview and booking tokens from stored email bodies
-- ----------------------------------------------------------------------------
-- communication_logs.body keeps the rendered HTML of every candidate email,
-- exactly as Resend received it. For an interview invitation and a booking
-- link that HTML contains the raw bearer token in the URL path — the same
-- token whose hash is all that interview_sessions / interview_bookings store.
-- So the secret those tables were careful not to keep sat in plaintext one
-- table over, for the life of the row, readable by anyone with the service
-- key, a backup, or an RLS gap on this table.
--
-- The application now stores a redacted copy (src/lib/candidate-links.ts,
-- redactCandidateLinks, called from deliverEmail): the token segment becomes
-- the literal "[link-removed]". This file applies the same replacement to the
-- rows written before that code existed.
--
-- Run by hand in the Supabase SQL editor, like the files before it. Deploy
-- the code first, then run this; the order only matters so that no new raw
-- row is written after the backfill. Redaction is one-way and nothing reads a
-- token back out of this table, so there is no window in which anything
-- breaks. The Messages pane already strips every tag before display, so what
-- a recruiter sees is byte-identical before and after.
--
-- ── What this does NOT do ────────────────────────────────────────────────────
--
-- It scrubs OUR database. Resend holds the full sent body, live token
-- included, for every one of these emails on the provider side, and the token
-- is a URL path, so it is in the request logs of whatever served the click.
-- "[link-removed]" in a row means the link was removed from THIS copy, not
-- that the link is gone.
--
-- The unsubscribe footer's token is left in place on purpose. It is an HMAC
-- claim over company + email (see S6 for its own fix); its worst case is one
-- candidate's opt-out, and the queued rows that "send now" re-delivers need a
-- working footer.
--
-- ── Schema drift, for the record ─────────────────────────────────────────────
--
-- communication_logs has NO DDL anywhere in this repository — not in
-- schema.sql, not in any migration. The table exists only in the live
-- database (215 rows when this was written), together with its UNIQUE
-- constraint communication_logs_application_event_channel_uniq, which
-- deliverEmail's duplicate handling relies on, and whatever CHECK `event`
-- carries — the code comments disagree (deliver.ts says none, calendar/notify.ts
-- says one), and there is no DDL to settle it. Nobody can recreate it from
-- the repo. That belongs to the schema-drift finding, not to
-- this migration; it is noted here because this is the first file to touch
-- the table and the next person to look for its definition will land here.
--
-- ── Idempotent ───────────────────────────────────────────────────────────────
--
-- A token is 43 chars of base64url; the pattern needs a run of 20 or more
-- [A-Za-z0-9_-] directly after "/interview/" or "/book/". "[link-removed]"
-- starts with "[", so a redacted row never matches. Running this twice
-- updates zero rows the second time. The pattern is the same one
-- candidate-links.ts compiles, so code and backfill agree on what a token is.
-- ============================================================================

-- 0. Look first. Expected when this was written: 29 rows (24 interview,
--    5 booking), all status = 'sent', none with a still-live token.
select count(*)                                                       as tokened_rows,
       count(*) filter (where body ~ '/interview/[A-Za-z0-9_-]{20,}')  as interview_links,
       count(*) filter (where body ~ '/book/[A-Za-z0-9_-]{20,}')       as booking_links,
       count(*) filter (where status = 'sent')                          as sent_rows
  from public.communication_logs
 where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}';

-- 1. Redact. Only rows that still carry a token are touched.
update public.communication_logs
   set body = regexp_replace(
         regexp_replace(body, '(/interview/)[A-Za-z0-9_-]{20,}', '\1[link-removed]', 'g'),
         '(/book/)[A-Za-z0-9_-]{20,}', '\1[link-removed]', 'g')
 where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}';

-- 2. Confirm. Expect tokened_rows = 0 and redacted_rows = the count from step 0.
select count(*) filter (where body ~ '/(interview|book)/[A-Za-z0-9_-]{20,}') as tokened_rows,
       count(*) filter (where body like '%[link-removed]%')                   as redacted_rows
  from public.communication_logs;
