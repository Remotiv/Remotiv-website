-- ============================================================================
-- #68 alignment, step 00b: clear the staging seed's 400 orphan messages
-- ----------------------------------------------------------------------------
-- STAGING ONLY. Refuses to write anything on a database without
-- staging_guard.sentinel (README-steps.md step 3), the same refusal 059 uses.
-- Run BEFORE 01-staging-056-without-step6.sql.
--
-- Why: 01's step 0 refused on staging (15 Nov 2026): 400 communication_logs
-- rows with application_id NULL and an address, 0 orphaned sweepable bells.
-- Nothing was written. 056's step 7 refuses to commit while such a row
-- exists, because the triggers 056 adds stamp only rows orphaned FROM THEN ON,
-- and the sweep reaches only stamped rows. This file clears those 400 rows
-- the way 056 cleared production's 86, so 01 can run with step 7 intact.
--
-- ── What the 400 rows are ────────────────────────────────────
--
-- The staging seed writes them on purpose, born with application_id NULL:
--   scripts/staging/seed-plan.mjs:310   MESSAGE_ORPHANS = 400 (full scale)
--   scripts/staging/seed-plan.mjs:469   orphan = i < scale.messageOrphans
--   scripts/staging/seed-plan.mjs:489   application_id: orphan ? null : ...
--   scripts/staging/seed-plan.mjs:487   id: uuidFrom(`message:${i}`)
--   scripts/staging/seed-plan.mjs:327-332  uuidFrom: sha256 of
--                                       'remotiv-staging:' || label, fixed bytes
--   scripts/staging/seed.mjs:253        company: uuidFrom("company")
-- So each one has a KNOWN id: message:0 to message:399, all in the one
-- fixture company. This file derives those 400 ids in SQL (the derivation
-- below was checked against uuidFrom for all 6,000 message labels and the
-- company label) and touches only rows that carry one of them. A row with
-- application_id NULL that is NOT one of them stops the run.
--
-- What the seed code predicts for the 400 (computed from buildPlan at full
-- scale, no database read): channel email 200, whatsapp 200; status queued
-- 58, sent 57, failed 57, cancelled 57, skipped 57, delivered 57, read 57;
-- all created on 2026-01-05 (UTC), so month 2026-01: 400; 1 company.
--
-- ── What is cleared: exactly 056's fields ───────────────────
--
-- 056 step 5 (056:308-314) and step 6 (056:381-387) clear the same six:
--   to_address          := public.erased_address(), which is '[erased]' (056:150-152)
--   subject             := null
--   body                := null
--   error               := null
--   provider_message_id := null
--   provider_id         := null
-- Everything else stays: id, company_id, application_id (already NULL),
-- event, channel, status, created_at, sent_by_name, sent_at. An UPDATE, never
-- a DELETE: the 400 records survive, so the seed's orphan filter test
-- (seed-plan.mjs:50-58) still has its 400 rows to exclude. No harness or
-- test file reads an orphan's address or subject, only counts.
--
-- erased_address() does not exist on staging yet (056 is not applied), so the
-- literal '[erased]' is used. If the function does exist, step 0 refuses
-- unless it returns exactly '[erased]'.
--
-- THREE SECTIONS, three separate executions: A (read-only), then B, then C
-- (read-only). Counts only throughout: no query returns an address, a
-- subject, a body, an error text or an id.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION A. BEFORE, read-only. Run alone. Every value must match, or STOP.
-- ════════════════════════════════════════════════════════════════════════════

begin;
set transaction read only;

with seed_ids as (
  select i,
         (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
          || to_hex(((position(substr(h, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
          || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid as id
    from (select i, encode(sha256(convert_to('remotiv-staging:message:' || i, 'UTF8')), 'hex') as h
            from generate_series(0, 399) as i) s
),
seed_company as (
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
          || to_hex(((position(substr(h, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
          || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid as id
    from (select encode(sha256(convert_to('remotiv-staging:company', 'UTF8')), 'hex') as h) s
),
targets as (
  select c.channel, c.status, c.created_at, c.company_id,
         (c.id in (select id from seed_ids)
          and c.company_id = (select id from seed_company)) as is_seed
    from public.communication_logs c
   where c.application_id is null
     and c.to_address <> '[erased]'
)
select
  (select count(*) from targets)                                         as orphans_with_address,   -- 400 (the measured count)
  (select count(*) from targets where is_seed)                           as seed_orphans,           -- 400
  (select count(*) from targets where not is_seed)                       as not_seed,               -- 0, or STOP
  (select count(*) from public.communication_logs c
    where c.id in (select id from seed_ids))                             as seed_ids_present,       -- 400
  -- Synthetic-data check, the same as section B step 0: each seed orphan
  -- still holds exactly what seed-plan.mjs:495-496 wrote for its own index i,
  -- on both channels (the seed gives whatsapp rows the same address form).
  -- Compared inside SQL; only the count comes back.
  (select count(*) from public.communication_logs c
     join seed_ids d on d.id = c.id
    where c.application_id is null and c.to_address <> '[erased]'
      and c.company_id = (select id from seed_company)
      and c.to_address = 'staging+' || d.i || '@example.invalid'
      and (c.subject is null or c.subject = 'Staging message ' || d.i)) as synthetic_match,       -- 400
  (select count(*) from public.communication_logs
    where application_id is null and to_address = '[erased]')            as already_erased,         -- 0
  (select coalesce(jsonb_object_agg(channel, n), '{}'::jsonb)
     from (select channel, count(*) as n from targets group by 1) t)     as by_channel,             -- {"email": 200, "whatsapp": 200}
  (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
     from (select status, count(*) as n from targets group by 1) t)      as by_status,              -- queued 58, the other six 57
  (select coalesce(jsonb_object_agg(m, n), '{}'::jsonb)
     from (select to_char(created_at at time zone 'UTC', 'YYYY-MM') as m, count(*) as n
             from targets group by 1) t)                                 as by_month_utc,           -- {"2026-01": 400}
  (select count(distinct company_id) from targets)                       as distinct_companies,     -- 1
  (select count(*) from targets
    where (created_at at time zone 'UTC')::date <> date '2026-01-05')    as not_on_2026_01_05,      -- 0
  to_regclass('staging_guard.sentinel') is not null                      as is_staging;             -- true, or STOP

rollback;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION B. THE CLEAR. One execution, from begin; to commit;.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- One UPDATE by primary key on 400 rows takes row locks only. Fail fast if
-- anything holds a conflicting lock, rather than queue the staging app.
set local lock_timeout = '5s';

do $$
declare
  measured constant bigint := 400;   -- 01 step 0's refusal on staging, 15 Nov 2026
  seed_ids uuid[];
  seed_company uuid;
  n_before bigint;
  n_seed bigint;
  n_synthetic bigint;
  n_updated bigint;
  n_left bigint;
  n_seed_rows bigint;
  n_seed_cleared bigint;
  erased text;
begin
  -- ── 0. STAGING ONLY, and the target proven before anything is written ──

  if to_regclass('staging_guard.sentinel') is null then
    raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was written';
  end if;

  if to_regprocedure('public.erased_address()') is not null then
    execute 'select public.erased_address()' into erased;
    if erased is distinct from '[erased]' then
      raise exception 'align-068 00b: public.erased_address() returns %, not [erased]. Nothing was written.', erased;
    end if;
  end if;

  select array_agg((substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
                    || to_hex(((position(substr(h, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
                    || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid)
    into seed_ids
    from (select encode(sha256(convert_to('remotiv-staging:message:' || i, 'UTF8')), 'hex') as h
            from generate_series(0, 399) as i) s;

  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
          || to_hex(((position(substr(h, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
          || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    into seed_company
    from (select encode(sha256(convert_to('remotiv-staging:company', 'UTF8')), 'hex') as h) s;

  if cardinality(seed_ids) <> 400 or (select count(distinct x) from unnest(seed_ids) x) <> 400 then
    raise exception 'align-068 00b: derived % seed ids, expected 400 distinct. Nothing was written.', cardinality(seed_ids);
  end if;

  select count(*) into n_before
    from public.communication_logs
   where application_id is null and to_address <> '[erased]';
  if n_before <> measured then
    raise exception 'align-068 00b: % orphaned message row(s) with an address, measured %. The premise moved; re-run section A. Nothing was written.',
      n_before, measured;
  end if;

  select count(*) into n_seed
    from public.communication_logs
   where application_id is null and to_address <> '[erased]'
     and id = any (seed_ids) and company_id = seed_company;
  if n_seed <> measured then
    raise exception 'align-068 00b: only % of the % orphaned rows are the seed''s (message:0-399, fixture company). Rows of unknown origin are present: STOP and report. Nothing was written.',
      n_seed, n_before;
  end if;

  -- Synthetic data only: each target still holds exactly what the seed wrote
  -- for its own index i (seed-plan.mjs:495-496). The seed has no phone form:
  -- whatsapp rows carry the same staging+i@example.invalid address as email
  -- rows. Subject must be the seed's, or NULL. Compared here, counted only;
  -- the refusal names counts, never a value.
  select count(*) into n_synthetic
    from public.communication_logs c
    join (select i,
                 (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
                  || to_hex(((position(substr(h, 17, 1) in '0123456789abcdef') - 1) & 3) | 8)
                  || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid as id
            from (select i, encode(sha256(convert_to('remotiv-staging:message:' || i, 'UTF8')), 'hex') as h
                    from generate_series(0, 399) as i) s) d
      on d.id = c.id
   where c.application_id is null and c.to_address <> '[erased]'
     and c.company_id = seed_company
     and c.to_address = 'staging+' || d.i || '@example.invalid'
     and (c.subject is null or c.subject = 'Staging message ' || d.i);
  if n_synthetic <> measured then
    raise exception 'align-068 00b: only % of the % seed orphan rows still hold the seed''s own address and subject. Rows not proven synthetic: STOP and report. Nothing was written.',
      n_synthetic, n_seed;
  end if;

  -- ── 1. The clear: 056's six fields, on the seed's 400 ids only ──

  update public.communication_logs
     set to_address = '[erased]',
         subject = null, body = null, error = null,
         provider_message_id = null, provider_id = null
   where application_id is null
     and to_address <> '[erased]'
     and id = any (seed_ids)
     and company_id = seed_company;
  get diagnostics n_updated = row_count;

  -- ── 2. THE INVARIANT, asserted before commit ──

  if n_updated <> measured then
    raise exception 'align-068 00b: updated % row(s), expected %. Rolled back.', n_updated, measured;
  end if;

  select count(*) into n_left
    from public.communication_logs
   where application_id is null and to_address <> '[erased]';
  if n_left <> 0 then
    raise exception 'align-068 00b: % orphaned row(s) still carry an address after the clear (a new orphan appeared during the run?). Rolled back.', n_left;
  end if;

  select count(*),
         count(*) filter (where to_address = '[erased]' and subject is null and body is null
                            and error is null and provider_message_id is null and provider_id is null)
    into n_seed_rows, n_seed_cleared
    from public.communication_logs
   where id = any (seed_ids);
  if n_seed_rows <> measured or n_seed_cleared <> measured then
    raise exception 'align-068 00b: % seed row(s) present (expected %), % fully cleared. Rolled back.',
      n_seed_rows, measured, n_seed_cleared;
  end if;

  raise notice 'align-068 00b: cleared % seed orphan message rows on staging; % records kept', n_updated, n_seed_rows;
end;
$$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION C. AFTER, read-only. Run alone.
-- ════════════════════════════════════════════════════════════════════════════

begin;
set transaction read only;

select
  (select count(*) from public.communication_logs
    where application_id is null and to_address <> '[erased]')           as orphans_with_address,  -- 0
  (select count(*) from public.communication_logs
    where application_id is null and to_address = '[erased]')            as orphans_erased,        -- 400
  (select count(*) from public.communication_logs
    where application_id is null and to_address = '[erased]'
      and subject is null and body is null and error is null
      and provider_message_id is null and provider_id is null)           as orphans_fully_cleared, -- 400
  (select count(*) from public.communication_logs
    where application_id is null)                                        as orphans_total,         -- 400: no record deleted
  (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
     from (select status, count(*) as n from public.communication_logs
            where application_id is null group by 1) t)                  as orphan_status_kept;    -- unchanged from section A

rollback;

-- Then run 01-staging-056-without-step6.sql section A: orphan_messages 400
-- (the records are kept), orphan_messages_with_address 0,
-- orphan_sweepable_bells 0. Section B's step 0 then passes on these rows.
--
-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════════
--
-- If section B errored: run  rollback;  on its own, then section A again;
-- it must read as it did before (400, 400, 0).
--
-- A COMMITTED clear cannot be undone in SQL: the cleared values are gone, as
-- 056 intends. The values were synthetic seed data
-- (staging+N@example.invalid, "Staging message N", seed-plan.mjs:495-496);
-- to restore them, re-seed staging (seed.mjs teardown and seed), which
-- recreates all 400 orphans WITH addresses. See the warning in the report:
-- after 01 is applied, a re-seed brings the same 400 unreachable rows back.
