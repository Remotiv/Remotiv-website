-- ============================================================================
-- Migration 047 - access-log retention: 24 months, then deleted
--                 (admin_access_logs and signed_url_logs)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor. Numbered 047 (reserved
-- before 048 and 049 were written); it touches none of their tables, so it
-- applies after 049 in production and in number order on a fresh rebuild.
-- All or nothing: one transaction. Safe to run twice.
--
-- ── Before running: read-only checks ─────────────────────────
-- 1. Both tables' triggers, policies and foreign keys:
--    select c.relname, c.relrowsecurity as rls,
--           (select string_agg(tgname, ', ' order by tgname) from pg_trigger t
--             where t.tgrelid = c.oid and not t.tgisinternal) as triggers,
--           (select string_agg(conname || ': ' || pg_get_constraintdef(oid), '; ')
--              from pg_constraint k where k.conrelid = c.oid and k.contype = 'f') as fks
--      from pg_class c where c.relname in ('admin_access_logs', 'signed_url_logs');
--    expected: admin_access_logs has the 046 triggers and no fks;
--              signed_url_logs has no triggers and one fk to auth.users on delete cascade.
-- 2. The job types: exactly the nineteen 040 left.
--    select pg_get_constraintdef(oid) from pg_constraint where conname = 'background_jobs_type_check';
--
-- ── The rule (decision, 24 Oct 2026) ─────────────────────────
--
-- A record of who opened a CV or a recording is kept for 24 months, then
-- deleted. Both tables, one rule:
--
--   * Age is computed ONLY in the database, from now() and the row's own
--     timestamp (admin_access_logs.created_at, signed_url_logs.granted_at),
--     both stamped by the database on insert. No caller passes a cutoff.
--   * A row is deleted only by purge_expired_access_logs(), SECURITY DEFINER,
--     executable by service_role alone. The guard trigger on each table
--     refuses every other delete: the function's transaction-local flag must
--     be set, the delete must run as the function's owner (so a direct
--     service-role delete is refused even with the flag set by hand), and the
--     row must be older than 24 months (so even the owner cannot remove a
--     younger row).
--   * UPDATE and TRUNCATE stay refused on both tables, with no exception.
--
-- The one thing this cannot stop: the owner of these tables (the role that
-- runs migrations) can drop or disable a trigger. No trigger can guard
-- against the role that owns it; that is a property of Postgres, not of this
-- file.
--
-- ── signed_url_logs gets what 046 gave admin_access_logs ─────
--
--   * granted_at stamped by the database (no code sets it today, so nothing in
--     the application changes), so a row cannot be backdated into early
--     deletion or forward-dated out of it.
--   * The foreign key to auth.users (on delete cascade) is dropped (decision
--     1(a)): deleting an account no longer erases the record of what it
--     opened. The record goes at 24 months like every other. user_id may then
--     name a deleted account, exactly as admin_access_logs.user_id may.
--
-- ── access_log_purge: the twentieth job type ─────────────────
--
-- The daily job that calls the function. background_jobs_type_check is
-- replaced with 040's guarded pattern: it must hold exactly 040's nineteen
-- values, or this refuses. On a re-run it already holds access_log_purge, and
-- then it must hold EXACTLY the approved twenty (040's nineteen and
-- access_log_purge), none missing and none extra, or this refuses too: a
-- re-run never passes over a constraint someone has changed since.
-- ============================================================================

begin;

-- ── 1. signed_url_logs: stamp the time ───────────────────────

create or replace function public.signed_url_logs_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.granted_at := now();
  return new;
end;
$$;

drop trigger if exists signed_url_logs_stamp on public.signed_url_logs;
create trigger signed_url_logs_stamp
  before insert on public.signed_url_logs
  for each row execute function public.signed_url_logs_stamp();

-- ── 2. signed_url_logs: no cascade from auth.users ───────────

do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.signed_url_logs'::regclass
       and contype = 'f'
       and confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.signed_url_logs drop constraint %I', v_name);
    raise notice '047: dropped %', v_name;
  end loop;
end
$$;

-- ── 3. The one test both guards apply ────────────────────────

-- True only inside purge_expired_access_logs(): its flag is set, the delete
-- runs as the function's owner, and the row is older than 24 months by the
-- database's own clock. Not SECURITY DEFINER: current_user must be whoever is
-- actually deleting.
create or replace function public.access_log_delete_allowed(p_stamped_at timestamptz)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_owner text;
begin
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = to_regprocedure('public.purge_expired_access_logs(integer)');
  return coalesce(current_setting('remotiv.access_log_purge', true), '') = 'on'
     and v_owner is not null
     and current_user = v_owner
     and p_stamped_at is not null
     and p_stamped_at < now() - interval '24 months';
end;
$$;

-- ── 4. admin_access_logs: append-only, except the 24-month purge ──

-- Replaces 046's function of the same name, so 046's three triggers keep
-- calling it. UPDATE and TRUNCATE: refused, as before.
create or replace function public.admin_access_logs_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.access_log_delete_allowed(old.created_at) then
    return old;
  end if;
  raise exception 'admin_access_logs is append-only: rows are never updated or truncated, and are deleted only by purge_expired_access_logs() after 24 months';
end;
$$;

-- ── 5. signed_url_logs: the same guard ───────────────────────

create or replace function public.signed_url_logs_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.access_log_delete_allowed(old.granted_at) then
    return old;
  end if;
  raise exception 'signed_url_logs is append-only: rows are never updated or truncated, and are deleted only by purge_expired_access_logs() after 24 months';
end;
$$;

drop trigger if exists signed_url_logs_no_update on public.signed_url_logs;
create trigger signed_url_logs_no_update
  before update on public.signed_url_logs
  for each row execute function public.signed_url_logs_guard();

drop trigger if exists signed_url_logs_no_delete on public.signed_url_logs;
create trigger signed_url_logs_no_delete
  before delete on public.signed_url_logs
  for each row execute function public.signed_url_logs_guard();

drop trigger if exists signed_url_logs_no_truncate on public.signed_url_logs;
create trigger signed_url_logs_no_truncate
  before truncate on public.signed_url_logs
  for each statement execute function public.signed_url_logs_guard();

-- ── 6. The purge ─────────────────────────────────────────────

-- Deletes up to p_limit rows older than 24 months from EACH table, oldest
-- first, and returns how many. No cutoff parameter: the age is the database's.
-- p_limit is clamped to 1..5000; it changes how many go per call, never which.
create or replace function public.purge_expired_access_logs(p_limit integer default 1000)
returns table (admin_access_logs_deleted integer, signed_url_logs_deleted integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_admin  integer;
  v_signed integer;
begin
  perform set_config('remotiv.access_log_purge', 'on', true);

  with doomed as (
    select id from public.admin_access_logs
     where created_at < now() - interval '24 months'
     order by created_at
     limit v_limit
     for update skip locked
  )
  delete from public.admin_access_logs a using doomed d where a.id = d.id;
  get diagnostics v_admin = row_count;

  with doomed as (
    select id from public.signed_url_logs
     where granted_at < now() - interval '24 months'
     order by granted_at
     limit v_limit
     for update skip locked
  )
  delete from public.signed_url_logs s using doomed d where s.id = d.id;
  get diagnostics v_signed = row_count;

  perform set_config('remotiv.access_log_purge', 'off', true);
  return query select v_admin, v_signed;
end;
$$;

revoke all on function public.purge_expired_access_logs(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_access_logs(integer) to service_role;
revoke all on function public.access_log_delete_allowed(timestamptz) from public, anon, authenticated;

comment on table public.signed_url_logs is
  'Audit log of CV and recording signed-URL grants. Append-only; granted_at stamped by the database; deleted only by purge_expired_access_logs() after 24 months (047).';

-- ── 7. access_log_purge: the twentieth job type ──────────────

do $$
declare
  v_def   text;
  v_count integer;
  v_val   text;
  v_have  text[];
  v_want  text[];
  v_types text[] := array[
    'ai_cv_score',
    'send_message',
    'interview_reminder',
    'interview_expiry',
    'interview_expiry_sweep',
    'cv_score_recompute',
    'transcribe',
    'ai_scorecard',
    'calendar_sync',
    'interview_purge',
    'cv_purge',
    'queue_sweep',
    'talent_retention_warn',
    'talent_retention_purge',
    'final_bot_sync',
    'final_bot_lobby_check',
    'final_recording_import',
    'final_recording_import_watchdog',
    'final_recording_purge'
  ];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.background_jobs'::regclass
     and conname  = 'background_jobs_type_check';
  if v_def is null then
    raise exception '047: background_jobs_type_check not found. Inspect the live constraints; this file will not guess a name.';
  end if;
  -- Every quoted value in the live definition, as a set.
  select coalesce(array_agg(distinct m[1] order by m[1]), '{}') into v_have
    from regexp_matches(v_def, '''([a-z_]+)''::text', 'g') as m;
  if 'access_log_purge' = any(v_have) then
    -- A re-run: the constraint must be exactly the approved twenty.
    select array_agg(x order by x) into v_want from unnest(v_types || array['access_log_purge']) as x;
    if v_have is distinct from v_want then
      raise exception
        '047: background_jobs_type_check already allows access_log_purge but is not exactly the approved twenty. Missing: %. Extra: %. Live definition: %',
        (select coalesce(array_agg(x), '{}') from unnest(v_want) as x where not x = any(v_have)),
        (select coalesce(array_agg(x), '{}') from unnest(v_have) as x where not x = any(v_want)),
        v_def;
    end if;
    raise notice '047: background_jobs_type_check is exactly the approved twenty; nothing to change.';
    return;
  end if;
  v_count := (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text');
  if v_count <> array_length(v_types, 1) then
    raise exception
      '047: expected exactly % job types in background_jobs_type_check but the live constraint has %. Not replacing an unexpected definition. Live definition: %',
      array_length(v_types, 1), v_count, v_def;
  end if;
  foreach v_val in array v_types loop
    if position(quote_literal(v_val) || '::text' in v_def) = 0 then
      raise exception
        '047: background_jobs_type_check does not include expected value %. Not replacing an unexpected definition. Live definition: %',
        v_val, v_def;
    end if;
  end loop;
  alter table public.background_jobs drop constraint background_jobs_type_check;
  execute format(
    'alter table public.background_jobs add constraint background_jobs_type_check check (type in (%s))',
    (select string_agg(quote_literal(x), ', ') from unnest(v_types || array['access_log_purge']) as x)
  );
  raise notice '047: background_jobs_type_check now allows % values.', array_length(v_types, 1) + 1;
end
$$;

commit;

-- ── After running: read-only checks ──────────────────────────
-- 1. Triggers. admin_access_logs: admin_access_logs_no_delete, _no_truncate,
--    _no_update, _stamp. signed_url_logs: signed_url_logs_no_delete,
--    _no_truncate, _no_update, _stamp.
--    select tgrelid::regclass, tgname from pg_trigger
--     where tgrelid in ('public.admin_access_logs'::regclass, 'public.signed_url_logs'::regclass)
--       and not tgisinternal order by 1, 2;
-- 2. No foreign key left on signed_url_logs:
--    select conname from pg_constraint
--     where conrelid = 'public.signed_url_logs'::regclass and contype = 'f';   -- 0 rows
-- 3. The function: SECURITY DEFINER, search_path pinned, executable by service_role only.
--    select p.prosecdef, p.proconfig,
--           has_function_privilege('anon', p.oid, 'execute') as anon,
--           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
--           has_function_privilege('service_role', p.oid, 'execute') as service_role
--      from pg_proc p where p.oid = 'public.purge_expired_access_logs(integer)'::regprocedure;
--    expected: true, {"search_path=public, pg_temp"}, false, false, true
-- 4. Twenty job types, access_log_purge among them:
--    select pg_get_constraintdef(oid) from pg_constraint where conname = 'background_jobs_type_check';
-- 5. Nothing deletable yet (the oldest signed_url_logs row is from 2026-05-19):
--    select (select count(*) from public.signed_url_logs where granted_at < now() - interval '24 months') as signed_due,
--           (select count(*) from public.admin_access_logs where created_at < now() - interval '24 months') as admin_due;
