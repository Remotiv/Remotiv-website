-- ============================================================================
-- Migration 076 - AI Video Interview: follow-ups past the limit are kept and
--                 held (#48), with their own review decision (combined flags)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor, BEFORE the code that ships with it is pushed: that code saves
-- follow-up indexes above 2 and writes 'resolve_follow_up_check', and both are
-- refused by the constraints this file replaces.
--
-- 075 and 077 belong to the calendar work; this file touches nothing of theirs.
--
-- ── 1. interview_turns: follow-up index 1 to 10 (was 1 or 2) ─
--
-- 021 allowed follow_up_index 1 or 2, so a third follow-up on one question
-- could not be stored at all and the importer refused the WHOLE interview's
-- export. An interview must never be lost because the interviewer asked too
-- much: the extra follow-up is now kept, with its audio, and its question is
-- held for a person (follow_up_check in the outcome).
--
-- Why 10 and not unbounded: the most any job allows is 2 (AI-Guided), so 3 to
-- 10 is "the interviewer overran", worth keeping and reviewing; more than 10
-- on one question is not an interview any more but broken data (a loop, a
-- mislabelled transcript), and the importer refuses that export as it always
-- has. 10 keeps a real overrun storable with a wide margin, and keeps the
-- index a small number a reviewer can read. The rest of 021's rule is kept
-- word for word: only a follow_up carries an index, and every follow_up does.
-- The unique index interview_turns_one_follow_up_per_slot (one row per
-- session, question and index) is unchanged.
--
-- ── 2. live_interview_actions: 'resolve_follow_up_check' ─────
--
-- A question can be held for more than one reason at once: asked in changed
-- words (resolve_wording_check, 049) AND followed up too often. Each reason
-- needs its own decision, so that resolving one never silently clears the
-- other. Folding the follow-ups into the wording check would make one
-- 'score' clear both, so the follow-up check gets its own action, like 048
-- and 049 did: same decisions ('score' or 'exclude') and the same required
-- question position. The three constraints are 053's, with the new action
-- added and nothing else changed.
--
-- ── Safe to apply, safe to re-run ────────────────────────────
--
-- Each CHECK is dropped if it exists and added again. Widening a CHECK
-- accepts every existing row (all of which already meet the narrower rule),
-- so nothing is rewritten; live_interview_actions' append-only trigger (042)
-- is not involved, because no row is updated. No table, column, index,
-- function, grant or policy is added or changed.
-- ============================================================================

begin;

alter table public.interview_turns
  drop constraint if exists interview_turns_follow_up_index,
  add constraint interview_turns_follow_up_index
    check (
      (kind is not distinct from 'follow_up') = (follow_up_index is not null)
      and (follow_up_index is null or follow_up_index between 1 and 10)
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_action,
  add constraint live_interview_actions_action
    check (
      action in (
        'retry_transcription',
        'resolve_needs_check',
        'resolve_repeat_check',
        'resolve_wording_check',
        'resolve_follow_up_check',
        'resolve_style_check',
        'resolve_failed_transcription',
        'decide_restart'
      )
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_decision,
  add constraint live_interview_actions_decision
    check (
      (action = 'retry_transcription' and decision = 'retry')
      or (
        action in (
          'resolve_needs_check',
          'resolve_repeat_check',
          'resolve_wording_check',
          'resolve_follow_up_check',
          'resolve_style_check'
        )
        and decision in ('score', 'exclude')
      )
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
      or (action = 'decide_restart' and decision in ('restart', 'no_restart'))
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_target,
  add constraint live_interview_actions_target
    check (
      case
        when action in (
          'resolve_needs_check',
          'resolve_repeat_check',
          'resolve_wording_check',
          'resolve_follow_up_check',
          'resolve_style_check'
        )
          then question_position is not null
        when action = 'decide_restart'
          then question_position is null and turn_id is null and turn_sequence is null
        else turn_id is not null and turn_sequence is not null
      end
    );

commit;

-- ============================================================================
-- CHECK (read-only). Run after applying; every column of the result must be true.
-- ----------------------------------------------------------------------------
--
-- select
--   -- the follow-up rule: 1 to 10, only on a follow_up
--   (select pg_get_constraintdef(oid) like '%follow_up_index >= 1%follow_up_index <= 10%'
--      from pg_constraint
--     where conrelid = 'public.interview_turns'::regclass
--       and conname = 'interview_turns_follow_up_index') as follow_up_index_1_to_10,
--   -- one row per session, question and index, as before
--   (select count(*) = 1 from pg_indexes
--     where schemaname = 'public' and tablename = 'interview_turns'
--       and indexname = 'interview_turns_one_follow_up_per_slot') as one_per_slot_kept,
--   -- the new action, in all three constraints
--   (select count(*) = 3 from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname in ('live_interview_actions_action',
--                       'live_interview_actions_decision',
--                       'live_interview_actions_target')
--       and pg_get_constraintdef(oid) like '%resolve_follow_up_check%') as new_action_in_all_three,
--   -- the old actions are all still there
--   (select pg_get_constraintdef(oid) like '%resolve_wording_check%'
--       and pg_get_constraintdef(oid) like '%decide_restart%'
--      from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname = 'live_interview_actions_action') as old_actions_kept,
--   -- no stored row is outside the new rule (it can only be wider)
--   (select count(*) = 0 from public.interview_turns
--     where follow_up_index is not null and follow_up_index not between 1 and 10) as rows_fit;
-- ============================================================================
