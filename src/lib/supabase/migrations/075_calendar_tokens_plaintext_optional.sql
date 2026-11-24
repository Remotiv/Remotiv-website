-- ============================================================================
-- Migration 075 - calendar tokens no longer need a plaintext copy (#68, 12e)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production.
--
-- Apply BEFORE deploying the 12e code. From 12e the app writes NULL to
-- access_token and refresh_token on every write (the sealed copies are the
-- only store), and access_token is NOT NULL until this runs, so 12e code on a
-- database without it fails every connect and refresh. This is safe under the
-- code already deployed: dropping NOT NULL changes nothing for a writer that
-- still sends a value.
--
-- ── What ─────────────────────────────────────────────────────
--
-- access_token loses its NOT NULL. refresh_token is already nullable
-- (production schema dump), so it is not touched. No row is changed: the
-- plaintext already stored is emptied by the 12e data step, run by hand after
-- a backup, and the two columns are dropped in 12f.
--
-- Comments here, not COMMENT ON: migration 072 keeps this table out of every
-- statement but ALTER, REVOKE and GRANT (connections-service-only.test.ts,
-- S3). 072's grants are unchanged.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- Dropping a NOT NULL that is already gone is a no-op.
-- ============================================================================

begin;

alter table public.calendar_connections
  alter column access_token drop not null;

commit;
