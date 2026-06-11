-- ============================================================
-- Remotiv Database Schema
-- Run this in the Supabase SQL Editor
-- ============================================================

-- ── 1. Talent profiles (/become-a-talent) ───────────────────
create table if not exists profiles (
  id                   uuid primary key default gen_random_uuid(),
  full_name            text not null,
  email                text not null unique,
  phone                text,
  headline             text,
  bio                  text,
  years_experience     integer,
  skills               text[] not null default '{}',
  current_job_title    text,
  expected_salary_usd  integer,
  availability         text,
  location             text,
  resume_url           text,
  photo_url            text,
  linkedin_url         text,
  github_url           text,
  portfolio_url        text,
  status               text not null default 'pending'
                         check (status in ('pending', 'reviewing', 'approved', 'rejected')),
  admin_notes          text,
  vetting_score        integer check (vetting_score between 0 and 100),
  is_featured          boolean not null default false,
  created_at           timestamptz not null default now(),
  approved_at          timestamptz
);

-- ── 2. Contact form submissions (/contact) ───────────────────
create table if not exists contact_submissions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text not null,
  company     text,
  service     text,
  message     text not null,
  status      text not null default 'new'
                check (status in ('new', 'read', 'replied', 'archived')),
  created_at  timestamptz not null default now()
);

-- ── 3. Meeting bookings (/book-a-meeting) ────────────────────
create table if not exists bookings (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null,
  email           text not null,
  company         text,
  service         text,
  preferred_date  date,
  preferred_time  text,
  message         text,
  status          text not null default 'new'
                    check (status in ('new', 'confirmed', 'cancelled', 'completed')),
  created_at      timestamptz not null default now()
);

-- ── Row-Level Security ───────────────────────────────────────
alter table profiles            enable row level security;
alter table contact_submissions enable row level security;
alter table bookings            enable row level security;

-- Public insert (anyone can submit a form — no auth required)
create policy "public can insert profiles"
  on profiles for insert to anon with check (true);

create policy "public can insert contact_submissions"
  on contact_submissions for insert to anon with check (true);

create policy "public can insert bookings"
  on bookings for insert to anon with check (true);

-- Only service-role (admin) can read / update / delete
-- (service_role bypasses RLS automatically — no explicit policy needed)

-- ── Migration: Admin users ───────────────────────────────────
create table if not exists admin_users (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) unique,
  role       text not null default 'admin'
               check (role in ('super_admin', 'admin', 'viewer')),
  full_name  text,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;
-- service_role has full access; no additional policies needed for MVP

-- ── Migration: admin_users.status ────────────────────────────
-- Auth-gate column. The admin layout looks this up on every request and
-- forces signOut + redirect to /login when status != 'active'. This is
-- how super admin "pauses" a team member without deleting them.
alter table admin_users
  add column if not exists status text not null default 'active'
    check (status in ('active', 'paused', 'archived'));

-- ── Migration: candidate_notes (chat-style thread per candidate) ─
-- Both clients and admins post into this thread; client browser-side
-- reads use RLS, admin server actions use the service role.
create table if not exists candidate_notes (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references client_batch_candidates(id) on delete cascade,
  author_type  text not null check (author_type in ('client', 'admin')),
  author_id    uuid references auth.users(id),
  author_name  text,
  note_text    text not null,
  created_at   timestamptz not null default now()
);

alter table candidate_notes enable row level security;

-- Clients see notes only for candidates in batches they own. Admin paths
-- bypass RLS via service role.
drop policy if exists "candidate_notes_select_own" on candidate_notes;
create policy "candidate_notes_select_own" on candidate_notes
  for select to authenticated
  using (
    candidate_id in (
      select cbc.id from client_batch_candidates cbc
      join client_batches cb on cb.id = cbc.batch_id
      join clients c on c.id = cb.client_id
      where c.user_id = auth.uid()
    )
  );

create index if not exists idx_candidate_notes_candidate_id on candidate_notes(candidate_id);
create index if not exists idx_candidate_notes_created_at on candidate_notes(created_at desc);

-- ── Migration: in-app admin notifications (bell dropdown) ────
-- One row per recipient per event. Notifications are written by the same
-- service client that performs the underlying mutation; reads/marks-read
-- are done as the authenticated admin via RLS.
create table if not exists notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  event_type        text not null check (event_type in (
    'client_decision',
    'client_note',
    'stage_change',
    'candidate_added',
    'new_inquiry',
    'profile_claimed',
    'profile_approved',
    'profile_rejected'
  )),
  title             text not null,
  message           text not null,
  link              text,
  metadata          jsonb default '{}'::jsonb,
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);

alter table notifications enable row level security;

drop policy if exists "notifications_select_own" on notifications;
create policy "notifications_select_own" on notifications
  for select to authenticated
  using (recipient_user_id = auth.uid());

drop policy if exists "notifications_update_own" on notifications;
create policy "notifications_update_own" on notifications
  for update to authenticated
  using (recipient_user_id = auth.uid());

create index if not exists idx_notifications_recipient
  on notifications(recipient_user_id, created_at desc);
create index if not exists idx_notifications_unread
  on notifications(recipient_user_id, read_at) where read_at is null;

-- ── Migration: extend notifications.event_type — add profile_* events ─
-- Adds the 3 profile_* events introduced in 4.5B (profile_approved,
-- profile_rejected) and 4.5C/5B.2 (profile_claimed). The CREATE TABLE
-- block above already lists all 8; this trailing ALTER exists so the
-- constraint history is documented AND so re-applying this file to a
-- fresh DB ends with the correct 8-value constraint rather than the
-- 5-value one that previously closed the file.
alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'client_decision',
    'client_note',
    'stage_change',
    'candidate_added',
    'new_inquiry',
    'profile_claimed',
    'profile_approved',
    'profile_rejected'
  ));

-- Migration: contact_submissions / bookings — admin_notes + unified status
alter table contact_submissions add column if not exists admin_notes text;
alter table bookings add column if not exists admin_notes text;

alter table contact_submissions alter column status set default 'new';
alter table bookings alter column status set default 'new';

update contact_submissions set status = 'new' where status is null;
update bookings set status = 'new' where status is null;

-- Map legacy statuses to the unified vocabulary BEFORE tightening the
-- check constraint, otherwise rows with old values would block the
-- ALTER TABLE.
update contact_submissions set status = 'in_progress' where status in ('read');
update contact_submissions set status = 'closed'      where status in ('replied');
update bookings set status = 'in_progress' where status in ('confirmed');
update bookings set status = 'closed'      where status in ('completed');
update bookings set status = 'archived'    where status in ('cancelled');

alter table contact_submissions drop constraint if exists contact_submissions_status_check;
alter table contact_submissions add constraint contact_submissions_status_check
  check (status in ('new', 'in_progress', 'closed', 'archived'));

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('new', 'in_progress', 'closed', 'archived'));

-- ── Migration: talent_claim_tokens (Phase 2 — admin invite flow) ─
-- IMPORTANT: This table was originally created via the Supabase SQL Editor
-- during Phase 2 and lived out-of-band until this back-port. Production
-- schema is the source of truth; this block exists so a fresh apply of
-- schema.sql to a clean project recreates it identically.
--
-- Polymorphic FK: candidate_id references either talent_profiles(id)
-- OR hire_remote_profiles(id), discriminated by source_table. Postgres
-- doesn't support multi-target REFERENCES, so the parent FK is enforced
-- in application code (api/admin/send-invite + api/claim/verify +
-- talent/actions.ts always set source_table alongside candidate_id).
create table if not exists talent_claim_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  candidate_id  uuid not null,
  source_table  text not null
                  check (source_table in ('talent_profiles', 'hire_remote_profiles')),
  status        text not null default 'pending'
                  check (status in ('pending', 'opened', 'claimed', 'expired')),
  expires_at    timestamptz not null,
  opened_at     timestamptz,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now()
);

alter table talent_claim_tokens enable row level security;
-- service_role bypasses RLS; admin reads + token CRUD all go via service client.

create index if not exists idx_talent_claim_tokens_lookup
  on talent_claim_tokens(candidate_id, source_table, status);
create index if not exists idx_talent_claim_tokens_token_hash
  on talent_claim_tokens(token_hash);
