-- Phase B-4 Step 2 + Step 8c Fixes
-- saved_profiles: tracks subscriber bookmarks of talent profiles
-- ORIGINAL: created in Step 2 (May 16) directly via Supabase Dashboard SQL Editor
-- This file documents the schema for repo parity + adds 2 Step 8c fixes:
--   FIX 1: auth.uid() default on user_id (auto-fill from session)
--   FIX 2: candidate_id FK points to talent_profiles, not profiles

-- ============================================================
-- TABLE
-- ============================================================
create table if not exists public.saved_profiles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  candidate_id uuid not null references public.talent_profiles(id) on delete cascade,
  saved_at     timestamptz not null default now(),
  unique (user_id, candidate_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
create index if not exists saved_profiles_user_id_idx
  on public.saved_profiles (user_id);

create index if not exists saved_profiles_candidate_id_idx
  on public.saved_profiles (candidate_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.saved_profiles enable row level security;

-- SELECT: users see only their own saves
drop policy if exists "Users can view their own saved profiles" on public.saved_profiles;
create policy "Users can view their own saved profiles"
  on public.saved_profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT: users can save profiles for themselves
drop policy if exists "Users can save profiles for themselves" on public.saved_profiles;
create policy "Users can save profiles for themselves"
  on public.saved_profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- DELETE: users can unsave their own profiles
drop policy if exists "Users can unsave their own profiles" on public.saved_profiles;
create policy "Users can unsave their own profiles"
  on public.saved_profiles
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ============================================================
-- STEP 8c FIX 1 (May 16): auto-fill user_id on insert
-- ============================================================
-- Without this default, client-side inserts must explicitly pass user_id.
-- With this default, Supabase auto-fills user_id with the current auth user,
-- which matches the RLS with_check policy and keeps client code minimal.
alter table public.saved_profiles 
  alter column user_id set default auth.uid();

-- ============================================================
-- STEP 8c FIX 2 (May 16): candidate_id FK must point to talent_profiles
-- ============================================================
-- Original schema (created in Step 2 via dashboard) accidentally pointed the
-- candidate_id FK at 'profiles' (an unused/empty table). Talent data actually
-- lives in 'talent_profiles', so inserts were failing with FK violations (23503).
-- This drops the wrong FK and adds the correct one.
alter table public.saved_profiles 
  drop constraint if exists saved_profiles_candidate_id_fkey;

alter table public.saved_profiles 
  add constraint saved_profiles_candidate_id_fkey 
  foreign key (candidate_id) 
  references public.talent_profiles(id) 
  on delete cascade;
