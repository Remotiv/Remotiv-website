-- ============================================================================
-- Migration 074 - three AI Video Interview settings on each job
--                 (sheet 'AI Interview Pending task' #45, #46)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor. No code reads or writes these columns yet: the wizard, the save
-- and the invite freeze come in later steps, so this can be applied before
-- any of them ships.
--
-- ── What (decided 24 Nov 2026, Waleed) ───────────────────────
--
--   live_interview_mode      'structured' (no follow-ups) or 'ai_guided' (up
--                            to 2 follow-ups a question). Every existing job
--                            becomes 'structured' through the default.
--   live_interview_minutes   30 or 60. Default 30. 60 is a MAXIMUM, not a
--                            target: the interview ends when its questions do.
--                            NOT jobs.interview_duration_minutes, which is the
--                            Team Call's length (booked human interviews).
--   live_hiring_challenges   the recruiter's own words on what is hard about
--                            the role. CONFIDENTIAL: used only to generate
--                            interview questions. Never sent to VoxAgent,
--                            never shown to a candidate or the public. At most
--                            2000 characters (about 300 words); null when not
--                            given.
--
-- ── Why on public.jobs, and why that is private ──────────────
--
-- The production schema dump (scripts/staging/.schema/prod-schema.sql, taken
-- 16 Nov 2026) shows public.jobs with row level security ON, NO policies, and
-- exactly one grant: ALL to service_role. anon and authenticated hold no table
-- or column privilege on it, so neither a signed-out visitor nor a signed-in
-- candidate can read ANY column of jobs through the Supabase API. A column
-- added here inherits that: nothing to grant, nothing to revoke, no policy to
-- change. Every read of jobs is the server's service-role client, and the
-- public ones go through the F7 keep-list (lib/jobs.ts), which these three
-- are not on (src/lib/jobs-public.test.ts fails if they are).
--
-- A separate settings table would be the WEAKER choice here: Supabase's
-- default privileges grant ALL on every new public table to anon and
-- authenticated (the same dump; migration 072 had to revoke exactly that for
-- calendar_connections), so a new table starts readable and needs its own
-- revoke and RLS. The CHECK query at the bottom confirms the grants are
-- still as the dump says before anything is stored in the column.
--
-- ── Cost of applying ─────────────────────────────────────────
--
-- Constant defaults: Postgres 11 and later adds these columns without
-- rewriting the table. Each CHECK is validated against the existing rows (all
-- of which take the default, so they pass) under a brief lock on jobs.
--
-- Idempotent: safe to run twice.
-- ============================================================================

begin;

alter table public.jobs
  add column if not exists live_interview_mode text not null default 'structured',
  add column if not exists live_interview_minutes smallint not null default 30,
  add column if not exists live_hiring_challenges text;

alter table public.jobs
  drop constraint if exists jobs_live_interview_mode_values;
alter table public.jobs
  add constraint jobs_live_interview_mode_values
  check (live_interview_mode in ('structured', 'ai_guided'));

alter table public.jobs
  drop constraint if exists jobs_live_interview_minutes_values;
alter table public.jobs
  add constraint jobs_live_interview_minutes_values
  check (live_interview_minutes in (30, 60));

alter table public.jobs
  drop constraint if exists jobs_live_hiring_challenges_length;
alter table public.jobs
  add constraint jobs_live_hiring_challenges_length
  check (live_hiring_challenges is null or char_length(live_hiring_challenges) <= 2000);

comment on column public.jobs.live_interview_mode is
  'AI Video Interview mode: structured (no follow-ups) or ai_guided (up to 2 per question). Frozen onto the session at invite.';
comment on column public.jobs.live_interview_minutes is
  'AI Video Interview length in minutes, 30 or 60, a maximum. Not interview_duration_minutes (the Team Call).';
comment on column public.jobs.live_hiring_challenges is
  'CONFIDENTIAL recruiter text, used only to generate interview questions. Never sent to the interview provider, a candidate or the public.';

commit;

-- ============================================================================
-- CHECK (read-only). Run after applying; every row of the result must be true.
-- ----------------------------------------------------------------------------
--
-- select
--   -- the three columns, with their types, nullability and defaults
--   (select count(*) = 3 from information_schema.columns
--     where table_schema = 'public' and table_name = 'jobs'
--       and (column_name, data_type, is_nullable) in (
--         ('live_interview_mode', 'text', 'NO'),
--         ('live_interview_minutes', 'smallint', 'NO'),
--         ('live_hiring_challenges', 'text', 'YES'))) as columns_ok,
--   (select column_default from information_schema.columns
--     where table_schema = 'public' and table_name = 'jobs'
--       and column_name = 'live_interview_mode') = '''structured''::text' as mode_default_ok,
--   (select column_default from information_schema.columns
--     where table_schema = 'public' and table_name = 'jobs'
--       and column_name = 'live_interview_minutes') = '30' as minutes_default_ok,
--   -- the three checks
--   (select count(*) = 3 from pg_constraint
--     where conrelid = 'public.jobs'::regclass and contype = 'c'
--       and conname in ('jobs_live_interview_mode_values',
--                       'jobs_live_interview_minutes_values',
--                       'jobs_live_hiring_challenges_length')) as checks_ok,
--   -- every existing job took the defaults
--   (select count(*) = 0 from public.jobs
--     where live_interview_mode <> 'structured'
--        or live_interview_minutes <> 30
--        or live_hiring_challenges is not null) as existing_jobs_default,
--   -- the public roles still hold nothing on jobs, table or column
--   (select count(*) = 0 from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'jobs'
--       and grantee in ('anon', 'authenticated', 'PUBLIC')) as no_table_grants,
--   (select count(*) = 0 from information_schema.column_privileges
--     where table_schema = 'public' and table_name = 'jobs'
--       and grantee in ('anon', 'authenticated', 'PUBLIC')) as no_column_grants,
--   -- RLS still on, and still no policy on jobs
--   (select relrowsecurity from pg_class where oid = 'public.jobs'::regclass) as rls_on,
--   (select count(*) = 0 from pg_policies
--     where schemaname = 'public' and tablename = 'jobs') as no_policies;
-- ============================================================================
