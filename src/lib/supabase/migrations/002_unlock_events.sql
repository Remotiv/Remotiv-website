-- ============================================================
-- Remotiv Migration 002: Unlock Events + Atomic Unlock RPC
-- ============================================================
-- Creates the unlock_events table that tracks which candidates
-- each user has unlocked (1 credit = 1 candidate, permanent
-- record). Also defines unlock_candidate(uuid) — an atomic
-- SECURITY DEFINER function that decrements credits and inserts
-- the unlock_event in a single transaction, eliminating the
-- race condition where two simultaneous clicks could spend
-- credits inconsistently.
--
-- Visibility rule (enforced in app code, not in DB):
-- Free tier sees ZERO unlocks even if rows exist for them.
-- Subscriber tier sees their own unlock_events normally.
-- Re-subscribing restores access to past unlocks for free.
-- ============================================================

create table if not exists unlock_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  candidate_id   uuid not null references talent_profiles(id) on delete cascade,
  unlocked_at    timestamptz not null default now(),
  unique (user_id, candidate_id)
);

-- Index for the most common lookup: "what has user X unlocked?"
create index if not exists unlock_events_user_id_idx on unlock_events(user_id);

-- Index for occasional reverse lookup: "who unlocked candidate Y?"
create index if not exists unlock_events_candidate_id_idx on unlock_events(candidate_id);

-- ============================================================
-- Row Level Security
-- ============================================================
-- Users can read their own unlock_events rows only.
-- Writes are restricted to the unlock_candidate() RPC (service
-- role + SECURITY DEFINER bypass RLS during the atomic insert).
-- ============================================================

alter table unlock_events enable row level security;

create policy "unlock_events_select_own"
  on unlock_events
  for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies for authenticated users.
-- Service role + SECURITY DEFINER RPC handles writes.

-- ============================================================
-- unlock_candidate(p_candidate_id uuid) → json
-- ============================================================
-- Atomic unlock flow:
--   1. Authenticate the calling user (auth.uid()).
--   2. If already unlocked (row exists), return existing record
--      with credits_remaining unchanged (free re-click).
--   3. Otherwise, check the subscriber tier and credits.
--   4. If tier is not 'starter' or 'pro', error out.
--   5. If credits_remaining <= 0, error out.
--   6. Atomically: decrement credits AND insert unlock_event.
--   7. Return success with new credits_remaining.
--
-- Returns shape:
--   { "success": true, "already_unlocked": false,
--     "credits_remaining": 29, "unlocked_at": "..." }
--   { "success": false, "error": "not_subscribed" | "no_credits" |
--     "not_authenticated" | "candidate_not_found" }
-- ============================================================

create or replace function unlock_candidate(p_candidate_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_tier text;
  v_credits integer;
  v_existing_row unlock_events%rowtype;
  v_new_credits integer;
  v_new_unlocked_at timestamptz;
begin
  -- 1. Authenticate
  v_user_id := auth.uid();
  if v_user_id is null then
    return json_build_object('success', false, 'error', 'not_authenticated');
  end if;

  -- 2. Verify candidate exists and is approved
  if not exists (
    select 1 from talent_profiles
    where id = p_candidate_id and approved_at is not null
  ) then
    return json_build_object('success', false, 'error', 'candidate_not_found');
  end if;

  -- 3. Check existing unlock
  select * into v_existing_row
  from unlock_events
  where user_id = v_user_id and candidate_id = p_candidate_id
  limit 1;

  if found then
    -- Already unlocked — return existing record, no credit charge
    select credits_remaining into v_credits
    from subscriptions where user_id = v_user_id;

    return json_build_object(
      'success', true,
      'already_unlocked', true,
      'credits_remaining', coalesce(v_credits, 0),
      'unlocked_at', v_existing_row.unlocked_at
    );
  end if;

  -- 4. Read tier + credits in a single locked row
  select tier, credits_remaining into v_tier, v_credits
  from subscriptions
  where user_id = v_user_id
  for update;

  -- 5. Tier check
  if v_tier is null or v_tier not in ('starter', 'pro') then
    return json_build_object('success', false, 'error', 'not_subscribed');
  end if;

  -- 6. Credit check
  if v_credits is null or v_credits <= 0 then
    return json_build_object('success', false, 'error', 'no_credits');
  end if;

  -- 7. Atomic spend
  v_new_credits := v_credits - 1;

  update subscriptions
  set credits_remaining = v_new_credits
  where user_id = v_user_id;

  insert into unlock_events (user_id, candidate_id)
  values (v_user_id, p_candidate_id)
  returning unlocked_at into v_new_unlocked_at;

  return json_build_object(
    'success', true,
    'already_unlocked', false,
    'credits_remaining', v_new_credits,
    'unlocked_at', v_new_unlocked_at
  );
end;
$$;

-- Restrict who can invoke: only logged-in users.
revoke all on function unlock_candidate(uuid) from public;
grant execute on function unlock_candidate(uuid) to authenticated;
