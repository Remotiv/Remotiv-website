-- ============================================================================
-- Migration 081 - AI Video Interview: a question asked out of the agreed order
--                 is kept and held, with its own review decision (#15)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production, by hand in the Supabase
-- SQL editor, AFTER 078 (and 080) and BEFORE the code that ships with it is
-- pushed: that code writes 'resolve_order_check', which the constraints this
-- file replaces refuse.
--
-- 079 belongs to the other session (WhatsApp); this file touches nothing of
-- theirs. 080 changed a storage function only; nothing here overlaps it.
--
-- ── resolve_order_check ──────────────────────────────────────
--
-- The importer (live-ingest.ts, assessLiveExport) checks the provider's turns
-- against the invitation's FROZEN question positions: Q1, its follow-ups,
-- then Q2. A question asked before an earlier one, asked twice, or with a
-- follow-up or an answer out of place is kept, every turn and its audio, and
-- held from scoring (order_check in the outcome, jsonb, 041) until the owner
-- or admin checks the recording and decides: 'score' (counted as usual) or
-- 'exclude' (left out, never zero). Waleed's decision, 26 Nov 2026: flag and
-- hold, never refuse.
--
-- Its own action, like 048, 049, 076's and 078's: a question can be held for
-- more than one reason, and resolving one never clears another. Same
-- decisions and the same required question position as the other
-- per-question checks.
--
-- The three constraints are 078's, with the new action added after
-- 'resolve_time_limit_check' and nothing else changed: every existing value is
-- kept, in order.
--
-- ── Nothing else ─────────────────────────────────────────────
--
-- A second asking of a question needs no schema change: interview_turns (021)
-- has no unique rule on a question's base question, only on (session,
-- question, follow-up index), and each turn's audio has its own path by
-- sequence. #16's new turn types (repeat_offer, not_answered) are stored as
-- procedural turns, a kind 021 already allows.
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
        'resolve_order_check',
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
          'resolve_order_check',
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
          'resolve_order_check',
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
--       and pg_get_constraintdef(oid) like '%resolve_order_check%') as new_action_in_all_three,
--   -- 078's action is still there, so 078 was applied first and nothing was lost
--   (select count(*) = 3 from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname in ('live_interview_actions_action',
--                       'live_interview_actions_decision',
--                       'live_interview_actions_target')
--       and pg_get_constraintdef(oid) like '%resolve_time_limit_check%') as time_limit_action_kept,
--   -- and the oldest ones
--   (select pg_get_constraintdef(oid) like '%retry_transcription%'
--       and pg_get_constraintdef(oid) like '%resolve_failed_transcription%'
--       and pg_get_constraintdef(oid) like '%decide_restart%'
--      from pg_constraint
--     where conrelid = 'public.live_interview_actions'::regclass
--       and conname = 'live_interview_actions_action') as old_actions_kept;
-- ============================================================================
