/**
 * What a person decided about an AI Video Interview, read from its recovery
 * log (migrations 042, 043, 048 and 049, live_interview_actions). Timing,
 * repeat, wording and style checks are separate decisions: each is read only
 * from its own action. The log is append-only, so the
 * LATEST action on a question or a turn is the one that holds: a timing check
 * resolved 'score' and later 'exclude' is excluded; a failed turn excluded and
 * later retried is no longer excluded.
 *
 * Pure: no I/O. Used by the settle (live-transcribe.ts), which lets an
 * excluded failed turn count as resolved for `final`, and by the scorer
 * (live-scoring.ts), which leaves those questions out.
 */

export type LiveActionRow = {
  action: string;
  decision: string;
  question_position: number | null;
  turn_id: string | null;
  turn_sequence: number | null;
  created_at: string;
};

export type NeedsCheckDecision = "score" | "exclude";

/** Oldest first, so a later action overwrites an earlier one. Stable for equal times. */
function inOrder(actions: readonly LiveActionRow[]): LiveActionRow[] {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.created_at.localeCompare(y.a.created_at) || x.i - y.i)
    .map((x) => x.a);
}

function decisionsOf(
  actions: readonly LiveActionRow[],
  action:
    | "resolve_needs_check"
    | "resolve_repeat_check"
    | "resolve_wording_check"
    | "resolve_style_check",
): Map<number, NeedsCheckDecision> {
  const out = new Map<number, NeedsCheckDecision>();
  for (const a of inOrder(actions)) {
    if (a.action !== action || a.question_position === null) continue;
    if (a.decision === "score" || a.decision === "exclude")
      out.set(a.question_position, a.decision);
  }
  return out;
}

/**
 * The holding TIMING-check decision per question position. Only
 * resolve_needs_check counts: a style resolution never clears a timing check.
 */
export function needsCheckDecisions(
  actions: readonly LiveActionRow[],
): Map<number, NeedsCheckDecision> {
  return decisionsOf(actions, "resolve_needs_check");
}

/**
 * The holding REPEAT-check decision per question position (migration 048): a
 * repeat not asked as agreed, checked against the recording. Only
 * resolve_repeat_check counts: a timing or style resolution never clears it.
 */
export function repeatCheckDecisions(
  actions: readonly LiveActionRow[],
): Map<number, NeedsCheckDecision> {
  return decisionsOf(actions, "resolve_repeat_check");
}

/**
 * The holding WORDING-check decision per question position (migration 049): a
 * base question first asked other than as frozen, checked against the
 * recording. Only resolve_wording_check counts: no other resolution clears it.
 */
export function wordingCheckDecisions(
  actions: readonly LiveActionRow[],
): Map<number, NeedsCheckDecision> {
  return decisionsOf(actions, "resolve_wording_check");
}

/**
 * The holding STYLE-check decision per question position (migration 043).
 * Only resolve_style_check counts: a timing resolution never clears a style check.
 */
export function styleCheckDecisions(
  actions: readonly LiveActionRow[],
): Map<number, NeedsCheckDecision> {
  return decisionsOf(actions, "resolve_style_check");
}

/**
 * Sequences of failed candidate turns a person excluded and has not since
 * retried. A turn that is no longer failed (retried and transcribed) is never
 * excluded, whatever the log says.
 */
export function excludedFailedTurns(
  actions: readonly LiveActionRow[],
  turns: readonly { id: string; sequence: number; transcript_status: string | null }[],
): Set<number> {
  const last = new Map<string, string>();
  for (const a of inOrder(actions)) {
    if (!a.turn_id) continue;
    if (a.action === "resolve_failed_transcription" || a.action === "retry_transcription") {
      last.set(a.turn_id, a.action);
    }
  }
  const out = new Set<number>();
  for (const t of turns) {
    if (t.transcript_status === "failed" && last.get(t.id) === "resolve_failed_transcription") {
      out.add(t.sequence);
    }
  }
  return out;
}
