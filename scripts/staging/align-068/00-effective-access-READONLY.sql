-- ============================================================================
-- #68 alignment, step 00: EFFECTIVE access on the audit's grants list
-- ----------------------------------------------------------------------------
-- READ-ONLY. Run on BOTH databases, production and staging, in the Supabase
-- SQL editor: one paste, one execution. It writes nothing (set transaction
-- read only, then rollback) and reads no table rows: catalog and privilege
-- functions only.
--
-- Closes: the audit's "Grants" group (14 Nov 2026). The dump comparison read
-- the ACL text pg_dump prints; this reads what the database actually lets each
-- role do, which also counts PUBLIC and inherited grants, so the two databases
-- can be compared on effect rather than on how the grants were written.
--
-- Objects: every table and function the audit named in its grants rows.
--   - 14 tables whose grants differ (staging grants anon and authenticated ALL)
--   - 11 functions whose grants differ (the same)
--   - candidate_erasures and the 7 functions of 056 and 057 that exist only on
--     production. On staging they read ABSENT until 01 and 02 have run.
-- Grantees: public (the PUBLIC pseudo-role), anon, authenticated, service_role.
--
-- Output: one row per (object, grantee) with the effective privileges, then
-- one last row, kind 'zz_fingerprint', whose name is an md5 of every row
-- above it. Two databases with the same fingerprint have the same effective
-- access on this list; if they differ, compare the rows.
--
-- Expected on PRODUCTION, read from the ACL lines of the production dump of
-- 14 Nov 2026 (not from the migrations, which say less than the database did):
--   tables:  service_role SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN
--            (candidate_erasures included: 056's grant of select and insert
--            sits on top of Supabase's default ALL, which 056 never revoked
--            from service_role)
--            except company_plans and company_plan_history: SELECT,REFERENCES,TRIGGER,MAINTAIN
--            public, anon, authenticated: none
--   functions, the 11 and preview_orphaned_message_rows and
--            erase_orphaned_message_rows: service_role EXECUTE;
--            public, anon, authenticated: none
--   functions company_members_stamp_removed, erased_address,
--            stamp_orphaned_at, sweep_not_covered, sweepable_notification_types:
--            EXECUTE for all four grantees (the dump has no REVOKE for them,
--            so PUBLIC keeps its default EXECUTE)
-- Expected on STAGING today: anon and authenticated hold every privilege on
-- the 14 tables and EXECUTE on the 11 functions; the 8 056/057 objects ABSENT.
-- ============================================================================

begin;
set transaction read only;

with objects(kind, name, sig) as (
  values
    ('table', 'bookings',                     'public.bookings'),
    ('table', 'candidate_erasures',           'public.candidate_erasures'),
    ('table', 'company_plan_history',         'public.company_plan_history'),
    ('table', 'company_plans',                'public.company_plans'),
    ('table', 'contact_submissions',          'public.contact_submissions'),
    ('table', 'final_interview_bots',         'public.final_interview_bots'),
    ('table', 'final_interview_evaluations',  'public.final_interview_evaluations'),
    ('table', 'final_interview_interviewers', 'public.final_interview_interviewers'),
    ('table', 'final_interview_recordings',   'public.final_interview_recordings'),
    ('table', 'final_interviews',             'public.final_interviews'),
    ('table', 'hire_requests',                'public.hire_requests'),
    ('table', 'job_applications',             'public.job_applications'),
    ('table', 'jobs',                         'public.jobs'),
    ('table', 'pricing_settings',             'public.pricing_settings'),
    ('table', 'profiles',                     'public.profiles'),
    ('function', 'access_log_delete_allowed',         'public.access_log_delete_allowed(timestamptz)'),
    ('function', 'company_members_stamp_removed',     'public.company_members_stamp_removed()'),
    ('function', 'consume_allowance',                 'public.consume_allowance(uuid, text, uuid)'),
    ('function', 'erase_orphaned_message_rows',       'public.erase_orphaned_message_rows(uuid, uuid, timestamptz)'),
    ('function', 'erased_address',                    'public.erased_address()'),
    ('function', 'final_interview_bots_orphan_guard', 'public.final_interview_bots_orphan_guard()'),
    ('function', 'final_interview_bots_validate',     'public.final_interview_bots_validate()'),
    ('function', 'final_interview_member_validate',   'public.final_interview_member_validate()'),
    ('function', 'final_interviews_validate',         'public.final_interviews_validate()'),
    ('function', 'log_company_plan_change',           'public.log_company_plan_change()'),
    ('function', 'preview_orphaned_message_rows',     'public.preview_orphaned_message_rows(timestamptz)'),
    ('function', 'purge_expired_access_logs',         'public.purge_expired_access_logs(integer)'),
    ('function', 'release_allowance',                 'public.release_allowance(uuid)'),
    ('function', 'remove_company_plan',               'public.remove_company_plan(uuid, uuid)'),
    ('function', 'set_company_plan',                  'public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)'),
    ('function', 'stamp_orphaned_at',                 'public.stamp_orphaned_at()'),
    ('function', 'sweep_not_covered',                 'public.sweep_not_covered()'),
    ('function', 'sweepable_notification_types',      'public.sweepable_notification_types()')
),
grantees(grantee) as (
  values ('public'), ('anon'), ('authenticated'), ('service_role')
),
privs(kind, priv, ord) as (
  values
    ('table', 'SELECT', 1), ('table', 'INSERT', 2), ('table', 'UPDATE', 3), ('table', 'DELETE', 4),
    ('table', 'TRUNCATE', 5), ('table', 'REFERENCES', 6), ('table', 'TRIGGER', 7), ('table', 'MAINTAIN', 8),
    ('function', 'EXECUTE', 1)
),
resolved as (
  select o.kind, o.name,
         case o.kind
           when 'table' then to_regclass(o.sig)::oid
           else to_regprocedure(o.sig)::oid
         end as obj_oid
    from objects o
),
checks as (
  select r.kind, r.name, g.grantee, p.priv, p.ord, r.obj_oid,
         case
           when r.obj_oid is null then null
           when r.kind = 'table' then has_table_privilege(g.grantee::name, r.obj_oid, p.priv)
           else has_function_privilege(g.grantee::name, r.obj_oid, p.priv)
         end as granted
    from resolved r
    cross join grantees g
    join privs p on p.kind = r.kind
),
summary as (
  select kind, name, grantee,
         case
           when bool_and(obj_oid is null) then 'ABSENT'
           else coalesce(string_agg(priv, ',' order by ord) filter (where granted), 'none')
         end as effective
    from checks
   group by kind, name, grantee
)
select kind, name, grantee, effective
  from summary
union all
select 'zz_fingerprint',
       md5(string_agg(kind || '|' || name || '|' || grantee || '|' || effective, E'\n'
                      order by kind, name, grantee)),
       count(*)::text || ' rows',
       ''
  from summary
order by 1, 2, 3;

rollback;

-- ── Reading it ───────────────────────────────────────────────
--
-- 33 objects x 4 grantees = 132 rows, then the fingerprint row. Fewer rows
-- means an object list or a grantee changed: stop and look.
-- Run it on production first and keep the output. Run it on staging before
-- 01 (the baseline), and again after 04: from then on staging's fingerprint
-- must equal production's.
-- An error naming a role ("role ... does not exist") means that database is
-- not a Supabase project with the standard roles: stop.
