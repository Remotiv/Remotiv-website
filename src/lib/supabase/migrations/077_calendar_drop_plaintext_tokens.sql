-- ============================================================================
-- Migration 077 - drop the plaintext calendar token columns (#68, 12f)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production.
--
-- Requires, in this order:
--   1. 12e deployed and its data step done: every row sealed, both plaintext
--      columns NULL (verified on production 24 Nov: 2 rows, 0 plaintext);
--   2. the 12f code DEPLOYED. The 12e code still writes NULL to these two
--      columns on every connect and refresh; with them gone, PostgREST refuses
--      that write (unknown column) and every connect and refresh fails. The
--      12f code names neither column, so it runs on a database with or
--      without them.
--
-- ── What ─────────────────────────────────────────────────────
--
-- The two columns that held Google tokens as issued. The sealed copies
-- (access_token_enc, refresh_token_enc, token_key_id; migration 073) are the
-- only store from 12e on. No other object depends on these columns: migration
-- 072 keeps the table out of every function, view and policy body
-- (connections-service-only.test.ts, S3).
--
-- Not reversible from the database: a dropped column's data is gone. The 12e
-- backup is the only copy of the old plaintext; delete it once this is
-- verified.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- `drop column if exists` throughout.
-- ============================================================================

begin;

alter table public.calendar_connections
  drop column if exists access_token,
  drop column if exists refresh_token;

commit;
