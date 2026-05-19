-- Migration 004: cv_path column + signed_url_logs audit table
-- Date: 2026-05-19
-- Purpose: Phase 1 of K1 (CV bucket privacy hardening).
--   1. Add cv_path text column to 4 tables that today store a full public URL in cv_url.
--   2. Backfill cv_path by stripping the public-URL prefix from existing cv_url values.
--   3. Create signed_url_logs audit table for Phase 2 signed-URL request logging.
-- Safe to re-run (uses IF NOT EXISTS / IF NOT NULL guards).

-- ============================================================================
-- 1. Add cv_path column to all 4 tables
-- ============================================================================

alter table public.talent_profiles
  add column if not exists cv_path text;

alter table public.hire_remote_profiles
  add column if not exists cv_path text;

alter table public.job_applications
  add column if not exists cv_path text;

alter table public.client_batch_candidates
  add column if not exists cv_path text;

-- ============================================================================
-- 2. Backfill cv_path from existing cv_url
-- Strips the leading "https://<project>.supabase.co/storage/v1/object/public/cvs/"
-- portion to retain only the bucket-relative path.
-- Uses regex to be robust to project-ref differences across environments.
-- ============================================================================

update public.talent_profiles
set cv_path = regexp_replace(
  cv_url,
  '^https?://[^/]+/storage/v1/object/public/cvs/',
  ''
)
where cv_url is not null
  and cv_path is null;

update public.hire_remote_profiles
set cv_path = regexp_replace(
  cv_url,
  '^https?://[^/]+/storage/v1/object/public/cvs/',
  ''
)
where cv_url is not null
  and cv_path is null;

update public.job_applications
set cv_path = regexp_replace(
  cv_url,
  '^https?://[^/]+/storage/v1/object/public/cvs/',
  ''
)
where cv_url is not null
  and cv_path is null;

update public.client_batch_candidates
set cv_path = regexp_replace(
  cv_url,
  '^https?://[^/]+/storage/v1/object/public/cvs/',
  ''
)
where cv_url is not null
  and cv_path is null;

-- ============================================================================
-- 3. signed_url_logs audit table
-- Logs every successful signed-URL grant for CV access (Phase 2 onward).
-- Append-only. Indexed for "show me views of candidate X" and
-- "show me views by user Y" queries.
-- ============================================================================

create table if not exists public.signed_url_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null,
  source_table text not null,            -- 'talent_profiles' | 'hire_remote_profiles' | 'job_applications' | 'client_batch_candidates'
  was_admin boolean not null default false,
  granted_at timestamptz not null default now()
);

create index if not exists signed_url_logs_user_id_idx
  on public.signed_url_logs(user_id);

create index if not exists signed_url_logs_candidate_id_idx
  on public.signed_url_logs(candidate_id);

create index if not exists signed_url_logs_granted_at_idx
  on public.signed_url_logs(granted_at desc);

-- ============================================================================
-- 4. RLS on signed_url_logs
-- Strategy: service-role only writes (server actions). Authenticated users can
-- read their own logs. Anonymous gets nothing.
-- ============================================================================

alter table public.signed_url_logs enable row level security;

drop policy if exists "Users can view their own signed-url logs"
  on public.signed_url_logs;

create policy "Users can view their own signed-url logs"
  on public.signed_url_logs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policies — service-role only via server action.

-- ============================================================================
-- 5. Helpful comments on column purpose
-- ============================================================================

comment on column public.talent_profiles.cv_path is
  'Bucket-relative path inside the cvs bucket (e.g. "talent/cvs/uuid.pdf"). Phase 2 of K1: signed URLs generated at read time; cv_url retained for transition.';

comment on column public.hire_remote_profiles.cv_path is
  'Bucket-relative path inside the cvs bucket. Phase 2 of K1.';

comment on column public.job_applications.cv_path is
  'Bucket-relative path inside the cvs bucket. Phase 2 of K1.';

comment on column public.client_batch_candidates.cv_path is
  'Bucket-relative path inside the cvs bucket. Phase 2 of K1.';

comment on table public.signed_url_logs is
  'Audit log of CV signed-URL grants. Append-only. Service-role insert; users can read their own. was_admin distinguishes subscriber clicks from admin clicks.';

-- End of migration 004.
