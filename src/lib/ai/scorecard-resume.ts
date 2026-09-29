/**
 * Retry of the SAME scorecard job versus a NEW deliberate re-score.
 *
 * ── The distinction (Phase 5, P2) ────────────────────────────
 *
 * The queue already has it: a retry is the same background_jobs row running
 * again; a deliberate re-score is a new row. The job id is therefore the run
 * token, and migration 033 adds `scored_by_job_id` to both score tables so
 * each persisted score remembers which run paid for it.
 *
 *   same job id, status scored   → this execution already did it: REUSE
 *   anything else                → SCORE (no row, another job's row, a failed
 *                                  or skipped row, or a null from before 033)
 *
 * A deliberate re-score enqueues a fresh job whose id matches nothing, so it
 * replaces every answer and the rollup. A retry after a crash or a yield
 * skips the answers it has already paid for. Nothing is ever skipped merely
 * because "a score row exists".
 */

export type ExistingAnswerScore = {
  answer_id: string;
  status: string;
  scored_by_job_id: string | null;
};

export type ExistingSessionScore = {
  status: string;
  scored_by_job_id: string | null;
};

export function answerRunDecision(
  existing: ExistingAnswerScore | undefined | null,
  jobId: string,
): "reuse" | "score" {
  if (!existing) return "score";
  if (existing.status !== "scored") return "score";
  return existing.scored_by_job_id === jobId ? "reuse" : "score";
}

/** The rollup already landed for this run: the retry has nothing left to pay for. */
export function sessionAlreadyComplete(
  existing: ExistingSessionScore | undefined | null,
  jobId: string,
): boolean {
  return Boolean(existing && existing.status === "scored" && existing.scored_by_job_id === jobId);
}
