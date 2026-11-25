-- ============================================================================
-- Migration 078 - AI Video Interview: speech after the time limit is kept and
--                 held, with its own review decision (#50)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor, AFTER 076 and BEFORE the code that ships with it is pushed: that
-- code writes 'resolve_time_limit_check', which the constraints this file
-- replaces refuse.
--
-- 077 belongs to the calendar work; this file touches nothing of theirs.
--
-- ── resolve_time_limit_check ─────────────────────────────────
--
-- A turn the provider's export places after the session's frozen length
-- (live_settings.max_session_seconds, from the conversation's start) is kept,
-- with its audio, and its question is held from scoring (time_limit_check in
-- the outcome) until the owner or admin checks the recording and decides:
-- 'score' (counted as usual) or 'exclude' (left out, never zero). So is a
-- question near the limit when the provider's clock and Remotiv's disagree.
--
-- Its own action, like 048, 049 and 076's: a question can be held for more
-- than one reason, and resolving one never clears another. Same decisions and
-- the same required question position as the other per-question checks.
--
-- The three constraints are 076's, with the new action added after
-- 'resolve_follow_up_check' and nothing else changed: every existing value is
-- kept, in order.
--
-- ── Nothing else ─────────────────────────────────────────────
--
-- #51 (a broken export kept as evidence, recorded as a technical failure)
-- needs no schema change: the evidence file sits in the session's existing
-- private folder of the interview-videos bucket, where the six-month purge and
-- every deletion already remove the whole folder, and the failure is written
-- into interview_sessions.live_outcome, which is jsonb (041).
--
-- ── Safe to apply, safe to re-run ────────────────────────────
--
-- Each CHECK is dropped if it exists and added again, wider than before, so
-- every existing row still passes; no row is updated, so live_interview_actions'
-- append-only trigger (042) is not involved. No table, column, index,
-- function, grant or policy is added or changed.
-- ============================================================================

begin;

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
        'resolve_time_limit_check',
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
          'resolve_time_limit_check',
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
          'resolve_time_limit_check',
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
--   -- the new action, in all three constraints
--   (select count(*) = 3 from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname in ('live_interview_actions_action',
--                       'live_interview_actions_decision',
--                       'live_interview_actions_target')
--       and pg_get_constraintdef(oid) like '%resolve_time_limit_check%') as new_action_in_all_three,
--   -- 076's action is still there, so 076 was applied first and nothing was lost
--   (select count(*) = 3 from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname in ('live_interview_actions_action',
--                       'live_interview_actions_decision',
--                       'live_interview_actions_target')
--       and pg_get_constraintdef(oid) like '%resolve_follow_up_check%') as follow_up_action_kept,
--   -- and the oldest ones
--   (select pg_get_constraintdef(oid) like '%retry_transcription%'
--       and pg_get_constraintdef(oid) like '%resolve_failed_transcription%'
--       and pg_get_constraintdef(oid) like '%decide_restart%'
--      from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname = 'live_interview_actions_action') as old_actions_kept;
-- ============================================================================
