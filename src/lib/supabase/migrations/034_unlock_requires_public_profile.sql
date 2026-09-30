-- ============================================================
-- Remotiv Migration 034: a new unlock requires a public profile
-- ============================================================
-- NOT RUN BY ANY CODE PATH. Applied by hand in the Supabase SQL
-- editor, like every other migration in this folder.
--
-- ── What was wrong ──────────────────────────────────────────
--
-- unlock_candidate() checked only `approved_at is not null`
-- (migration 002, step 2). A profile that is approved but paused
-- or archived is NOT publicly visible, yet a caller who knew its
-- id could spend a credit to unlock it, and getCvSignedUrl would
-- then serve that profile's CV because it gates on the unlock row
-- rather than on visibility. The pause was bypassable in two
-- steps. The TypeScript helper in src/lib/talent-visibility.ts
-- cannot reach a Postgres function, so the rule is restated here.
--
-- ── Where the new check goes, and why not earlier ───────────
--
-- AFTER the existing-unlock branch, BEFORE the tier read.
--
-- Putting it in step 2 beside the approved_at test would have been
-- the smaller diff and would have been wrong: step 2 runs before
-- the already-unlocked branch, so a recruiter who unlocked a
-- profile last month would start getting `candidate_not_found` the
-- moment that profile was paused. Existing unlocks must keep
-- working. Placed where it is, the order of outcomes is:
--
--   already unlocked      -> success, already_unlocked = true
--                            (unchanged, no credit, works even
--                             once the profile is paused)
--   not public, no unlock -> candidate_not_found
--   public, no unlock     -> tier / credit checks as before
--
-- Everything that spends a credit still sits after this gate, so a
-- refusal cannot decrement `credits_remaining` and cannot insert
-- into unlock_events. There is no partial path: the two writes are
-- the last two statements in the function.
--
-- ── Why it reuses candidate_not_found ───────────────────────
--
-- The caller must not be able to tell hidden from paused from
-- archived from never-existed. Reusing the existing error code
-- means all four produce a byte-identical response. The
-- recruiter-facing wording moves to "This profile is not
-- available." in src/app/browse-talent/actions.ts, so the message
-- no longer asserts that the row does not exist.
--
-- ── What is deliberately unchanged ──────────────────────────
--
-- The signature, the return shape, every existing error code, the
-- `for update` row lock on subscriptions, the free re-click, and
-- the grants. No unlock_events row is revoked, deleted, or
-- rewritten. Re-running this file is safe: it is a single
-- create-or-replace.
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
    -- Already unlocked — return existing record, no credit charge.
    -- Reached before the visibility gate below ON PURPOSE: access
    -- already paid for survives the profile being paused.
    select credits_remaining into v_credits
    from subscriptions where user_id = v_user_id;

    return json_build_object(
      'success', true,
      'already_unlocked', true,
      'credits_remaining', coalesce(v_credits, 0),
      'unlocked_at', v_existing_row.unlocked_at
    );
  end if;

  -- 3b. A NEW unlock requires the profile to be publicly visible.
  --     Mirrors publicTalent() / isTalentPublic() in
  --     src/lib/talent-visibility.ts. Same error as a missing row,
  --     so paused, archived, non-public and nonexistent are
  --     indistinguishable to the caller. Sits before every
  --     statement that spends anything.
  if not exists (
    select 1 from talent_profiles
    where id = p_candidate_id
      and approved_at is not null
      and is_paused = false
      and is_archived = false
  ) then
    return json_build_object('success', false, 'error', 'candidate_not_found');
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

-- Grants are unchanged from migration 002; restated so that applying
-- this file alone leaves the function reachable by exactly the same
-- callers.
revoke all on function unlock_candidate(uuid) from public;
grant execute on function unlock_candidate(uuid) to authenticated;
