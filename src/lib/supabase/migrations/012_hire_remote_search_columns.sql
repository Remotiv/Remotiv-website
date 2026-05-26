-- Migration 012: hire_remote_profiles search/filter columns + indexes
-- Date: 2026-05-27
-- Purpose: Move /hire-remote filtering + pagination from client-side
--   (current full-table fetch + useMemo .filter chain) to true server-side
--   queries. The page expects 1,000+ approved candidates post-launch, at
--   which point shipping every row as serialised props is unacceptable.
--
-- This migration is the DB layer of that rewrite. App code is unchanged
-- in this migration — the trigger fires automatically on existing INSERT
-- paths (src/app/api/hire-remote-profiles/route.ts) and admin UPDATE paths
-- (src/app/admin/remote-talent/actions.ts), so no API change is required
-- to populate the new columns going forward.
--
-- Mirrors migration 005 (talent_profiles trigram + partial indexes) and
-- migration 008 (talent_profiles trigger-maintained search column) in
-- structure, naming, and comment style.
--
-- NOTE: skills is stored as text[] (Postgres native array), not jsonb.
-- employment_history and languages are jsonb (they hold objects, which
-- text[] cannot). The trigger + backfill below handle the column-type
-- difference explicitly.
--
-- Three filters can't be expressed against the raw array/JSONB columns via
-- the Supabase JS client and are addressed by trigger-maintained computed
-- columns:
--   1. skills_text          — lowercased space-joined skills array
--                             (substring search via trigram GIN)
--   2. years_experience     — jsonb_array_length(employment_history) * 3
--                             (heuristic deliberately mirrors the client's
--                              expBucketMatch — see flag below)
--   3. english_level_rank   — first "English" entry from languages array,
--                             mapped Native=4/Fluent=3/Professional=2/
--                             Basic=1/none=0
--
-- The remaining filters (role/job_titles, rate, availability, search across
-- name/title/bio/location) are addressable with simple ILIKE / equality /
-- range queries and are covered by the trigram + B-tree indexes below.
--
-- ⚠️  EXPERIENCE HEURISTIC IS INTENTIONALLY PRESERVED.
--   The client today computes `years = jobs.length * 3` (see
--   src/app/hire-remote/_marketplace.tsx expBucketMatch). This is a poor
--   model — someone with one 10-year role gets 3 yrs, someone with three
--   6-month gigs gets 9 yrs. Replacing it with real per-job-date parsing
--   is a product change (touches /remote-ready, /become-a-talent, admin
--   edit form) and is out of scope for the perf rewrite. The trigger
--   below preserves the existing heuristic so server-side results match
--   what the client currently shows. Document follow-up if/when the
--   product is ready to change the model.
--
-- ⚠️  RUN ORDER WARNING
--   * RUN ON DEV (Supabase dashboard SQL editor or supabase CLI) FIRST.
--     Verify with the smoke-test queries at the bottom of this file.
--   * After verifying, run the SAME migration on PRODUCTION before the
--     /hire-remote server-side rewrite is shipped.
--   * Migration 011 (photo_path column) must also be applied to PRODUCTION
--     if it has not been run there yet. 012 does not depend on 011, but
--     they should both land before launch.
--
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / DROP IF
-- EXISTS / CREATE OR REPLACE / idempotent UPDATE.
-- No destructive operations: only ADDs columns/indexes/trigger and a
-- non-destructive backfill UPDATE.

-- ============================================================================
-- 1. pg_trgm extension (idempotent; already installed by migration 005 in
--    most environments, repeated here for self-containment).
-- ============================================================================

create extension if not exists pg_trgm;

-- ============================================================================
-- 2. New computed columns on hire_remote_profiles (all nullable, populated
--    by the trigger below + backfilled at the end of this migration).
-- ============================================================================

alter table public.hire_remote_profiles
  add column if not exists skills_text text;

alter table public.hire_remote_profiles
  add column if not exists years_experience smallint;

alter table public.hire_remote_profiles
  add column if not exists english_level_rank smallint;

comment on column public.hire_remote_profiles.skills_text is
  'Trigger-maintained lowercased space-joined view of the skills text[] array. Used by /hire-remote skills filter via trigram ILIKE. Source of truth: skills (text[]).';

comment on column public.hire_remote_profiles.years_experience is
  'Trigger-maintained heuristic: jsonb_array_length(employment_history) * 3. Mirrors the existing client-side bucket logic in src/app/hire-remote/_marketplace.tsx expBucketMatch. Heuristic is intentionally crude; replacing it is a product change, not a perf change.';

comment on column public.hire_remote_profiles.english_level_rank is
  'Trigger-maintained rank of the first English entry in the languages jsonb array. Mapping: Native=4, Fluent=3, Professional=2, Basic=1, none=0. KEEP IN SYNC with ENGLISH_LEVEL_RANK in src/app/hire-remote/_marketplace.tsx. If new levels are added or renamed in either place, both must change together.';

-- ============================================================================
-- 3. Trigger function — recomputes the 3 columns from the source JSONB on
--    every INSERT or UPDATE. Null-safe: empty / missing / non-array source
--    fields produce 0 / empty-string outputs rather than raising.
-- ============================================================================

create or replace function public.hire_remote_profiles_search_fields()
returns trigger
language plpgsql
as $$
declare
  eng_level text;
begin
  -- skills_text: flatten the text[] array into a single lowercased space-
  -- separated string. skills is a Postgres native text[] (not jsonb).
  -- array_to_string is null-safe on a NULL array element by skipping it;
  -- the outer coalesce handles a NULL column value.
  new.skills_text := lower(coalesce(array_to_string(new.skills, ' '), ''));

  -- years_experience: preserves the client's expBucketMatch heuristic
  -- (jobs.length * 3). See the warning at the top of this file.
  if jsonb_typeof(new.employment_history) = 'array' then
    new.years_experience := jsonb_array_length(new.employment_history) * 3;
  else
    new.years_experience := 0;
  end if;

  -- english_level_rank: find the first entry whose name matches English
  -- (case-insensitive, substring — handles "English", "english", "British
  -- English", etc), then map level → rank. The level strings must match
  -- the form values written by /remote-ready: "Native"/"Fluent"/
  -- "Professional"/"Basic". Anything else (including a missing English
  -- entry) → 0, which the application reads as "no English signal".
  if jsonb_typeof(new.languages) = 'array' then
    select (elem->>'level')
      into eng_level
      from jsonb_array_elements(new.languages) as elem
      where elem->>'name' ilike '%english%'
      limit 1;
  else
    eng_level := null;
  end if;

  new.english_level_rank := case eng_level
    when 'Native'       then 4
    when 'Fluent'       then 3
    when 'Professional' then 2
    when 'Basic'        then 1
    else 0
  end;

  return new;
end;
$$;

comment on function public.hire_remote_profiles_search_fields() is
  'BEFORE INSERT OR UPDATE trigger function for hire_remote_profiles. Maintains skills_text, years_experience, english_level_rank from the jsonb source columns. KEEP IN SYNC with /hire-remote client constants (ENGLISH_LEVEL_RANK + expBucketMatch).';

-- ============================================================================
-- 4. Attach the trigger. DROP IF EXISTS first so the migration is re-runnable.
-- ============================================================================

drop trigger if exists hire_remote_profiles_search_fields_trigger
  on public.hire_remote_profiles;

create trigger hire_remote_profiles_search_fields_trigger
  before insert or update on public.hire_remote_profiles
  for each row
  execute function public.hire_remote_profiles_search_fields();

-- ============================================================================
-- 5. Indexes — mirror migration 005's partial / trigram pattern.
--
-- 5a. Partial B-tree on the base query: status='approved' AND approved_at
--     IS NOT NULL, ordered by approved_at desc. Today this is a full table
--     scan on every /hire-remote page load.
-- ============================================================================

create index if not exists idx_hire_remote_status_approved_at
  on public.hire_remote_profiles (approved_at desc)
  where status = 'approved' and approved_at is not null;

-- 5b. Trigram GIN indexes for ILIKE %q% substring search. Supports the
--     server-side `.or(first_name.ilike, last_name.ilike, job_titles.ilike,
--     bio.ilike, city.ilike, country.ilike, skills_text.ilike)` search-box
--     rewrite. gin_trgm_ops allows leading-wildcard ILIKE to use the index.

create index if not exists idx_hire_remote_first_name_trgm
  on public.hire_remote_profiles using gin (first_name gin_trgm_ops);

create index if not exists idx_hire_remote_last_name_trgm
  on public.hire_remote_profiles using gin (last_name gin_trgm_ops);

create index if not exists idx_hire_remote_job_titles_trgm
  on public.hire_remote_profiles using gin (job_titles gin_trgm_ops);

create index if not exists idx_hire_remote_bio_trgm
  on public.hire_remote_profiles using gin (bio gin_trgm_ops);

create index if not exists idx_hire_remote_city_trgm
  on public.hire_remote_profiles using gin (city gin_trgm_ops);

create index if not exists idx_hire_remote_country_trgm
  on public.hire_remote_profiles using gin (country gin_trgm_ops);

-- 5c. Trigram GIN on the computed skills_text. This is the only viable
--     way to do substring search across the skills jsonb array via the
--     Supabase JS client (which can't issue `jsonb_array_elements ... ilike`
--     predicates directly).

create index if not exists idx_hire_remote_skills_text_trgm
  on public.hire_remote_profiles using gin (skills_text gin_trgm_ops);

-- 5d. B-tree on the computed numeric/range filters.

create index if not exists idx_hire_remote_years_experience
  on public.hire_remote_profiles (years_experience);

create index if not exists idx_hire_remote_english_level_rank
  on public.hire_remote_profiles (english_level_rank);

create index if not exists idx_hire_remote_hourly_rate
  on public.hire_remote_profiles (hourly_rate);

-- 5e. B-tree on availability — low cardinality (~3 distinct values today)
--     but cheap, and the filter is on every page load. Index is small.

create index if not exists idx_hire_remote_availability
  on public.hire_remote_profiles (availability);

-- ============================================================================
-- 6. Backfill: populate the 3 new columns for rows that existed before the
--    trigger was attached. The expressions here MUST mirror the trigger
--    function above exactly. Idempotent — re-running this UPDATE produces
--    identical values.
--
--    Performance note: at <1,000 rows this completes in well under a second.
--    At 10K+ rows, run during a low-traffic window. Each row is one read of
--    the source JSONB columns and three column writes; no joins.
-- ============================================================================

update public.hire_remote_profiles set
  -- skills is text[] — array_to_string is null-safe.
  skills_text = lower(coalesce(array_to_string(skills, ' '), '')),
  years_experience = case
    when jsonb_typeof(employment_history) = 'array'
      then jsonb_array_length(employment_history) * 3
    else 0
  end,
  english_level_rank = case
    when jsonb_typeof(languages) = 'array' then (
      select case (elem->>'level')
        when 'Native'       then 4
        when 'Fluent'       then 3
        when 'Professional' then 2
        when 'Basic'        then 1
        else 0
      end
      from jsonb_array_elements(languages) as elem
      where elem->>'name' ilike '%english%'
      limit 1
    )
    else 0
  end;

-- The `english_level_rank` subquery returns NULL when no English entry
-- exists in the languages array (the LIMIT 1 finds no row). Coerce that
-- to 0 in a second pass so the column is never null after backfill.
update public.hire_remote_profiles
   set english_level_rank = 0
 where english_level_rank is null;

-- ============================================================================
-- 7. ANALYZE so the planner picks the new indexes immediately.
-- ============================================================================

analyze public.hire_remote_profiles;

-- ============================================================================
-- 8. Index-purpose comments (for pg_dump readers + future maintainers).
-- ============================================================================

comment on index public.idx_hire_remote_status_approved_at is
  'Migration 012: partial B-tree powering the /hire-remote list query (status=approved AND approved_at IS NOT NULL ORDER BY approved_at DESC).';
comment on index public.idx_hire_remote_first_name_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on first_name (search box).';
comment on index public.idx_hire_remote_last_name_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on last_name (search box).';
comment on index public.idx_hire_remote_job_titles_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on job_titles (role filter + search box).';
comment on index public.idx_hire_remote_bio_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on bio (search box).';
comment on index public.idx_hire_remote_city_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on city (search box).';
comment on index public.idx_hire_remote_country_trgm is
  'Migration 012: trigram GIN for ILIKE %q% on country (search box).';
comment on index public.idx_hire_remote_skills_text_trgm is
  'Migration 012: trigram GIN on the trigger-maintained skills_text column. Powers the /hire-remote skills filter.';
comment on index public.idx_hire_remote_years_experience is
  'Migration 012: B-tree on the trigger-maintained years_experience column (jobs.length * 3 heuristic).';
comment on index public.idx_hire_remote_english_level_rank is
  'Migration 012: B-tree on the trigger-maintained english_level_rank column (Native=4/Fluent=3/Professional=2/Basic=1/none=0).';
comment on index public.idx_hire_remote_hourly_rate is
  'Migration 012: B-tree on hourly_rate. Powers the /hire-remote rate-cap slider filter.';
comment on index public.idx_hire_remote_availability is
  'Migration 012: B-tree on availability (low cardinality). Powers the /hire-remote Now / Later filter.';

-- ============================================================================
-- 9. Smoke-test queries — run these AFTER applying the migration on dev to
--    verify everything populated correctly. Comment them out / do not run on
--    production; they are reference only.
-- ============================================================================
-- -- a) Every row should have non-null computed columns after backfill:
-- select count(*) filter (where skills_text         is null) as null_skills_text,
--        count(*) filter (where years_experience   is null) as null_years_exp,
--        count(*) filter (where english_level_rank is null) as null_eng_rank
--   from public.hire_remote_profiles;
-- -- Expected: 0, 0, 0
--
-- -- b) Spot-check trigger output on one row:
-- select id, skills, skills_text, employment_history, years_experience,
--        languages, english_level_rank
--   from public.hire_remote_profiles
--  limit 5;
--
-- -- c) Confirm the indexes are visible to the planner:
-- explain (analyze, buffers)
--   select id from public.hire_remote_profiles
--    where status = 'approved' and approved_at is not null
--    order by approved_at desc
--    limit 6;
-- -- Expected: "Index Scan using idx_hire_remote_status_approved_at" in plan.
--
-- -- d) Round-trip: insert a test row, confirm trigger fires, then delete.
-- --   (Wrap in a transaction so production data is untouched.)
-- begin;
--   insert into public.hire_remote_profiles
--     (first_name, last_name, email, skills, employment_history, languages, status)
--   values
--     ('Trig', 'Test', 'trigtest-' || gen_random_uuid() || '@example.com',
--      '["React","Node.js","TypeScript"]'::jsonb,
--      '[{"title":"Eng","company":"X","dates":"2020-2023"}]'::jsonb,
--      '[{"name":"English","level":"Fluent"}]'::jsonb,
--      'pending')
--   returning skills_text, years_experience, english_level_rank;
--   -- Expected: skills_text='react node.js typescript', years_experience=3, english_level_rank=3
-- rollback;

-- End of migration 012.
