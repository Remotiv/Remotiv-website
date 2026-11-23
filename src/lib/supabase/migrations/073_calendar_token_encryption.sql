-- ============================================================================
-- Migration 073 - room for encrypted Google Calendar tokens (#68, step 12a)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- A connected calendar's access and refresh tokens are stored in the clear
-- (access_token, refresh_token). Anyone who can read the table, or a dump or
-- backup of it, can act on the host's Google Calendar until the grant is
-- revoked. Step 12 seals them with AES-256-GCM in the app
-- (lib/calendar/token-crypto.ts), under keys that never reach the database.
--
-- ── What (12a: additive only) ────────────────────────────────
--
-- Three nullable columns, and nothing else:
--   access_token_enc   the sealed access token (token-crypto.ts seal())
--   refresh_token_enc  the sealed refresh token, null when there is none
--   token_key_id       which key sealed them, so a rotation can find the
--                      rows still on an old key
-- No row is changed, nothing is dropped, and access_token keeps its NOT NULL:
-- the app still reads and writes the plaintext columns until 12b (dual write)
-- and 12c (read sealed, backfill, then clear and relax the old columns).
--
-- Column comments are kept here, not as COMMENT ON statements: migration 072
-- keeps this table out of every statement but ALTER, REVOKE and GRANT
-- (connections-service-only.test.ts, S3), and this does not widen that.
--
-- 072's grants are unchanged: new columns inherit the table's privileges,
-- which 072 left to service_role alone.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- `add column if not exists` throughout.
-- ============================================================================

begin;

alter table public.calendar_connections
  add column if not exists access_token_enc text,
  add column if not exists refresh_token_enc text,
  add column if not exists token_key_id text;

commit;
