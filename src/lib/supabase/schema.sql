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
