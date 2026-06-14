-- ============================================================================
-- Migration 014 — talent_profiles boolean flags
-- ----------------------------------------------------------------------------
-- ALREADY APPLIED to dev + production via the Supabase SQL Editor. This file
-- exists so a fresh re-apply of the migrations/ folder against a clean
-- database recreates the same schema state, and so the change is tracked in
-- the codebase.
--
-- Why: replaces the single `status` text column with four orthogonal
-- booleans so we can compose states correctly (paused + shortlisted is a
-- valid combo today but the enum couldn't represent it). The `status`
-- column is preserved for now — both shapes coexist during the cutover
-- window. A later migration drops it.
--
-- Semantics:
--   pending          = approved_at IS NULL
--   approved         = approved_at IS NOT NULL
--   is_shortlisted   = admin marked candidate as in-progress with a client
--   is_placed        = candidate accepted an offer (mutually exclusive with
--                      is_shortlisted; the actions layer enforces this)
--   is_paused        = candidate or admin paused the profile (hidden, can
--                      resume later)
--   is_archived      = soft-delete / review-failed (hidden, requires explicit
--                      un-archive to re-surface)
--   public visible   = approved_at IS NOT NULL
--                      AND is_paused = false
--                      AND is_archived = false
-- ============================================================================

alter table talent_profiles
  add column if not exists is_shortlisted boolean not null default false,
  add column if not exists is_placed      boolean not null default false,
  add column if not exists is_paused      boolean not null default false,
  add column if not exists is_archived    boolean not null default false;

-- Backfill from the legacy status enum. Order matters — paused/archived take
-- precedence over placed/shortlisted because the public-visibility filter
-- gates on the former.
update talent_profiles set is_shortlisted = true where status = 'shortlisted';
update talent_profiles set is_placed      = true where status = 'placed';
update talent_profiles set is_paused      = true where status = 'paused';
update talent_profiles set is_archived    = true where status = 'archived';

-- Partial index supporting the common public-visibility predicate. The
-- browse-talent + ai-matching + /talent/[id] queries all match this shape.
create index if not exists idx_talent_profiles_public_visible
  on talent_profiles (approved_at, is_paused, is_archived)
  where approved_at is not null and is_paused = false and is_archived = false;
