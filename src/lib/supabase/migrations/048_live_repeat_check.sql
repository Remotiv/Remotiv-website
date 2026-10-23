-- ============================================================================
-- Migration 048 — live_interview_actions: 'resolve_repeat_check'
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 046.
--
-- Numbered 048, not 047: 047 is reserved for access-log retention.
--
-- ── Before running: the count should be 0 ────────────────────
-- Nothing writes this table yet (live interviews are not wired), so the new
-- checks validate against an empty table.
--
-- select count(*) from public.live_interview_actions;
--
-- ── resolve_repeat_check ─────────────────────────────────────
--
-- A marked repeat of a question that does not ask it as agreed (an unexpected
-- phrase before the frozen question, or altered wording) no longer refuses
-- the whole export. The export is saved, the question is flagged on the
-- review page, and it waits for a person, answered or skipped alike, because
-- a hint can shape a skip as easily as an answer. The owner or admin checks
-- the recording and decides: 'score' (scored as usual; skipped still scores
-- the lowest) or 'exclude' (left out, never zero).
--
-- Its own action, separate from the timing check (resolve_needs_check) and
-- the style check (resolve_style_check): resolving one never clears another.
-- Same decisions and the same required question position as those two.
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
        action in ('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check')
        and decision in ('score', 'exclude')
      )
      or (action = 'resolve_failed_transcription' and decision = 'exclude')
    );

alter table public.live_interview_actions
  drop constraint if exists live_interview_actions_target,
  add constraint live_interview_actions_target
    check (
      case
        when action in ('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check')
          then question_position is not null
        else turn_id is not null and turn_sequence is not null
      end
    );

-- ── After running: should list these 3 constraints, each naming resolve_repeat_check ──
-- select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conrelid = 'public.live_interview_actions'::regclass
--    and conname in (
--          'live_interview_actions_action', 'live_interview_actions_decision',
--          'live_interview_actions_target')
--  order by 1;
