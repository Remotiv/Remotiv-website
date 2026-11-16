-- ============================================================================
-- #68 alignment, step 02: migration 057 on STAGING
-- ----------------------------------------------------------------------------
-- STAGING ONLY, by decision of this plan (057 itself has no staging refusal:
-- it was written for both databases).
--
-- RUN src/lib/supabase/migrations/057_company_member_removed_at.sql AS
-- WRITTEN: one paste, from its begin; to its commit;, one execution. This
-- file does not copy it. This file holds only the checks before and after.
--
-- Closes, from the #68 audit (14 Nov 2026): column company_members.removed_at
-- (057:89), constraint company_members_removed_at_matches_status (057:161),
-- function and trigger company_members_stamp_removed (057:115, :131).
-- Line numbers are the working tree's. The other session's uncommitted edit
-- to 057 changes only header comment lines 5-10 (+4 lines), not one line of
-- SQL, so the file runs the same either way; in HEAD each line above is 4
-- lower.
--
-- ── Why 057 can run on staging exactly as written ────────────
--
--   1. No production constant anywhere in 057:75-195: no user id, no count, no
--      date. Every value the backfill writes is derived from the database it
--      runs on (057:148-153).
--   2. What it rests on exists on staging, the same as production (staging
--      dump of 14 Nov 2026): company_members.status text NOT NULL, CHECK in
--      (active, invited, removed); company_invites.created_at timestamptz NOT
--      NULL default now(); no trigger on company_members.
--   3. Its invariant (057:174-193) cannot be tripped by staging's data: the
--      backfill sets removed_at = greatest(now(), max(company_invites.created_at)
--      + 1 second), which is strictly later than every invitation, so
--      n_not_after is 0; status is NOT NULL, so every row is either removed
--      (stamped) or not (NULL), so n_unstamped and n_stamped_active are 0. It
--      still refuses, rolling everything back, if any of that is not so.
--   4. Re-runnable: add column if not exists, drop trigger if exists, drop
--      constraint if exists (057:89-90, :130, :160-161).
--
-- The staging rehearsal in 057:216-341 (tests A to D, dummy company only) is
-- separate. Step 0 of that rehearsal, the schema comparison, is what the #68
-- audit and this plan's final re-dump do.
-- ============================================================================


-- ── BEFORE: read-only, run alone first (057:66-73, plus the staging check) ──

begin;
set transaction read only;

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'company_members'
      and column_name = 'removed_at')                                   as removed_at_columns,  -- 0
  (select max(created_at) < now() from public.company_invites)         as latest_invite_before_now,  -- true (or null: no invitations)
  (select count(*) from pg_trigger
    where tgrelid = 'public.company_members'::regclass and not tgisinternal) as member_triggers, -- 0
  to_regclass('staging_guard.sentinel') is not null                     as is_staging;          -- true, or STOP

rollback;


-- ── Then run 057 as written. Expect "Success. No rows returned". ──
--
-- If its step-5 block raises, nothing was applied; its message names the
-- counts. Run  rollback;  on its own, then the BEFORE query again (0 columns).


-- ── AFTER: read-only (057:198-213, as one row) ──────────────

begin;
set transaction read only;

select
  (select data_type || ', ' || is_nullable || ', ' || coalesce(column_default, 'NULL')
     from information_schema.columns
    where table_schema = 'public' and table_name = 'company_members'
      and column_name = 'removed_at')                                   as removed_at_column,   -- timestamp with time zone, YES, NULL
  (select string_agg(tgname || ' ' || tgenabled, ', ')
     from pg_trigger
    where tgrelid = 'public.company_members'::regclass and not tgisinternal) as triggers,      -- company_members_stamp_removed O
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.company_members'::regclass
      and conname = 'company_members_removed_at_matches_status')       as invariant_check,     -- CHECK (((status = 'removed'::text) = (removed_at IS NOT NULL)))
  (select count(*) from public.company_members
    where status = 'removed' and removed_at is null)                    as removed_unstamped,   -- 0
  (select count(*) from public.company_members
    where status <> 'removed' and removed_at is not null)               as others_stamped;      -- 0

rollback;

-- Then 00-effective-access-READONLY.sql on staging: the row for
-- company_members_stamp_removed must read the same as production's.
--
-- ── ROLLBACK of a committed apply, staging only ─────────────
--
-- 057 has no rollback section of its own; this is written for this plan.
-- The code on main already depends on the column: the invitation acceptance
-- filters on it (src/app/ai-dashboard/accept/actions.ts:221 and :244). If
-- staging runs that code, dropping the column breaks every acceptance there.
-- Undo only to repair a failed alignment, with that code not deployed.
--
-- begin;
-- set local lock_timeout = '5s';
-- do $$ begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: nothing was written';
--   end if;
-- end $$;
-- drop trigger if exists company_members_stamp_removed on public.company_members;
-- drop function if exists public.company_members_stamp_removed();
-- alter table public.company_members
--   drop constraint if exists company_members_removed_at_matches_status,
--   drop column if exists removed_at;
-- commit;
