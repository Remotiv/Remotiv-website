import type { InterviewKind } from "./types";

/**
 * The two frozen copies an invite writes, both from ONE read of the job's
 * questions (#44).
 *
 * A job save (replace_interview_questions, migration 082) deletes the list and
 * inserts it again with new ids, in one transaction. A send that read the
 * table more than once could see one version in one read and the next in
 * another: a count that disagreed with the snapshot, or a question snapshot
 * paired with the other version's rubrics. Postgres gives one statement one
 * instant, so the send reads the rows once, with every column both copies
 * need, and these mappers project that one array twice. Pure, so the mapping
 * is tested on its own and the send cannot drift from it.
 *
 *   questionsSnapshotOf   what the candidate is SENT: id, position, the text
 *                         and the timings. No rubric, competency or weight:
 *                         this array becomes the candidate payload
 *                         (SnapshotQuestion in session.ts). Do not add them.
 *   scoringSnapshotOf     the marking scheme (migration 028), which no
 *                         candidate-facing read selects. Live questions all
 *                         count equally in v1: frozen with weight 1, the live
 *                         scorer's own unit. Async weights as stored.
 *
 * Both carry the question id, and the scoring entry's position is the
 * question's, so a reader joins them by id and never has to trust position
 * alone.
 */

/**
 * One row of the one read: every column both snapshots need, nothing else.
 * The select text itself lives beside the read (INVITE_QUESTION_COLUMNS in
 * applicants/interview-actions.ts), where the tenant scan can read it;
 * invite-race.test.ts pins the two to each other.
 */
export type InviteQuestionRow = {
  id: string;
  position: number;
  question: string | null;
  prep_seconds: number | null;
  answer_seconds: number | null;
  required: boolean | null;
  competency: string | null;
  rubric: string | null;
  weight: number | null;
};

export type QuestionsSnapshotEntry = Pick<
  InviteQuestionRow,
  "id" | "position" | "question" | "prep_seconds" | "answer_seconds" | "required"
>;

export type ScoringSnapshotEntry = {
  position: number;
  question_id: string;
  competency: string | null;
  rubric: string | null;
  weight: number | null;
};

/** Every live question's frozen weight in v1: the live scorer's Normal (multiplier 1). */
export const LIVE_QUESTION_WEIGHT = 1;

/** An async question's stored weight, or null (Normal) when it holds none. */
function storedWeight(weight: number | null): number | null {
  return typeof weight === "number" && weight > 0 ? weight : null;
}

export function questionsSnapshotOf(rows: readonly InviteQuestionRow[]): QuestionsSnapshotEntry[] {
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    question: r.question,
    prep_seconds: r.prep_seconds,
    answer_seconds: r.answer_seconds,
    required: r.required,
  }));
}

export function scoringSnapshotOf(
  rows: readonly InviteQuestionRow[],
  kind: InterviewKind,
): ScoringSnapshotEntry[] {
  return rows.map((r) => ({
    position: r.position,
    question_id: r.id,
    competency: (r.competency ?? "").trim() || null,
    rubric: (r.rubric ?? "").trim() || null,
    weight: kind === "live" ? LIVE_QUESTION_WEIGHT : storedWeight(r.weight),
  }));
}
