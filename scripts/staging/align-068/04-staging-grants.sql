-- ============================================================================
-- #68 alignment, step 04: grants on STAGING made equal to PRODUCTION's
-- ----------------------------------------------------------------------------
-- STAGING ONLY. Refuses to write anything on a database without
-- staging_guard.sentinel (README-steps.md step 3), the same refusal 059 uses.
--
-- Closes, from the #68 audit (14 Nov 2026), the 25 "staging looser" grant
-- rows: anon and authenticated hold ALL on 14 tables and EXECUTE on 11
-- functions on staging, and nothing on production.
--
-- What it runs:
--   1. The grant and revoke sections of 037 (:551-566), 038 (:426-432),
--      040 (:423-426) and 047 (:219-221), copied VERBATIM. On staging those
--      migrations' objects exist but these lines evidently never ran.
--      037:568-572 (grant execute to service_role on four functions) is
--      left out: service_role already holds EXECUTE on all four on staging
--      (staging dump, GRANT ALL TO service_role), so it changes nothing.
--   2. The revoke production holds on bookings, contact_submissions,
--      hire_requests, job_applications, jobs and profiles that NO migration
--      writes (see 05-production-record-hand-revoke.md).
--   3. An invariant: the effective privileges of public, anon, authenticated
--      and service_role on all 25 objects must equal production's, read from
--      the production dump's ACL lines, or nothing commits.
--
-- Production's state, which section 3 asserts (production dump, 14 Nov 2026):
--   12 tables:  GRANT ALL TO service_role; nothing else
--   company_plans, company_plan_history:
--               GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN TO service_role; nothing else
--   11 functions: REVOKE ALL FROM PUBLIC; GRANT ALL TO service_role; nothing else
-- Staging already matches the function rows' PUBLIC revoke (staging dump), so
-- the only changes are: anon and authenticated lose everything on the 25,
-- and service_role loses INSERT, UPDATE, DELETE and TRUNCATE on company_plans
-- and company_plan_history (037:557-558).
--
-- Re-runnable: revoke and grant are idempotent.
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ── 0. STAGING ONLY ──────────────────────────────────────────

do $$
begin
  if to_regclass('staging_guard.sentinel') is null then
    raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was written';
  end if;
end;
$$;

-- ── 1a. 037:551-566, verbatim ────────────────────────────────

revoke all on table public.company_plans        from anon, authenticated;
revoke all on table public.company_plan_history from anon, authenticated;
revoke all on table public.pricing_settings     from anon, authenticated;

-- The service role may READ plans and history but not write them directly:
-- set_company_plan and remove_company_plan are the write paths, so every
-- change names its actor.
revoke insert, update, delete, truncate on table public.company_plans        from service_role;
revoke insert, update, delete, truncate on table public.company_plan_history from service_role;

revoke all on function public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)
  from public, anon, authenticated;
revoke all on function public.remove_company_plan(uuid, uuid)     from public, anon, authenticated;
revoke all on function public.consume_allowance(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_allowance(uuid)             from public, anon, authenticated;
revoke all on function public.log_company_plan_change()           from public, anon, authenticated;

-- ── 1b. 038:426-432, verbatim ────────────────────────────────

revoke all on table public.final_interviews             from anon, authenticated;
revoke all on table public.final_interview_interviewers from anon, authenticated;
revoke all on table public.final_interview_recordings   from anon, authenticated;
revoke all on table public.final_interview_evaluations  from anon, authenticated;

revoke all on function public.final_interviews_validate()        from public, anon, authenticated;
revoke all on function public.final_interview_member_validate()  from public, anon, authenticated;

-- ── 1c. 040:423-426, verbatim ────────────────────────────────

revoke all on table public.final_interview_bots from anon, authenticated;

revoke all on function public.final_interview_bots_validate()     from public, anon, authenticated;
revoke all on function public.final_interview_bots_orphan_guard() from public, anon, authenticated;

-- ── 1d. 047:219-221, verbatim ────────────────────────────────

revoke all on function public.purge_expired_access_logs(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_access_logs(integer) to service_role;
revoke all on function public.access_log_delete_allowed(timestamptz) from public, anon, authenticated;

-- ── 2. Production's hand-run revoke, which no migration holds ─
--
-- Written to production's dump: these six tables carry exactly
-- "GRANT ALL ... TO service_role" there and no other grantee (production dump
-- ACL entries at lines 7916, 8054, 8105, 8184, 8209, 8291). Staging holds no
-- PUBLIC grant on them either, so revoking from anon and authenticated is
-- the whole difference.

revoke all on table public.bookings            from anon, authenticated;
revoke all on table public.contact_submissions from anon, authenticated;
revoke all on table public.hire_requests       from anon, authenticated;
revoke all on table public.job_applications    from anon, authenticated;
revoke all on table public.jobs                from anon, authenticated;
revoke all on table public.profiles            from anon, authenticated;

-- ── 3. THE INVARIANT, asserted before commit ─────────────────
--
-- Effective privileges, the same functions 00 uses, against production's
-- state above. Any mismatch is named and nothing commits.

do $$
declare
  bad text;
begin
  bad := (
  with expected(kind, sig, grantee, privs) as (
    select 'table', t, g,
           case
             when g <> 'service_role' then 'none'
             when t in ('public.company_plans', 'public.company_plan_history')
               then 'SELECT,REFERENCES,TRIGGER,MAINTAIN'
             else 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
           end
      from unnest(array[
             'public.bookings', 'public.company_plan_history', 'public.company_plans',
             'public.contact_submissions', 'public.final_interview_bots',
             'public.final_interview_evaluations', 'public.final_interview_interviewers',
             'public.final_interview_recordings', 'public.final_interviews',
             'public.hire_requests', 'public.job_applications', 'public.jobs',
             'public.pricing_settings', 'public.profiles']) as t
     cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as g
    union all
    select 'function', f, g, case when g = 'service_role' then 'EXECUTE' else 'none' end
      from unnest(array[
             'public.access_log_delete_allowed(timestamptz)',
             'public.consume_allowance(uuid, text, uuid)',
             'public.final_interview_bots_orphan_guard()',
             'public.final_interview_bots_validate()',
             'public.final_interview_member_validate()',
             'public.final_interviews_validate()',
             'public.log_company_plan_change()',
             'public.purge_expired_access_logs(integer)',
             'public.release_allowance(uuid)',
             'public.remove_company_plan(uuid, uuid)',
             'public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)']) as f
     cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as g
  ),
  privs(kind, priv, ord) as (
    values
      ('table', 'SELECT', 1), ('table', 'INSERT', 2), ('table', 'UPDATE', 3), ('table', 'DELETE', 4),
      ('table', 'TRUNCATE', 5), ('table', 'REFERENCES', 6), ('table', 'TRIGGER', 7), ('table', 'MAINTAIN', 8),
      ('function', 'EXECUTE', 1)
  ),
  actual as (
    select e.kind, e.sig, e.grantee, e.privs as want,
           case
             when (case e.kind when 'table' then to_regclass(e.sig)::oid
                               else to_regprocedure(e.sig)::oid end) is null then 'ABSENT'
             else coalesce(
               string_agg(p.priv, ',' order by p.ord) filter (
                 where case e.kind
                         when 'table' then has_table_privilege(e.grantee::name, to_regclass(e.sig)::oid, p.priv)
                         else has_function_privilege(e.grantee::name, to_regprocedure(e.sig)::oid, p.priv)
                       end),
               'none')
           end as got
      from expected e
      join privs p on p.kind = e.kind
     group by e.kind, e.sig, e.grantee, e.privs
  )
  select string_agg(format('%s %s for %s: want %s, got %s', kind, sig, grantee, want, got), '; '
                    order by kind, sig, grantee)
    from actual
   where want <> got
  );

  if bad is not null then
    raise exception 'align-068 04: rolled back; effective access differs from production: %', bad;
  end if;
end;
$$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING
-- ════════════════════════════════════════════════════════════════════════════
--
-- Run 00-effective-access-READONLY.sql on staging. After 01, 02 and this
-- file, its zz_fingerprint row must equal production's. If only this file
-- has run, the 25 rows above match production's and the 056/057 rows do not.
--
-- Then exercise the staging app once on the paths these tables serve (the
-- dashboard, an application, a booking, the hire and contact forms). Every
-- one of them should use the service role, as on production, where these
-- grants have already been absent; a failure here is a staging code path
-- that relied on the anon or authenticated grant, and is a finding, not a
-- reason to grant it back.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK, staging only: restores staging's state of 14 Nov 2026 exactly
-- (staging dump: GRANT ALL to anon, authenticated and service_role). It
-- re-opens the 25 differences; use it only to undo a step that broke staging.
-- ════════════════════════════════════════════════════════════════════════════
--
-- begin;
-- set local lock_timeout = '5s';
-- do $$ begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: nothing was written';
--   end if;
-- end $$;
-- grant all on table public.bookings, public.company_plan_history, public.company_plans,
--   public.contact_submissions, public.final_interview_bots, public.final_interview_evaluations,
--   public.final_interview_interviewers, public.final_interview_recordings, public.final_interviews,
--   public.hire_requests, public.job_applications, public.jobs, public.pricing_settings,
--   public.profiles
--   to anon, authenticated, service_role;
-- grant all on function
--   public.access_log_delete_allowed(timestamptz), public.consume_allowance(uuid, text, uuid),
--   public.final_interview_bots_orphan_guard(), public.final_interview_bots_validate(),
--   public.final_interview_member_validate(), public.final_interviews_validate(),
--   public.log_company_plan_change(), public.purge_expired_access_logs(integer),
--   public.release_allowance(uuid), public.remove_company_plan(uuid, uuid),
--   public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)
--   to anon, authenticated;
-- commit;
