-- ============================================================================
-- Migration 049 - live_interview_actions: 'resolve_wording_check'
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 048.
--
-- 047 stays reserved for access-log retention; 048 is resolve_repeat_check.
--
-- ── Before running ───────────────────────────────────────────
-- The action, decision and target constraints should be 048's (they name
-- resolve_repeat_check and not resolve_wording_check). Nothing writes this
-- table yet, so the new checks validate against an empty table.
--
-- ── resolve_wording_check ────────────────────────────────────
--
-- The FIRST asking of a question (its base_question turn) that is not the
-- frozen question, once the approved harmless differences are set aside, is
-- flagged on the review page and held from scoring, answered or skipped
-- alike, until the owner or admin checks the recording and decides: 'score'
-- (scored as usual; skipped still scores the lowest) or 'exclude' (left out,
-- never zero).
--
-- Its own action, separate from the timing check (resolve_needs_check), the
-- repeat check (resolve_repeat_check, 048) and the style check
-- (resolve_style_check): resolving one never clears another. Same decisions
-- and the same required question position as those three.
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- Every constraint is dropped if it exists before it is added. Changing a
-- CHECK does not update rows, so live_interview_actions' append-only trigger
-- (042) is not involved. No table, column or row is added or changed.
-- ============================================================================

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_action,
  add constraint live_interview_actions_action
    check (
      action in (
        'retry_transcription',
        'resolve_needs_check',
        'resolve_repeat_check',
        'resolve_wording_check',
        'resolve_style_check',
        'resolve_failed_transcription'
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
          'resolve_style_check'
        )
        and decision in ('score', 'exclude')
      )
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
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
          'resolve_style_check'
        )
          then question_position is not null
        else turn_id is not null and turn_sequence is not null
      end
    );

-- ── After running: these 3 constraints, each naming resolve_wording_check ──
-- select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conrelid = 'public.live_interview_actions'::regclass
--    and conname in (
--          'live_interview_actions_action', 'live_interview_actions_decision',
--          'live_interview_actions_target')
--  order by 1;
