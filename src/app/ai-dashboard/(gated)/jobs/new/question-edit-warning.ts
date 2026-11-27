import type { JobInviteCounts, KindInviteCounts } from "@/lib/interviews/job-invite-counts";
import { storedQuestionRows } from "@/lib/interviews/question-rows";
import type { InterviewKind, InterviewQuestionInput } from "@/lib/interviews/types";

/**
 * The wizard's line when a job's questions are edited after invitations went
 * out (#20; decision 23 Nov, #34): every invited candidate keeps the questions
 * frozen on their invite, and an edit reaches new invitations only.
 *
 * Inline on step 5 (async), step 6 (AI Video Interview) and, for the async
 * weights, step 8. No dialog: it informs, it never blocks.
 */

const KIND_NAME: Record<InterviewKind, string> = {
  async: "Async Video Interview",
  live: "AI Video Interview",
};

/**
 * Whether a save of `current` would store a different list from `baseline`,
 * compared through the save's own normaliser, in order, never by id (every
 * save gives the rows new ids).
 */
export function questionListChanged(
  baseline: readonly InterviewQuestionInput[],
  current: readonly InterviewQuestionInput[],
  kind: InterviewKind,
): boolean {
  return (
    JSON.stringify(storedQuestionRows(baseline, kind)) !==
    JSON.stringify(storedQuestionRows(current, kind))
  );
}

/** "3 candidates", or "At least 3 candidates" when the read was cut short. */
function candidates(n: number, atLeast: boolean): string {
  return `${atLeast ? "At least " : ""}${n} ${n === 1 ? "candidate" : "candidates"}`;
}

function hasHave(n: number): string {
  return n === 1 ? "has" : "have";
}

const UPDATED = "New invitations will use your updated questions.";

/** The line for one kind, or null when no candidate holds that interview. */
export function inviteWarningLine(
  kind: InterviewKind,
  counts: KindInviteCounts,
  atLeast = false,
): string | null {
  const name = KIND_NAME[kind];
  const { open, completed } = counts;
  if (open > 0 && completed > 0) {
    return `${candidates(open, atLeast)} already ${hasHave(open)} an ${name} invitation and ${atLeast ? "at least " : ""}${completed} ${hasHave(completed)} completed it. They all keep their original questions. ${UPDATED}`;
  }
  if (open > 0) {
    return `${candidates(open, atLeast)} already ${hasHave(open)} an ${name} invitation. Their questions stay as they were sent. ${UPDATED}`;
  }
  if (completed > 0) {
    return `${candidates(completed, atLeast)} ${hasHave(completed)} completed the ${name}. Their original questions stay unchanged. ${UPDATED}`;
  }
  return null;
}

/**
 * What the wizard shows for one kind: the line when that kind's list would
 * save differently from the baseline (as loaded, or as last saved in full)
 * and someone already holds that interview; null otherwise, and always null
 * on a new job (no counts).
 */
export function questionEditWarning(
  kind: InterviewKind,
  baseline: readonly InterviewQuestionInput[],
  current: readonly InterviewQuestionInput[],
  counts: JobInviteCounts | undefined,
): string | null {
  if (!counts || !questionListChanged(baseline, current, kind)) return null;
  return inviteWarningLine(kind, counts[kind], counts.atLeast);
}
