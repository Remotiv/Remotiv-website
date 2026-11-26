-- ============================================================================
-- Migration 082 - Interview questions get a kind: 'async' (the recorded
--                 interview) or 'live' (AI Video Interview), each its own list,
--                 saved together in one transaction (#58)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor, BEFORE any code that reads or writes interview_kind is pushed.
-- Run the duplicate check (in the report for #58 commit 1) first: this file
-- refuses to apply while any job has two questions at one position.
--
-- 079 belongs to the other session (WhatsApp); nothing here touches it. No
-- 083 exists or is planned: production has no job with AI Video Interview on,
-- so there is nothing to copy. 084 and later are not ours.
--
-- ── What it adds ─────────────────────────────────────────────
--
--   interview_questions.interview_kind  text not null default 'async',
--                                       'async' or 'live' only.
--   unique (job_id, interview_kind, position), after a duplicate check that
--   raises with a count only. Its index replaces idx_iq_job (job_id,
--   position): it starts with job_id and serves the same lookups, so a second
--   index on the same three columns would be a duplicate.
--   replace_interview_questions(job, company, async list, live list).
--
-- ── Old code keeps working ───────────────────────────────────
--
-- No row is updated, copied or deleted. Every existing row reads 'async'
-- through the default, and every insert today leaves the column out, so it
-- gets 'async' too. Every select today names its columns. The one change old
-- code can see: two saves of the same job at the same moment used to leave
-- duplicate rows; now the second insert fails on the unique rule and the
-- first save's questions stay.
--
-- ── replace_interview_questions ──────────────────────────────
--
-- Saves both lists of one job in ONE transaction (a function body is one).
-- p_async / p_live NULL leaves that kind untouched; an empty array clears it.
--
--   1. Validates every list it was given BEFORE anything is locked or
--      deleted: a JSON array, 0 to 8 items, each an object with non-empty
--      question text and every other field the right type and in the app's
--      range (types.ts, weights.ts). Anything else raises IQ082 and nothing
--      is written.
--   2. Locks the job row (for update), scoped by company: two saves of one
--      job wait for each other instead of clashing on the unique rule.
--   3. Per kind given: deletes that kind's rows, inserts the list. Positions
--      are 1..n by array order, never read from the input.
--
-- Any error rolls back both lists: a failed save never leaves a job with
-- fewer questions than it had. The job's own fields are saved separately,
-- before this runs, by the app; the app says so when this fails.
--
-- Returns {"async": n | null, "live": n | null}: the rows saved per kind, null
-- for a kind left untouched.
--
-- Execute: service_role only. RLS and table grants are unchanged.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- The column is added if missing; the check and unique rule are dropped if
-- present and added again; the old index is dropped if present; the function
-- is replaced.
-- ============================================================================

begin;

alter table public.interview_questions
  add column if not exists interview_kind text not null default 'async';

alter table public.interview_questions
  drop constraint if exists interview_questions_kind_check,
  add constraint interview_questions_kind_check
    check (interview_kind in ('async', 'live'));

do $$
declare
  v_groups integer;
begin
  select count(*) into v_groups
  from (
    select 1
    from public.interview_questions
    group by job_id, interview_kind, position
    having count(*) > 1
  ) d;
  if v_groups > 0 then
    raise exception 'IQ082: % duplicate (job, position) group(s) - resolve them before applying 082', v_groups;
  end if;
end $$;

alter table public.interview_questions
  drop constraint if exists interview_questions_job_kind_position_key,
  add constraint interview_questions_job_kind_position_key
    unique (job_id, interview_kind, position);

drop index if exists public.idx_iq_job;

create or replace function public.replace_interview_questions(
  p_job_id uuid,
  p_company_id uuid,
  p_async jsonb,
  p_live jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_kind text;
  v_list jsonb;
  v_item jsonb;
  v_n integer;
  v_saved jsonb := jsonb_build_object('async', null, 'live', null);
begin
  if p_job_id is null or p_company_id is null then
    raise exception 'IQ082: job and company are required';
  end if;

  -- 1. Validate every list given, before anything is locked or deleted.
  foreach v_kind in array array['async', 'live'] loop
    v_list := case v_kind when 'async' then p_async else p_live end;
    continue when v_list is null;

    if jsonb_typeof(v_list) <> 'array' then
      raise exception 'IQ082: the % list is not an array', v_kind;
    end if;
    if jsonb_array_length(v_list) > 8 then
      raise exception 'IQ082: the % list has % questions; at most 8', v_kind, jsonb_array_length(v_list);
    end if;

    v_n := 0;
    for v_item in select value from jsonb_array_elements(v_list) loop
      v_n := v_n + 1;
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'IQ082: % question % is not an object', v_kind, v_n;
      end if;
      if jsonb_typeof(v_item -> 'question') is distinct from 'string'
         or btrim(v_item ->> 'question') = '' then
        raise exception 'IQ082: % question % has no question text', v_kind, v_n;
      end if;
      if char_length(v_item ->> 'question') > 500 then
        raise exception 'IQ082: % question % is over 500 characters', v_kind, v_n;
      end if;
      if coalesce(jsonb_typeof(v_item -> 'competency'), 'null') not in ('null', 'string')
         or char_length(coalesce(v_item ->> 'competency', '')) > 80 then
        raise exception 'IQ082: % question % has an invalid competency', v_kind, v_n;
      end if;
      if coalesce(jsonb_typeof(v_item -> 'rubric'), 'null') not in ('null', 'string')
         or char_length(coalesce(v_item ->> 'rubric', '')) > 1000 then
        raise exception 'IQ082: % question % has an invalid scoring guide', v_kind, v_n;
      end if;
      if v_item ? 'prep_seconds' and not (
           jsonb_typeof(v_item -> 'prep_seconds') = 'number'
           and (v_item ->> 'prep_seconds')::numeric = trunc((v_item ->> 'prep_seconds')::numeric)
           and (v_item ->> 'prep_seconds')::numeric between 5 and 120) then
        raise exception 'IQ082: % question % has an invalid thinking time', v_kind, v_n;
      end if;
      if v_item ? 'answer_seconds' and not (
           jsonb_typeof(v_item -> 'answer_seconds') = 'number'
           and (v_item ->> 'answer_seconds')::numeric = trunc((v_item ->> 'answer_seconds')::numeric)
           and (v_item ->> 'answer_seconds')::numeric between 30 and 300) then
        raise exception 'IQ082: % question % has an invalid answer limit', v_kind, v_n;
      end if;
      if v_item ? 'weight' and not (
           jsonb_typeof(v_item -> 'weight') = 'number'
           and (v_item ->> 'weight')::numeric in (1, 2, 4, 6)) then
        raise exception 'IQ082: % question % has an invalid weight', v_kind, v_n;
      end if;
      if v_item ? 'required' and jsonb_typeof(v_item -> 'required') <> 'boolean' then
        raise exception 'IQ082: % question % has an invalid required flag', v_kind, v_n;
      end if;
    end loop;
  end loop;

  -- 2. Lock the job, scoped by company.
  perform 1
  from public.jobs
  where id = p_job_id and company_id = p_company_id
  for update;
  if not found then
    raise exception 'IQ082: job not found in this company';
  end if;

  -- 3. Per kind given: delete that kind, insert the list. Positions 1..n.
  foreach v_kind in array array['async', 'live'] loop
    v_list := case v_kind when 'async' then p_async else p_live end;
    continue when v_list is null;

    delete from public.interview_questions
    where job_id = p_job_id
      and company_id = p_company_id
      and interview_kind = v_kind;

    insert into public.interview_questions (
      job_id, company_id, interview_kind, position, question, competency,
      rubric, prep_seconds, answer_seconds, weight, required
    )
    select
      p_job_id,
      p_company_id,
      v_kind,
      e.ordinality::integer,
      btrim(e.value ->> 'question'),
      nullif(btrim(coalesce(e.value ->> 'competency', '')), ''),
      nullif(btrim(coalesce(e.value ->> 'rubric', '')), ''),
      coalesce((e.value ->> 'prep_seconds')::numeric::integer, 30),
      coalesce((e.value ->> 'answer_seconds')::numeric::integer, 120),
      coalesce((e.value ->> 'weight')::numeric::integer, 1),
      coalesce((e.value ->> 'required')::boolean, true)
    from jsonb_array_elements(v_list) with ordinality as e(value, ordinality);

    get diagnostics v_n = row_count;
    v_saved := jsonb_set(v_saved, array[v_kind], to_jsonb(v_n));
  end loop;

  return v_saved;
end;
$$;

revoke all on function public.replace_interview_questions(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_interview_questions(uuid, uuid, jsonb, jsonb)
  to service_role;

commit;
