-- ============================================================================
-- Migration 061 - application_scores: no AI write past the CV's retention
--                 date (#91 item B)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor: one paste, one
-- execution, one transaction. STAGING FIRST, with the negative controls below;
-- production only after they pass. Nothing in the repository executes it.
--
-- APPLIED TO STAGING: 16 Nov 2026, Waleed (controls C0-C8 all PASS)
-- APPLIED TO PRODUCTION:
-- Fill each in when it happens: date, by whom.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- When a company CV passes its retention date, the CV purge clears the AI's
-- words about it from application_scores and keeps the numbers (cv-purge.ts,
-- the scores pass). The scorer must then never write that card again: a late
-- write would put back the words, or turn the kept score into a skipped or
-- failed card, which has no effective_score and drops out of every ranking.
--
-- The scorer checks the date twice (cv-scoring.ts: before any work, and in
-- writeScoreRow immediately before the upsert), but a check and an upsert are
-- two statements. A job that passes the check a moment before the date and
-- upserts a moment after it writes anyway. This trigger makes the rule part of
-- the write itself: Postgres evaluates the date in the same statement as the
-- row change, so there is no gap left between a check and a write.
--
-- ── Every writer of application_scores, and what this does to it ──
--
-- Read from the code on 17 Nov 2026 (src/, scripts/; no SQL function in the
-- production dump writes this table, and it had no trigger before this one):
--
--   cv-scoring.ts writeScoreRow   upsert: every AI column and status   REFUSED once expired
--   cv-purge.ts scores pass       update: words to empty, numbers kept ALLOWED
--   cv-recompute.ts               update: overall_score only           ALLOWED (re-weights the kept numbers)
--   applicants/actions.ts         update: human_adjusted_score,        ALLOWED (a recruiter's own record)
--     adjustScore, clearScoreAdjustment     human_feedback, adjusted_by,
--                                           adjusted_by_name, adjusted_at
--   scripts/staging/seed.mjs      insert                               never affected: the seed sets no
--                                                                      cv_delete_after on any application
--   deletes (ON DELETE CASCADE)   delete                               never affected: no DELETE trigger
--
-- ── The rule ─────────────────────────────────────────────────
--
-- Applies only when the parent application is a COMPANY application whose
-- date has passed: company_id_snapshot is not null and cv_delete_after <=
-- now(), the CV purge's own test. Remotiv's own pool (no company, no date) and
-- every live CV are never affected. Then:
--
--   INSERT   refused. A card on an expired CV is never created. An upsert is
--            an INSERT first, so this refuses the scorer's upsert whether or
--            not a card already exists.
--   UPDATE   allowed only when every column outside the kept set below is
--            unchanged, AND every word column that changes becomes empty
--            (text null or '', jsonb '[]', and no non-empty reasoning or
--            quote inside dimension_scores or must_haves). Kept set:
--              overall_score                              cv-recompute
--              human_adjusted_score, human_feedback,       recruiters
--              adjusted_by, adjusted_by_name, adjusted_at
--              summary, verdict, evidence, strengths,     the CV purge, toward
--              concerns, missing_requirements,            empty only
--              dimension_scores, must_haves
--              effective_score                            generated; never written
--            So status, confidence, error, every model and token field,
--            scored_at, screening_score, and the row's identity
--            (application_id, company_id, job_id) cannot change.
--
-- A refusal raises SQLSTATE RT091 with a fixed message that names no row and
-- carries no text. writeScoreRow maps RT091 to "expired": nothing saved, the
-- allowance slot released, the job finished normally (cv-scoring.ts
-- RETENTION_GUARD_SQLSTATE).
--
-- now() is the writing transaction's start. Every writer above is one
-- PostgREST statement in its own transaction, so that is the write's time.
--
-- ── Before running ───────────────────────────────────────────
--
-- begin;
-- set transaction read only;
-- select
--   (select count(*) from pg_trigger
--     where tgrelid = 'public.application_scores'::regclass and not tgisinternal)   as score_triggers,      -- 0
--   to_regprocedure('public.application_scores_retention_guard()') is not null       as guard_function,      -- false
--   (select count(*) from public.application_scores s
--      join public.job_applications a on a.id = s.application_id
--     where a.company_id_snapshot is not null and a.cv_delete_after <= now())        as cards_on_expired_cvs; -- 0 until the first CV expires (Aug 2028)
-- rollback;
-- ============================================================================

begin;

-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on application_scores until
-- commit. Fail fast rather than queue every scorer write behind a long
-- transaction; run the file again.
set local lock_timeout = '5s';

-- ── 1. The function ──────────────────────────────────────────

create or replace function public.application_scores_retention_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  expired boolean;
  kept constant text[] := array[
    'overall_score',
    'human_adjusted_score', 'human_feedback', 'adjusted_by', 'adjusted_by_name', 'adjusted_at',
    'summary', 'verdict', 'evidence', 'strengths', 'concerns', 'missing_requirements',
    'dimension_scores', 'must_haves',
    'effective_score'
  ];
begin
  select a.company_id_snapshot is not null
         and a.cv_delete_after is not null
         and a.cv_delete_after <= now()
    into expired
    from public.job_applications a
   where a.id = new.application_id;

  -- A live CV, Remotiv's own pool, or no parent (the foreign key refuses that).
  if not coalesce(expired, false) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception using
      errcode = 'RT091',
      message = 'application_scores: the CV has passed its retention date; an AI scorecard cannot be written';
  end if;

  if (to_jsonb(new) - kept) is distinct from (to_jsonb(old) - kept) then
    raise exception using
      errcode = 'RT091',
      message = 'application_scores: the CV has passed its retention date; an AI scorecard cannot be written';
  end if;

  if (new.summary is distinct from old.summary and coalesce(new.summary, '') <> '')
     or (new.verdict is distinct from old.verdict and coalesce(new.verdict, '') <> '')
     or (new.evidence is distinct from old.evidence and new.evidence <> '[]'::jsonb)
     or (new.strengths is distinct from old.strengths and new.strengths <> '[]'::jsonb)
     or (new.concerns is distinct from old.concerns and new.concerns <> '[]'::jsonb)
     or (new.missing_requirements is distinct from old.missing_requirements
         and new.missing_requirements <> '[]'::jsonb)
     or (new.dimension_scores is distinct from old.dimension_scores
         and (jsonb_path_exists(new.dimension_scores, '$.**.reasoning ? (@ != "")')
              or jsonb_path_exists(new.dimension_scores, '$.**.quote ? (@ != "")')))
     or (new.must_haves is distinct from old.must_haves
         and jsonb_path_exists(new.must_haves, '$.**.quote ? (@ != "")'))
  then
    raise exception using
      errcode = 'RT091',
      message = 'application_scores: the CV has passed its retention date; an AI scorecard cannot be written';
  end if;

  return new;
end;
$$;

-- ── 2. The trigger ───────────────────────────────────────────

drop trigger if exists application_scores_retention_guard on public.application_scores;

create trigger application_scores_retention_guard
  before insert or update on public.application_scores
  for each row
  execute function public.application_scores_retention_guard();

-- ── 3. THE INVARIANT, asserted before commit ─────────────────
--
-- Exactly one trigger of this name, on application_scores, enabled, calling
-- this function, BEFORE INSERT OR UPDATE of every column, for each row, with
-- no WHEN clause. tgtype 23 = ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16):
-- no DELETE or TRUNCATE bit. No column list: cardinality, which ignores
-- int2vector's 0-based bound (the lesson of 060). And the function carries its
-- search_path.

do $$
declare
  n bigint;
begin
  select count(*) into n
    from pg_trigger t
   where t.tgrelid = 'public.application_scores'::regclass
     and t.tgname = 'application_scores_retention_guard'
     and not t.tgisinternal
     and t.tgenabled = 'O'
     and t.tgfoid = 'public.application_scores_retention_guard()'::regprocedure
     and t.tgtype = 23
     and cardinality(t.tgattr::int2[]) = 0
     and t.tgqual is null;
  if n <> 1 then
    raise exception 'migration 061: expected one enabled BEFORE INSERT OR UPDATE trigger application_scores_retention_guard on application_scores, found %; rolled back', n;
  end if;

  select count(*) into n
    from pg_proc
   where oid = 'public.application_scores_retention_guard()'::regprocedure
     and 'search_path=public' = any (proconfig);
  if n <> 1 then
    raise exception 'migration 061: application_scores_retention_guard() has no search_path=public; rolled back';
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
--  where tgrelid = 'public.application_scores'::regclass
--    and tgname = 'application_scores_retention_guard';
--   -- one row: application_scores_retention_guard, O, 23,
--   -- CREATE TRIGGER application_scores_retention_guard BEFORE INSERT OR UPDATE
--   --   ON public.application_scores FOR EACH ROW EXECUTE FUNCTION ...
-- select proconfig from pg_proc
--  where oid = 'public.application_scores_retention_guard()'::regprocedure;
--   -- {search_path=public}
-- rollback;
--
-- ── Negative controls: STAGING ONLY, by hand, after the apply ─
--
-- Not run by anything in the repository, and not to be run on production.
-- One paste, one execution, ONE transaction that never commits: the DO block
-- always ends by raising its report as an error, which aborts the
-- transaction, and the trailing rollback; closes it. Everything it inserts or
-- changes vanishes.
--
-- Fixtures, all throwaway and all inside the transaction: two applications
-- under the first staging company (first_name 'rh091-fixture', no job, no CV),
-- the first with a live date, and one scorecard on it, written while the date
-- is live; then the first application's date is moved into the past. No
-- existing application or scorecard is read for a change or changed: every
-- statement targets an id the block itself inserted.
--
-- Each control runs in its own sub-block (an implicit savepoint), so one
-- control's error cannot abort another. A refusal passes only with SQLSTATE
-- RT091; an allowed write passes only if it lands on exactly one row. The
-- report names controls and PASS/FAIL only.
--
-- begin;
-- set local lock_timeout = '5s';
-- do $$
-- declare
--   v_company uuid;
--   v_app uuid;
--   v_app2 uuid;
--   n bigint;
--   report text[] := '{}';
-- begin
--   if to_regclass('staging_guard.sentinel') is null then
--     raise exception 'NOT STAGING: there is no staging_guard.sentinel here, so nothing was run';
--   end if;
--   if not exists (select 1 from pg_trigger
--                   where tgrelid = 'public.application_scores'::regclass
--                     and tgname = 'application_scores_retention_guard') then
--     raise exception 'migration 061 is not applied here; nothing was run';
--   end if;
--
--   select id into v_company from public.companies order by id limit 1;
--   if v_company is null then
--     raise exception 'no company on staging to hang the fixtures on; nothing was run';
--   end if;
--
--   insert into public.job_applications (first_name, company_id_snapshot, cv_delete_after)
--   values ('rh091-fixture', v_company, now() + interval '1 day')
--   returning id into v_app;
--   insert into public.job_applications (first_name, company_id_snapshot, cv_delete_after)
--   values ('rh091-fixture', v_company, now() - interval '1 day')
--   returning id into v_app2;
--
--   -- C0: while the CV is live, the scorer's card is written (the guard is silent).
--   begin
--     insert into public.application_scores
--       (application_id, company_id, status, overall_score, ai_model, prompt_version,
--        summary, verdict, evidence, strengths, concerns, missing_requirements,
--        dimension_scores, must_haves, confidence)
--     values
--       (v_app, v_company, 'scored', 74, 'rh091-model', 'rh091',
--        'words', 'a verdict', '[{"claim":"x","quote":"q"}]', '[{"point":"p","quote":"q"}]',
--        '["c"]', '["m"]',
--        '[{"dimension":"requirements_match","score":70,"reasoning":"r","quote":"q"}]',
--        '[{"item":"i","status":"evidenced","quote":"q"}]', 'high');
--     report := report || 'C0 live CV, card written: PASS'::text;
--   exception when others then
--     report := report || ('C0 live CV, card written: FAIL (' || sqlstate || ')');
--   end;
--
--   update public.job_applications set cv_delete_after = now() - interval '1 day' where id = v_app;
--
--   -- C1: a new card on an expired CV is refused.
--   begin
--     insert into public.application_scores (application_id, company_id, status, ai_model, prompt_version)
--     values (v_app2, v_company, 'skipped', 'rh091-model', 'rh091');
--     report := report || 'C1 insert on expired refused: FAIL (accepted)'::text;
--   exception when sqlstate 'RT091' then
--     report := report || 'C1 insert on expired refused: PASS'::text;
--   when others then
--     report := report || ('C1 insert on expired refused: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C2: the scorer's upsert over the kept card is refused (its INSERT half).
--   begin
--     insert into public.application_scores (application_id, company_id, status, error, ai_model, prompt_version)
--     values (v_app, v_company, 'skipped', 'late', 'rh091-model', 'rh091')
--     on conflict (application_id) do update
--       set status = excluded.status, error = excluded.error;
--     report := report || 'C2 scorer upsert refused: FAIL (accepted)'::text;
--   exception when sqlstate 'RT091' then
--     report := report || 'C2 scorer upsert refused: PASS'::text;
--   when others then
--     report := report || ('C2 scorer upsert refused: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C3: a status change alone is refused (skipped would hide the kept score).
--   begin
--     update public.application_scores set status = 'skipped' where application_id = v_app;
--     report := report || 'C3 status change refused: FAIL (accepted)'::text;
--   exception when sqlstate 'RT091' then
--     report := report || 'C3 status change refused: PASS'::text;
--   when others then
--     report := report || ('C3 status change refused: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C4: the CV purge's clearing update is allowed.
--   begin
--     update public.application_scores
--        set summary = null, verdict = null, evidence = '[]', strengths = '[]',
--            concerns = '[]', missing_requirements = '[]',
--            dimension_scores = '[{"dimension":"requirements_match","score":70,"reasoning":"","quote":""}]',
--            must_haves = '[{"item":"i","status":"evidenced","quote":""}]'
--      where application_id = v_app;
--     get diagnostics n = row_count;
--     report := report || (case when n = 1 then 'C4 purge clear allowed: PASS'
--                               else 'C4 purge clear allowed: FAIL (no row)' end);
--   exception when others then
--     report := report || ('C4 purge clear allowed: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C5: putting a word back on the cleared card is refused (summary, then a quote).
--   begin
--     update public.application_scores set summary = 'back again' where application_id = v_app;
--     report := report || 'C5a summary back refused: FAIL (accepted)'::text;
--   exception when sqlstate 'RT091' then
--     report := report || 'C5a summary back refused: PASS'::text;
--   when others then
--     report := report || ('C5a summary back refused: FAIL (' || sqlstate || ')');
--   end;
--   begin
--     update public.application_scores
--        set dimension_scores = '[{"dimension":"requirements_match","score":70,"reasoning":"","quote":"cv span"}]'
--      where application_id = v_app;
--     report := report || 'C5b dimension quote back refused: FAIL (accepted)'::text;
--   exception when sqlstate 'RT091' then
--     report := report || 'C5b dimension quote back refused: PASS'::text;
--   when others then
--     report := report || ('C5b dimension quote back refused: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C6: a recruiter's adjustment, and clearing it, are allowed.
--   begin
--     update public.application_scores
--        set human_adjusted_score = 80, human_feedback = 'note', adjusted_by_name = 'rh091',
--            adjusted_at = now()
--      where application_id = v_app;
--     get diagnostics n = row_count;
--     update public.application_scores
--        set human_adjusted_score = null, human_feedback = null, adjusted_by = null,
--            adjusted_by_name = null, adjusted_at = null
--      where application_id = v_app;
--     report := report || (case when n = 1 then 'C6 human adjustment allowed: PASS'
--                               else 'C6 human adjustment allowed: FAIL (no row)' end);
--   exception when others then
--     report := report || ('C6 human adjustment allowed: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C7: cv-recompute's overall_score rewrite is allowed.
--   begin
--     update public.application_scores set overall_score = 71 where application_id = v_app;
--     get diagnostics n = row_count;
--     report := report || (case when n = 1 then 'C7 recompute allowed: PASS'
--                               else 'C7 recompute allowed: FAIL (no row)' end);
--   exception when others then
--     report := report || ('C7 recompute allowed: FAIL (' || sqlstate || ')');
--   end;
--
--   -- C8: after all of it, the kept card is still scored with its number.
--   select count(*) into n from public.application_scores
--    where application_id = v_app and status = 'scored' and overall_score = 71
--      and summary is null and evidence = '[]'::jsonb;
--   report := report || (case when n = 1 then 'C8 kept card intact: PASS'
--                             else 'C8 kept card intact: FAIL' end);
--
--   raise exception 'REPORT, expected; nothing persists: %', array_to_string(report, '; ');
-- end;
-- $$;
-- rollback;
--
-- Expected: ERROR "REPORT, expected; nothing persists: C0 ... PASS; C1 ...
-- PASS; C2 ... PASS; C3 ... PASS; C4 ... PASS; C5a ... PASS; C5b ... PASS;
-- C6 ... PASS; C7 ... PASS; C8 ... PASS". Any FAIL: stop, and do not apply to
-- production.
--
-- ── Rollback ─────────────────────────────────────────────────
--
-- The application does not depend on the trigger: writeScoreRow checks the
-- date itself first, and maps RT091 only when the trigger exists. Removing it
-- returns the database to its state before this file:
--
-- begin;
-- set local lock_timeout = '5s';
-- drop trigger if exists application_scores_retention_guard on public.application_scores;
-- drop function if exists public.application_scores_retention_guard();
-- commit;
