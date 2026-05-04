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
