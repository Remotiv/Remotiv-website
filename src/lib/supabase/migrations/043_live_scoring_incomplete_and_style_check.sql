-- ============================================================================
-- Migration 043 — live_interview_scores: 'incomplete' and skipped_count;
--                 live_interview_actions: 'resolve_style_check'
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 042.
--
-- ── Before running: both counts should be 0 ──────────────────
-- Nothing writes these tables yet (live scoring is not wired), so the new
-- checks validate against empty tables.
--
-- select (select count(*) from public.live_interview_scores)  as live_interview_scores,
--        (select count(*) from public.live_interview_actions) as live_interview_actions;
--
-- ── 'incomplete': evidence and per-question scores, no overall ──
--
-- An abandoned or technical-failure interview keeps each question's score and
-- evidence but never gets an overall: the recruiter sees "Incomplete - X of 8
-- answered". A completed or partial interview is incomplete too when nothing
-- in it can be scored (scored_count 0, e.g. every question excluded after
-- review). A completed interview with every question skipped is NOT
-- incomplete: skipped questions score the lowest (decision D2), so it is
-- 'scored' with overall 0 and "0 of 8 answered".
--
-- No overall for abandoned or technical_failure, ever (overall_outcome), and
-- no overall on an incomplete row (incomplete).
--
-- ── skipped_count ────────────────────────────────────────────
--
-- On every row beside answered_count and total, so a 0 for a skipped question
-- reads differently from a 0 for a bad answer.
--
-- ── resolve_style_check ──────────────────────────────────────
--
-- A rationale that still describes HOW the candidate spoke after one retry is
-- stripped of that sentence and its question waits for a person, separately
-- from the timing check (resolve_needs_check): resolving one never clears the
-- other. Same decisions ('score' / 'exclude') and the same required position.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- Every constraint is dropped if it exists before it is added, and the column
-- is added only if missing. Changing a CHECK does not update rows, so
-- live_interview_actions' append-only trigger (042) is not involved.
-- ============================================================================

-- ── live_interview_scores ────────────────────────────────────

alter table public.live_interview_scores
  add column if not exists skipped_count integer not null default 0;

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_status,
  add constraint live_interview_scores_status
    check (status in ('pending', 'scored', 'incomplete', 'failed'));

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_skipped,
  add constraint live_interview_scores_skipped
    check (skipped_count between 0 and total and answered_count + skipped_count <= total);

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_incomplete,
  add constraint live_interview_scores_incomplete
    check (status <> 'incomplete' or overall_score is null);

alter table public.live_interview_scores
  drop constraint if exists live_interview_scores_overall_outcome,
  add constraint live_interview_scores_overall_outcome
    check (overall_score is null or outcome in ('completed', 'partial'));

-- ── live_interview_actions ───────────────────────────────────

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_action,
  add constraint live_interview_actions_action
    check (
      action in (
        'retry_transcription',
        'resolve_needs_check',
        'resolve_style_check',
        'resolve_failed_transcription'
      )
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_decision,
  add constraint live_interview_actions_decision
    check (
      (action = 'retry_transcription' and decision = 'retry')
      or (action in ('resolve_needs_check', 'resolve_style_check') and decision in ('score', 'exclude'))
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_target,
  add constraint live_interview_actions_target
    check (
      case
        when action in ('resolve_needs_check', 'resolve_style_check') then question_position is not null
        else turn_id is not null and turn_sequence is not null
      end
    );

-- ── After running: should list these 7 constraints with their definitions ──
-- select conrelid::regclass as "table", conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conname in (
--          'live_interview_scores_status', 'live_interview_scores_skipped',
--          'live_interview_scores_incomplete', 'live_interview_scores_overall_outcome',
--          'live_interview_actions_action', 'live_interview_actions_decision',
--          'live_interview_actions_target')
--  order by 1, 2;
