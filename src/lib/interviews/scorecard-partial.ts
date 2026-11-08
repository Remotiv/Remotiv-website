/**
 * Is this scorecard partial: scored, but not on every question?
 *
 * Derived at render from what is already stored, so it needs no column and holds
 * for scorecards written before it existed. A question counts as scored only when
 * its answer's score row is `scored`. Every other outcome counts as missing: no
 * answer recorded, a transcript that failed or could not be assessed, scoring
 * that failed or was skipped, and a question with no rubric. The denominator is
 * the questions the interview had, as in the scorecard's "Based on N of M".
 *
 * Never partial while a transcript is still pending, so a scorecard that is
 * still coming is never called incomplete. Never partial when nothing was
 * scored: that scorecard is not `scored` at all.
 *
 * Pure, with no server import: the review page imports it.
 */
export function scorecardIsPartial(session: {
  score: { status: string } | null;
  totalQuestions: number;
  answers: readonly { transcriptState: string; score: { status: string } | null }[];
}): boolean {
  if (session.score?.status !== "scored") return false;
  if (session.answers.some((a) => a.transcriptState === "pending")) return false;
  const questions = Math.max(session.totalQuestions, session.answers.length);
  const scored = session.answers.filter((a) => a.score?.status === "scored").length;
  return scored > 0 && scored < questions;
}
