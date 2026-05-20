-- Migration 005: talent_profiles search + filter indexes
-- Date: 2026-05-19
-- Purpose: Phase 4 Bundle B (performance hardening). Today's /browse-talent
--   list query does (a) ILIKE %q% on 3 columns, (b) WHERE approved_at IS NOT
--   NULL, and (c) optional .eq(role_category). All three predicates are
--   unindexed and force full table scans. This migration adds:
--     1. pg_trgm extension (enables fast substring search via trigram GIN)
--     2. Three GIN trigram indexes for ILIKE on first_name/last_name/job_title
--     3. A partial B-tree index on approved_at WHERE approved_at IS NOT NULL
--     4. A B-tree index on role_category
--   These are read-only; no row data changes. Adds ~5-20 MB of index storage
--   per 10k rows (acceptable).
-- Safe to re-run (uses IF NOT EXISTS guards).

-- ============================================================================
-- 1. pg_trgm extension (one-time install; idempotent)
-- ============================================================================

create extension if not exists pg_trgm;

-- ============================================================================
-- 2. Trigram GIN indexes for ILIKE substring search on first_name/last_name/job_title
-- These accelerate the `.or(first_name.ilike.%q%, last_name.ilike.%q%,
-- job_title.ilike.%q%)` filter used by /browse-talent search.
-- gin_trgm_ops enables index usage for both LIKE and ILIKE with leading wildcards.
-- ============================================================================

create index if not exists talent_profiles_first_name_trgm_idx
  on public.talent_profiles
  using gin (first_name gin_trgm_ops);

create index if not exists talent_profiles_last_name_trgm_idx
  on public.talent_profiles
  using gin (last_name gin_trgm_ops);

create index if not exists talent_profiles_job_title_trgm_idx
  on public.talent_profiles
  using gin (job_title gin_trgm_ops);

-- ============================================================================
-- 3. Partial B-tree index on approved_at (only NOT NULL rows)
-- Today's list query filters `approved_at IS NOT NULL` for every request.
-- A partial index skips NULL rows entirely, shrinking the index and the scan.
-- ============================================================================

create index if not exists talent_profiles_approved_at_idx
  on public.talent_profiles (approved_at desc)
  where approved_at is not null;

-- ============================================================================
-- 4. B-tree index on role_category
-- Used by `.eq("role_category", role)` when a user picks a specific role from
-- the sidebar filter. Skip for the default "All" path (which doesn't filter).
-- ============================================================================

create index if not exists talent_profiles_role_category_idx
  on public.talent_profiles (role_category);

-- ============================================================================
-- 5. ANALYZE so the planner picks the new indexes immediately
-- ============================================================================

analyze public.talent_profiles;

-- ============================================================================
-- 6. Documentation
-- ============================================================================

comment on index public.talent_profiles_first_name_trgm_idx is
  'Phase 4 Bundle B: trigram GIN for ILIKE %q% on first_name. Supports /browse-talent search.';
comment on index public.talent_profiles_last_name_trgm_idx is
  'Phase 4 Bundle B: trigram GIN for ILIKE %q% on last_name.';
comment on index public.talent_profiles_job_title_trgm_idx is
  'Phase 4 Bundle B: trigram GIN for ILIKE %q% on job_title.';
comment on index public.talent_profiles_approved_at_idx is
  'Phase 4 Bundle B: partial B-tree on approved_at. Drops the per-query full scan.';
comment on index public.talent_profiles_role_category_idx is
  'Phase 4 Bundle B: B-tree on role_category. Used by sidebar role filter.';

-- End of migration 005.
