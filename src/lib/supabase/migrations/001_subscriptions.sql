-- ============================================================
-- Remotiv Migration 001: Subscriptions Table
-- ============================================================
-- Creates the subscriptions table — the single source of truth
-- for a user's tier (free | starter | pro) and monthly unlock
-- credits. Stripe-agnostic: subscription_id stays NULL until
-- Stripe is integrated (Phase B-4). Until then, rows are
-- inserted/updated manually via the Supabase dashboard.
--
-- Lookup pattern: app code queries this table by user_id.
-- Absence of a row = free tier (default behavior, no insert
-- needed for anonymous or unsubscribed users).
-- ============================================================

create table if not exists subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references auth.users(id) on delete cascade,
  tier               text not null default 'free' check (tier in ('free', 'starter', 'pro')),
  credits_remaining  integer not null default 0 check (credits_remaining >= 0),
  credits_reset_at   timestamptz,
  subscription_id    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Index for fast lookup by user_id (already unique, but explicit for clarity)
create index if not exists subscriptions_user_id_idx on subscriptions(user_id);

-- Index for tier filtering (admin queries, analytics)
create index if not exists subscriptions_tier_idx on subscriptions(tier);

-- ============================================================
-- Row Level Security
-- ============================================================
-- Users can read their own subscription row only.
-- Writes are restricted to service role (server-side code with
-- createServiceClient). No direct client-side writes.
-- ============================================================

alter table subscriptions enable row level security;

create policy "Users can read own subscription"
  on subscriptions
  for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies for authenticated users.
-- Service role bypasses RLS by default for admin operations.

-- ============================================================
-- updated_at auto-touch trigger
-- ============================================================

create or replace function touch_subscriptions_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row
  execute function touch_subscriptions_updated_at();
