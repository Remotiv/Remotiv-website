-- ============================================================
-- HELD FOR REVIEW — NOT A MIGRATION, NOT RUN
-- ============================================================
-- Deliberately NOT in src/lib/supabase/migrations/, so it can
-- never be picked up as part of a migration run. It is a one-off
-- data change, to be executed by hand after Steps 1 and 2 are
-- deployed and after a fresh dry-run count has been reviewed.
--
-- Nothing in this file has been executed. No is_paused flag and
-- no status value has been changed by the work that produced it.
--
-- ── What this does, and to whom ─────────────────────────────
--
-- Pauses the profiles of people who never claimed them and whom
-- no employer has ever touched. Those people were told at signup
-- that their data goes only to matched employers, which was not
-- true of an approved profile. Everyone with any employer
-- activity, and everyone who claimed their profile, is left
-- alone.
--
-- Activity means any of: an unlock, a save by a subscriber,
-- membership of a client batch, a CV fetched by a non-admin, or
-- a hire request.
--
-- ── Why the set is computed here and not carried in ─────────
--
-- Every count taken while designing this is already stale. A
-- frozen list of ids would pause a profile that someone unlocked
-- in the interval, which is exactly the case the activity test
-- exists to prevent. The `not exists` form below is evaluated
-- inside the single UPDATE statement, so the set is whatever is
-- true at the instant it runs and nothing can shift mid-run.
--
-- `was_admin is not true` rather than `= false`, so a null counts
-- as a non-admin fetch. That treats the row as having activity,
-- which errs toward NOT pausing. Wrong in the safe direction.
--
-- ── Order ───────────────────────────────────────────────────
--
--   1. Record the one profile already paused, so it can be told
--      apart from this run afterwards.
--   2. Dry run each count. Review before proceeding.
--   3. Run each UPDATE and keep the returned ids.
--   4. Purge the AI match cache once, afterwards.
-- ============================================================


-- ── 1. Pre-existing paused rows, recorded before anything changes ──
-- talent_profiles had zero paused and zero archived rows when this
-- was written, so the first query is expected to return nothing.

select id from talent_profiles where is_paused = true or is_archived = true;
select id from hire_remote_profiles where status in ('paused', 'archived');


-- ── 2. DRY RUN. Review these numbers before step 3. ──
-- Expected, from the counts taken on 30 September 2026:
--   talent_profiles       about 2484 of 2600 public
--   hire_remote_profiles  about 33 of 36 public
-- The numbers these return are the authoritative ones.

select count(*) as talent_to_pause
from talent_profiles p
where p.approved_at is not null
  and p.is_paused = false
  and p.is_archived = false
  and p.claimed_at is null
  and p.user_id is null
  and not exists (select 1 from unlock_events u where u.candidate_id = p.id)
  and not exists (select 1 from saved_profiles s where s.candidate_id = p.id)
  and not exists (select 1 from client_batch_candidates b
                  where b.source_type = 'talent' and b.source_id = p.id)
  and not exists (select 1 from signed_url_logs l
                  where l.candidate_id = p.id
                    and l.source_table = 'talent_profiles'
                    and l.was_admin is not true)
  and not exists (select 1 from hire_requests h where h.candidate_id = p.id);

-- unlock_events, saved_profiles and client_batch_candidates all key on
-- talent_profiles ids, so a freelancer row can never appear in them. They are
-- omitted below rather than included as always-true conditions.
select count(*) as remote_to_pause
from hire_remote_profiles p
where p.approved_at is not null
  and p.status in ('approved', 'shortlisted', 'placed')
  and p.claimed_at is null
  and p.user_id is null
  and not exists (select 1 from signed_url_logs l
                  where l.candidate_id = p.id
                    and l.source_table = 'hire_remote_profiles'
                    and l.was_admin is not true)
  and not exists (select 1 from hire_requests h where h.candidate_id = p.id);


-- ── 3. THE PAUSE. Same predicates. Keep the returned ids: ──
-- is_paused and status = 'paused' record no reason, so the returned
-- set is the only record of which rows this run touched.

update talent_profiles p
set is_paused = true
where p.approved_at is not null
  and p.is_paused = false
  and p.is_archived = false
  and p.claimed_at is null
  and p.user_id is null
  and not exists (select 1 from unlock_events u where u.candidate_id = p.id)
  and not exists (select 1 from saved_profiles s where s.candidate_id = p.id)
  and not exists (select 1 from client_batch_candidates b
                  where b.source_type = 'talent' and b.source_id = p.id)
  and not exists (select 1 from signed_url_logs l
                  where l.candidate_id = p.id
                    and l.source_table = 'talent_profiles'
                    and l.was_admin is not true)
  and not exists (select 1 from hire_requests h where h.candidate_id = p.id)
returning p.id;

-- 'paused' and not a new reason-carrying status, on purpose. Every gate that
-- honours a pause already recognises 'paused'; a new value would be honoured
-- only by the paths Step 1 converted to the whitelist, and would sail straight
-- through any gate that was missed. 'paused' is safe under both the old and the
-- new predicate.
update hire_remote_profiles p
set status = 'paused'
where p.approved_at is not null
  and p.status in ('approved', 'shortlisted', 'placed')
  and p.claimed_at is null
  and p.user_id is null
  and not exists (select 1 from signed_url_logs l
                  where l.candidate_id = p.id
                    and l.source_table = 'hire_remote_profiles'
                    and l.was_admin is not true)
  and not exists (select 1 from hire_requests h where h.candidate_id = p.id)
returning p.id;


-- ── 4. Afterwards: clear the AI match cache once. ──
-- Step 1 filters the cache on read, so a paused profile already drops out of a
-- warm cached ranking on the next request. This is belt and braces, and a
-- one-off: there is no per-profile invalidation because the cache key is a
-- normalised query string with no index back to a profile.

delete from ai_match_cache;
