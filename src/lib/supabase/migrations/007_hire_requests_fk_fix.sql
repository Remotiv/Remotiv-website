-- ── Migration 007: fix hire_requests.candidate_id FK ──────────
-- Migration 006 incorrectly pointed candidate_id to talent_profiles, but
-- /hire-remote reads from hire_remote_profiles. Submissions failed with
-- foreign key violations. This migration repoints the FK to the correct
-- table.

-- Drop the wrong constraint
alter table hire_requests
  drop constraint if exists hire_requests_candidate_id_fkey;

-- Add the correct constraint referencing hire_remote_profiles
alter table hire_requests
  add constraint hire_requests_candidate_id_fkey
  foreign key (candidate_id)
  references hire_remote_profiles(id)
  on delete set null;

-- Existing rows: if any test rows were inserted with talent_profile IDs that
-- happen to not exist in hire_remote_profiles, this migration will fail.
-- In that case, run this first to null out orphaned candidate_ids:
--
--   update hire_requests
--      set candidate_id = null
--    where candidate_id is not null
--      and not exists (
--        select 1 from hire_remote_profiles where id = hire_requests.candidate_id
--      );
--
-- The hire_requests table is brand-new (created in 006) so there should be
-- no rows yet. Comment is here for future reference if this migration is
-- re-run.
