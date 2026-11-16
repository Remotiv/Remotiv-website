-- ============================================================================
-- Migration 060 - interview_sessions.kind is immutable, enforced at last (#103)
-- ----------------------------------------------------------------------------
-- APPLIED to staging and production 16 Nov 2026 (see below). Run by hand in
-- the Supabase SQL editor: one paste, one execution, one transaction. STAGING
-- FIRST, with the negative controls below; production only after they pass.
-- Nothing in the repository executes it.
--
-- APPLIED TO STAGING: 16 Nov 2026, Waleed
-- APPLIED TO PRODUCTION: 16 Nov 2026, Waleed
-- Fill each in when it happens: date, by whom.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- Migration 017 says "set at invite, never changed" and that this is
-- "ENFORCED, NOT DOCUMENTED" (017:21-24): a trigger refuses any UPDATE that
-- alters kind. The #68 schema comparison of 14 Nov 2026 found that trigger
-- and its function on NEITHER database (production and staging dumps, both
-- taken 14 Nov 2026). Everything else 017 creates is there: the column, its
-- CHECK, and its index, though under another name. 017's
-- idx_is_application_kind (017:41-42) exists on both as
-- interview_sessions_application_kind_idx, with the identical definition:
-- btree (application_id, kind, created_at DESC), not unique, no WHERE. 017's
-- file has had one commit (ed3b069, 16 Sep 2026) and no file or commit has
-- ever held the other name, so what was applied was not 017 as written. Why
-- is not recorded anywhere.
--
-- This file restores the function and the trigger. It does NOT recreate the
-- index: the equivalent one is already there, and a second copy would only
-- double its write cost.
--
-- What already holds without this trigger (both dumps): kind changing alone
-- is refused by interview_sessions_live_settings_kind (018:73-75); a live
-- session with turns cannot change kind (interview_turns references (id, kind),
-- 021:81-84, :115-118); the live-only CHECKs refuse async on any row with a
-- provider, an outcome, an end, an attempt 2 or 'abandoned'. The gap this
-- closes: ONE update that changes kind together with live_settings on a
-- session with none of those, e.g. an invited live session turned async.
-- No code does that today: every write to interview_sessions in src/ and
-- scripts/ sets kind on insert only (#103 audit, 16 Nov 2026).
--
-- ── What the trigger does ────────────────────────────────────
--
-- BEFORE UPDATE OF kind: fires only for an UPDATE whose SET list names kind.
-- Refuses with check_violation when the new kind differs from the old; setting
-- kind to its current value passes. Inserts are untouched. The function is
-- 017's (017:44-56) word for word, plus `set search_path = public` as 056 and
-- 057 do. Its grants are Supabase's defaults, like every trigger function on
-- production (interview_sessions_attempt_rules included).
--
-- ── Before running: the state this rests on ──────────────────
--
-- begin;
-- set transaction read only;
-- select
--   (select count(*) from public.interview_sessions)                         as sessions_total,
--   (select count(*) from public.interview_sessions where kind = 'async')    as async_sessions,
--   (select count(*) from public.interview_sessions where kind = 'live')     as live_sessions,
--   (select count(*) from public.usage_events u
--      join public.interview_sessions s on s.id = u.ref_id
--     where u.type = 'interview_sent' and s.kind = 'live')                   as async_credit_on_live,   -- 0
--   (select count(*) from public.usage_events u
--      join public.interview_sessions s on s.id = u.ref_id
--     where u.type = 'interview_sent' and s.kind = 'async')                  as async_credit_on_async,  -- informational
--   (select count(*) from public.interview_sessions
--     where kind = 'live' and created_at < '2026-09-16')                     as live_before_017,        -- 0
--   (select count(*) from pg_trigger
--     where tgrelid = 'public.interview_sessions'::regclass
--       and tgname = 'interview_sessions_kind_immutable')                    as kind_trigger,           -- 0
--   to_regprocedure('public.interview_sessions_kind_immutable()') is not null as kind_function,         -- false
--   to_regclass('public.idx_is_application_kind') is not null               as index_017_name,         -- false
--   to_regclass('public.interview_sessions_application_kind_idx') is not null as index_same_columns;   -- true
-- rollback;
--
-- async_credit_on_live counts invitation credits, which only the async invite
-- writes (interview-actions.ts:124-127), pointing at a session that is now
-- live. Above 0 is a lead to look at before applying, not proof of a change.
-- ============================================================================

begin;

-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on interview_sessions until
-- commit. If a long transaction already holds a conflicting lock, fail fast
-- instead of queueing every session write behind it; run the file again.
set local lock_timeout = '5s';

-- ── 1. The function: 017's, plus a fixed search_path ─────────

create or replace function public.interview_sessions_kind_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'interview_sessions.kind is set at invite and cannot be changed (session %, % -> %)',
      old.id, old.kind, new.kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ── 2. The trigger: 017's ────────────────────────────────────

drop trigger if exists interview_sessions_kind_immutable on public.interview_sessions;

create trigger interview_sessions_kind_immutable
  before update of kind on public.interview_sessions
  for each row
  execute function public.interview_sessions_kind_immutable();

-- ── 3. THE INVARIANT, asserted before commit ─────────────────
--
-- Exactly one trigger of this name, on interview_sessions, enabled, calling
-- this function, BEFORE UPDATE of the kind column only, for each row, with no
-- WHEN clause. tgtype 19 = ROW (1) + BEFORE (2) + UPDATE (16): no INSERT,
-- DELETE or TRUNCATE bit. And the function carries its search_path.

do $$
declare
  n bigint;
  kind_attnum smallint;
begin
  select attnum into kind_attnum
    from pg_attribute
   where attrelid = 'public.interview_sessions'::regclass
     and attname = 'kind' and not attisdropped;

  select count(*) into n
    from pg_trigger t
   where t.tgrelid = 'public.interview_sessions'::regclass
     and t.tgname = 'interview_sessions_kind_immutable'
     and not t.tgisinternal
     and t.tgenabled = 'O'
     and t.tgfoid = 'public.interview_sessions_kind_immutable()'::regprocedure
     and t.tgtype = 19
     -- int2vector is 0-based, so compare as text (a single column prints as its attnum, e.g. '18').
     and t.tgattr::text = kind_attnum::text
     and t.tgqual is null;
  if n <> 1 then
    raise exception 'migration 060: expected one enabled BEFORE UPDATE OF kind trigger interview_sessions_kind_immutable on interview_sessions, found %; rolled back', n;
  end if;

  select count(*) into n
    from pg_proc
   where oid = 'public.interview_sessions_kind_immutable()'::regprocedure
     and 'search_path=public' = any (proconfig);
  if n <> 1 then
    raise exception 'migration 060: interview_sessions_kind_immutable() has no search_path=public; rolled back';
  end if;
end;
$$;

commit;

-- ── After running ────────────────────────────────────────────
--
-- begin;
-- set transaction read only;
-- select tgname, tgenabled, tgtype, pg_get_triggerdef(oid) as definition
--   from pg_trigger
--  where tgrelid = 'public.interview_sessions'::regclass
--    and tgname = 'interview_sessions_kind_immutable';
--   -- one row: interview_sessions_kind_immutable, O, 19,
--   -- CREATE TRIGGER interview_sessions_kind_immutable BEFORE UPDATE OF kind
--   --   ON public.interview_sessions FOR EACH ROW EXECUTE FUNCTION ...
-- select proconfig from pg_proc
--  where oid = 'public.interview_sessions_kind_immutable()'::regprocedure;
--   -- {search_path=public}
-- rollback;
--
-- ── Negative controls: STAGING ONLY, by hand, after the apply ─
--
-- Not run by anything in the repository, and not to be run on production.
-- One paste, one execution. Everything happens inside ONE transaction that
-- never commits: the DO block always ends by raising its report as an error,
-- which aborts the transaction, and the trailing rollback; closes it. So the
-- two throwaway sessions it inserts, and every change to them, vanish.
-- No existing session is touched: every UPDATE is by the id of a row the
-- block itself inserted moments before.
--
-- Fixtures: one async and one live session, attempt 1, invited, with NO
-- application, NO job and NO provider, under the first staging company, and
-- a token_hash beginning 'rh103-' that no token can hash to. With no
-- application, 055's no-first-attempt trigger does not apply; with status
-- invited and no end, 044's live_ended trigger writes nothing.
--
-- Each change of kind sets live_settings to match the TARGET kind, so the
-- CHECK constraints would permit it, and C0 PROVES that they do by making
-- the same two changes with this trigger disabled. C1 and C2 then require
-- this trigger's own message, not merely SQLSTATE 23514: a BEFORE trigger
-- fires before any CHECK is evaluated, so the message names who refused.
-- Each control runs in its own sub-block (an implicit savepoint), so one
-- control's error cannot abort another. The report names controls and
-- PASS/FAIL only, never an id, a token or a message carrying either.
--
-- begin;
-- set local lock_timeout = '5s';
-- do $$
-- declare
--   v_company uuid;
--   v_async uuid;
--   v_live uuid;
--   n bigint;
--   n2 bigint;
--   msg text;
--   cname text;
--   report text[] := '{}';
--   expected_prefix constant text := 'interview_sessions.kind is set at invite and cannot be changed';
-- begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was run';
--   end if;
--   if not exists (select 1 from pg_trigger
--                   where tgrelid = 'public.interview_sessions'::regclass
--                     and tgname = 'interview_sessions_kind_immutable') then
--     raise exception 'migration 060 is not applied here; nothing was run';
--   end if;
--
--   select id into v_company from public.companies order by id limit 1;
--   if v_company is null then
--     raise exception 'no company on staging to hang the fixtures on; nothing was run';
--   end if;
--
--   insert into public.interview_sessions (company_id, token_hash, status, expires_at, kind, live_settings)
--   values (v_company, 'rh103-async-' || gen_random_uuid(), 'invited', now() + interval '1 day', 'async', null)
--   returning id into v_async;
--   insert into public.interview_sessions (company_id, token_hash, status, expires_at, kind, live_settings)
--   values (v_company, 'rh103-live-' || gen_random_uuid(), 'invited', now() + interval '1 day', 'live', '{}'::jsonb)
--   returning id into v_live;
--
--   -- C0, the premise: with THIS trigger disabled, both changes pass every
--   -- CHECK. The sub-block ends by raising its own code, which undoes the
--   -- disable and both updates.
--   begin
--     alter table public.interview_sessions disable trigger interview_sessions_kind_immutable;
--     update public.interview_sessions set kind = 'live', live_settings = '{}'::jsonb where id = v_async;
--     get diagnostics n = row_count;
--     if n <> 1 then raise exception using errcode = 'P0104', message = 'C0 async->live updated no row'; end if;
--     update public.interview_sessions set kind = 'async', live_settings = null where id = v_live;
--     get diagnostics n = row_count;
--     if n <> 1 then raise exception using errcode = 'P0104', message = 'C0 live->async updated no row'; end if;
--     raise exception using errcode = 'P0103', message = 'C0 undo';
--   exception
--     when sqlstate 'P0103' then report := report || 'C0 CHECKs permit both changes: PASS'::text;
--     when others then
--       get stacked diagnostics cname = constraint_name;
--       report := report || ('C0 CHECKs permit both changes: FAIL (' || sqlstate
--                            || coalesce(', constraint ' || nullif(cname, ''), '') || ')');
--   end;
--
--   -- C1: async -> live, with live_settings made valid for live. Refused by THIS trigger.
--   begin
--     update public.interview_sessions set kind = 'live', live_settings = '{}'::jsonb where id = v_async;
--     report := report || 'C1 async->live refused by the trigger: FAIL (accepted)'::text;
--   exception when check_violation then
--     get stacked diagnostics msg = message_text, cname = constraint_name;
--     report := report || (case when msg like expected_prefix || '%' and coalesce(cname, '') = ''
--                               then 'C1 async->live refused by the trigger: PASS'
--                               else 'C1 async->live refused by the trigger: FAIL (refused by '
--                                    || coalesce(nullif(cname, ''), 'another check') || ')' end);
--   end;
--
--   -- C2: live -> async, with live_settings made valid for async. Refused by THIS trigger.
--   begin
--     update public.interview_sessions set kind = 'async', live_settings = null where id = v_live;
--     report := report || 'C2 live->async refused by the trigger: FAIL (accepted)'::text;
--   exception when check_violation then
--     get stacked diagnostics msg = message_text, cname = constraint_name;
--     report := report || (case when msg like expected_prefix || '%' and coalesce(cname, '') = ''
--                               then 'C2 live->async refused by the trigger: PASS'
--                               else 'C2 live->async refused by the trigger: FAIL (refused by '
--                                    || coalesce(nullif(cname, ''), 'another check') || ')' end);
--   end;
--
--   -- C3: kind set to its current value passes (the trigger fires and allows it).
--   begin
--     update public.interview_sessions set kind = 'async' where id = v_async;
--     get diagnostics n = row_count;
--     update public.interview_sessions set kind = 'live' where id = v_live;
--     get diagnostics n2 = row_count;
--     report := report || (case when n + n2 = 2 then 'C3 same-value kind update allowed: PASS'
--                               else 'C3 same-value kind update allowed: FAIL (' || (n + n2) || ' of 2 rows)' end);
--   exception when others then
--     report := report || ('C3 same-value kind update allowed: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C4: an ordinary update that does not name kind passes.
--   begin
--     update public.interview_sessions set expires_at = expires_at + interval '1 hour' where id = v_async;
--     get diagnostics n = row_count;
--     report := report || (case when n = 1 then 'C4 ordinary update allowed: PASS'
--                               else 'C4 ordinary update allowed: FAIL (no row)' end);
--   exception when others then
--     report := report || ('C4 ordinary update allowed: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C5: after all of it, each fixture still has the kind it was inserted with.
--   select count(*) into n from public.interview_sessions
--    where (id = v_async and kind = 'async') or (id = v_live and kind = 'live');
--   report := report || (case when n = 2 then 'C5 both fixtures kept their kind: PASS'
--                             else 'C5 both fixtures kept their kind: FAIL' end);
--
--   -- Always raise: the report is the error text, and the error guarantees
--   -- that nothing above can be committed, whatever follows.
--   raise exception 'REPORT, expected; nothing persists: %', array_to_string(report, '; ');
-- end;
-- $$;
-- rollback;
--
-- Expected: ERROR "REPORT, expected; nothing persists: C0 ... PASS; C1 ...
-- PASS; C2 ... PASS; C3 ... PASS; C4 ... PASS; C5 ... PASS". Any FAIL: stop,
-- and do not apply to production. ALTER TABLE ... DISABLE TRIGGER in C0 needs
-- the table's owner; if C0 reports 42501, run as the owner.
--
-- ── Rollback ─────────────────────────────────────────────────
--
-- Nothing in the application depends on the trigger: no code updates kind.
-- Removing it returns the database to its state before this file:
--
-- begin;
-- set local lock_timeout = '5s';
-- drop trigger if exists interview_sessions_kind_immutable on public.interview_sessions;
-- drop function if exists public.interview_sessions_kind_immutable();
-- commit;
