-- ============================================================================
-- Migration 015 — application_admin_tags
-- ----------------------------------------------------------------------------
-- Per-admin PRIVATE tags on job applications. Each admin sees ONLY their own
-- tags. tag ∈ ('shortlist','maybe','not_a_fit'). One row per (application,
-- admin, tag). Toggle on = insert; toggle off = delete. The unique constraint
-- on (application_id, admin_user_id, tag) makes toggle inserts idempotent —
-- re-running the same insert is a hard no-op at the DB.
--
-- This replaces the old SHARED job_applications.status for tagging purposes.
-- The legacy status column is left UNTOUCHED and is NOT backfilled into this
-- table — a single shared status value can't be attributed to any one admin,
-- so backfill would invent ownership that doesn't exist.
--
-- FK targets follow the codebase convention used by saved_profiles (003),
-- candidate_notes, and notifications: FK to auth.users(id) rather than
-- admin_users.id, so the policies can use auth.uid() directly. The
-- application-side join goes through job_applications(id).
--
-- RLS is enabled defense-in-depth. The server actions on this table use the
-- service role (createServiceClient) and bypass RLS; the per-row "owner is
-- me" policies guard any future direct-from-browser read path.
-- ============================================================================

create table if not exists public.application_admin_tags (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.job_applications(id) on delete cascade,
  admin_user_id   uuid not null references auth.users(id)              on delete cascade,
  tag             text not null check (tag in ('shortlist', 'maybe', 'not_a_fit')),
  created_at      timestamptz not null default now(),
  unique (application_id, admin_user_id, tag)
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
-- The page-load query is "select tag, application_id from this table where
-- admin_user_id = <me>", so (admin_user_id, application_id) covers the read
-- path. The (application_id) index supports the on-delete cascade from
-- job_applications and any future "who else tagged this app" queries.

create index if not exists idx_application_admin_tags_admin_app
  on public.application_admin_tags (admin_user_id, application_id);

create index if not exists idx_application_admin_tags_app
  on public.application_admin_tags (application_id);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.application_admin_tags enable row level security;

drop policy if exists "admin_tags_select_own" on public.application_admin_tags;
create policy "admin_tags_select_own"
  on public.application_admin_tags
  for select
  to authenticated
  using (admin_user_id = auth.uid());

drop policy if exists "admin_tags_insert_own" on public.application_admin_tags;
create policy "admin_tags_insert_own"
  on public.application_admin_tags
  for insert
  to authenticated
  with check (admin_user_id = auth.uid());

drop policy if exists "admin_tags_delete_own" on public.application_admin_tags;
create policy "admin_tags_delete_own"
  on public.application_admin_tags
  for delete
  to authenticated
  using (admin_user_id = auth.uid());
