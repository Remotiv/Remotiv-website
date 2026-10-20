-- ============================================================================
-- Migration 042 — live interview scoring: job_question_scoring_guides,
--                 live_interview_scores, live_interview_actions
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor.
--
-- Three new tables. No existing table, column or policy changes, so nothing
-- that ranks or shortlists (applicants/, Best Match, jobs/actions.ts
-- auto-shortlist, all of which read interview_session_scores) can see a live
-- score until that code opts in on purpose.
--
-- ── Why not the existing score tables ─────────────────────────
--
-- interview_answer_scores.answer_id is a NOT NULL foreign key to
-- interview_answers; a live interview has interview_turns and no answers.
-- interview_session_scores is read by auto-shortlist (status 'scored',
-- overall_score) and the applicants scorecard: a partial live overall written
-- there would be ranked against completed interviews the moment it landed.
--
-- ── job_question_scoring_guides: the job's, not the session's ─
--
-- A job question with no recruiter rubric gets ONE AI-written private scoring
-- guide, shared by every candidate of the job. Keyed by the question's wording
-- (sha256 of the normalised text), not by interview_questions.id: saving a job
-- deletes and re-inserts all of its questions (jobs/actions.ts), so ids churn
-- while the wording stays. Same wording, same guide; changed wording, a new
-- guide. Cascades with the JOB, never with a session.
--
-- The guide used is FROZEN into each session's scoring snapshot before the
-- interview starts (lib/interviews/live-question-freeze.ts), so changing or
-- deleting a row here never changes a session that already froze it.
-- `source` says who wrote it: 'ai' rows carry the model and prompt version.
-- Never sent to the interviewer provider or the candidate.
--
-- ── live_interview_scores: one row per session ───────────────
--
-- Per-question results (score, rationale, candidate-only quotes, status) in
-- `questions`, and the overall: the average over scored questions (answered
-- and skipped-at-lowest; not_reached, excluded and unresolved questions are
-- left out, never zero), with answered/total and completion %. `rev` is the
-- compare-and-set counter every write must match, so two recomputes cannot
-- overwrite each other. A restart is a new session (migration 020), so one row
-- per session never mixes two attempts.
--
-- `partial` is true for every outcome but 'completed' (enforced below). NOTE
-- FOR BEST MATCH / RANKING: a partial live score must never be ranked against
-- a completed one. Nothing ranks from this table yet.
--
-- ── live_interview_actions: append-only ──────────────────────
--
-- Every recovery action a person takes (retry a failed transcription, resolve
-- a timing check, exclude a failed question): who, their role, when, the
-- decision and a required note. UPDATE is refused always. DELETE is refused
-- while the row's session exists, so the only way a row goes is with its
-- session (deleteInterview, a job or company deletion, retention): the FK's
-- cascade deletes the session first, and the trigger sees it gone. TRUNCATE is
-- refused. created_at is set by the database, never by the caller.
--
-- ── Tenant safety ────────────────────────────────────────────
--
-- Each row's company_id is checked against its parent (the job, or the
-- session) on insert and on any change of either column; a mismatch is
-- refused. The two session tables accept live sessions only. No company FK on
-- the session tables: a company deletion cascades to sessions, and from there
-- to these rows, in one path.
--
-- ── Access ───────────────────────────────────────────────────
--
-- RLS on, no policies: server-only, exactly like interview_answer_scores and
-- interview_session_scores. Reads and writes go through the service client.
-- ============================================================================

-- ── 1. job_question_scoring_guides ───────────────────────────

create table if not exists public.job_question_scoring_guides (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs (id) on delete cascade,
  company_id       uuid not null,
  question_sha256  text not null,
  source           text not null,
  guide            text not null,
  competency       text,
  ai_model         text,
  prompt_version   text,
  input_tokens     integer,
  output_tokens    integer,
  created_at       timestamptz not null default now(),
  constraint job_question_scoring_guides_one_per_wording unique (job_id, question_sha256),
  constraint job_question_scoring_guides_sha256 check (question_sha256 ~ '^[0-9a-f]{64}$'),
  constraint job_question_scoring_guides_source check (source in ('ai', 'recruiter')),
  constraint job_question_scoring_guides_guide check (length(btrim(guide)) between 1 and 4000),
  constraint job_question_scoring_guides_ai_fields
    check ((source = 'ai') = (ai_model is not null and prompt_version is not null)),
  constraint job_question_scoring_guides_tokens
    check (coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0)
);

create or replace function public.job_question_scoring_guides_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  owner uuid;
begin
  select company_id into owner from public.jobs where id = new.job_id;
  if owner is null then
    raise exception 'job_question_scoring_guides: job % not found', new.job_id;
  end if;
  if new.company_id is distinct from owner then
    raise exception 'job_question_scoring_guides: company does not own job %', new.job_id;
  end if;
  return new;
end;
$$;

drop trigger if exists job_question_scoring_guides_company on public.job_question_scoring_guides;
create trigger job_question_scoring_guides_company
  before insert or update of job_id, company_id on public.job_question_scoring_guides
  for each row execute function public.job_question_scoring_guides_company();

alter table public.job_question_scoring_guides enable row level security;

-- ── Shared: a session table row belongs to a live session of its company ──

create or replace function public.live_scoring_session_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  owner uuid;
  session_kind text;
begin
  select company_id, kind into owner, session_kind
    from public.interview_sessions where id = new.session_id;
  if owner is null then
    raise exception '%: session % not found', tg_table_name, new.session_id;
  end if;
  if session_kind is distinct from 'live' then
    raise exception '%: session % is not a live interview', tg_table_name, new.session_id;
  end if;
  if new.company_id is distinct from owner then
    raise exception '%: company does not own session %', tg_table_name, new.session_id;
  end if;
  return new;
end;
$$;

-- ── 2. live_interview_scores ─────────────────────────────────

create table if not exists public.live_interview_scores (
  session_id          uuid primary key references public.interview_sessions (id) on delete cascade,
  company_id          uuid not null,
  status              text not null default 'pending',
  questions           jsonb not null default '[]'::jsonb,
  overall_score       integer,
  scored_count        integer not null default 0,
  answered_count      integer not null default 0,
  total               integer not null default 0,
  completion_percent  integer not null default 0,
  outcome             text,
  partial             boolean not null default false,
  ai_model            text not null,
  prompt_version      text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  rev                 integer not null default 0,
  scored_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint live_interview_scores_status check (status in ('pending', 'scored', 'failed')),
  constraint live_interview_scores_questions_array check (jsonb_typeof(questions) = 'array'),
  constraint live_interview_scores_overall_range
    check (overall_score is null or overall_score between 0 and 100),
  constraint live_interview_scores_counts
    check (total >= 0 and answered_count between 0 and total and scored_count between 0 and total),
  constraint live_interview_scores_completion check (completion_percent between 0 and 100),
  constraint live_interview_scores_outcome
    check (outcome is null or outcome in ('completed', 'partial', 'abandoned', 'technical_failure')),
  -- Never ranked against a completed interview: anything short of completed is partial.
  constraint live_interview_scores_partial
    check (outcome is null or partial = (outcome <> 'completed')),
  -- A scored row has an outcome and a number built from at least one question.
  constraint live_interview_scores_scored
    check (status <> 'scored' or (outcome is not null and overall_score is not null and scored_count > 0)),
  constraint live_interview_scores_overall_needs_scored
    check (overall_score is null or scored_count > 0),
  constraint live_interview_scores_tokens check (input_tokens >= 0 and output_tokens >= 0),
  constraint live_interview_scores_rev check (rev >= 0)
);

create index if not exists live_interview_scores_company on public.live_interview_scores (company_id);

drop trigger if exists live_interview_scores_company on public.live_interview_scores;
create trigger live_interview_scores_company
  before insert or update of session_id, company_id on public.live_interview_scores
  for each row execute function public.live_scoring_session_company();

alter table public.live_interview_scores enable row level security;

-- ── 3. live_interview_actions ────────────────────────────────

create table if not exists public.live_interview_actions (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.interview_sessions (id) on delete cascade,
  company_id         uuid not null,
  action             text not null,
  decision           text not null,
  question_position  integer,
  -- No FK: the turn is named, not owned; the row goes with its session.
  turn_id            uuid,
  turn_sequence      integer,
  note               text not null,
  actor_user_id      uuid not null,
  actor_name         text,
  actor_role         text not null,
  created_at         timestamptz not null default now(),
  constraint live_interview_actions_action
    check (action in ('retry_transcription', 'resolve_needs_check', 'resolve_failed_transcription')),
  constraint live_interview_actions_decision
    check (
      (action = 'retry_transcription' and decision = 'retry')
      or (action = 'resolve_needs_check' and decision in ('score', 'exclude'))
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
    ),
  constraint live_interview_actions_target
    check (
      case action
        when 'resolve_needs_check' then question_position is not null
        else turn_id is not null and turn_sequence is not null
      end
    ),
  constraint live_interview_actions_position check (question_position is null or question_position >= 1),
  constraint live_interview_actions_sequence check (turn_sequence is null or turn_sequence >= 0),
  constraint live_interview_actions_note check (length(btrim(note)) between 1 and 2000),
  constraint live_interview_actions_role check (actor_role in ('owner', 'admin', 'super_admin'))
);

create index if not exists live_interview_actions_session
  on public.live_interview_actions (session_id, created_at);
create index if not exists live_interview_actions_company on public.live_interview_actions (company_id);

drop trigger if exists live_interview_actions_company on public.live_interview_actions;
create trigger live_interview_actions_company
  before insert on public.live_interview_actions
  for each row execute function public.live_scoring_session_company();

-- The database stamps the time; the caller cannot backdate an action.
create or replace function public.live_interview_actions_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists live_interview_actions_stamp on public.live_interview_actions;
create trigger live_interview_actions_stamp
  before insert on public.live_interview_actions
  for each row execute function public.live_interview_actions_stamp();

-- Append-only: never updated; deleted only once its session is gone.
create or replace function public.live_interview_actions_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'live_interview_actions is append-only: rows are never updated';
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'live_interview_actions is append-only: never truncated';
  end if;
  -- DELETE: allowed only through the session's cascade, which removes the
  -- session before its actions. While the session exists, refused.
  if exists (select 1 from public.interview_sessions where id = old.session_id) then
    raise exception 'live_interview_actions is append-only: a row goes only with its session';
  end if;
  return old;
end;
$$;

drop trigger if exists live_interview_actions_no_update on public.live_interview_actions;
create trigger live_interview_actions_no_update
  before update on public.live_interview_actions
  for each row execute function public.live_interview_actions_append_only();

drop trigger if exists live_interview_actions_no_delete on public.live_interview_actions;
create trigger live_interview_actions_no_delete
  before delete on public.live_interview_actions
  for each row execute function public.live_interview_actions_append_only();

drop trigger if exists live_interview_actions_no_truncate on public.live_interview_actions;
create trigger live_interview_actions_no_truncate
  before truncate on public.live_interview_actions
  for each statement execute function public.live_interview_actions_append_only();

alter table public.live_interview_actions enable row level security;

-- ── After running: should return 3 rows, each rls = true, policies = 0 ──
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c
--  where c.relnamespace = 'public'::regnamespace
--    and c.relname in ('job_question_scoring_guides', 'live_interview_scores', 'live_interview_actions');
