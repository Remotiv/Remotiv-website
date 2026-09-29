/**
 * Asking for a CV score - the one way an `ai_cv_score` job gets queued.
 *
 * Five places want one: /api/apply, a manual add, attaching a CV, Re-score on
 * an applicant and Re-score on a whole job. The queue has no dedupe key, so
 * two of them can enqueue for the same application inside the same window and
 * pay for two identical Claude calls. Migration 030 puts a partial unique
 * index on (payload->>'applicationId') for queued/running rows; the second
 * insert fails with 23505 and this reports it as `already_queued`, which every
 * caller treats as success. A finished job leaves the index, so a deliberate
 * later Re-score still works.
 *
 * Same shape as lib/interviews/scorecard.ts, for the same reasons: no
 * load-time import of jobs-queue (it imports the scorer that would import
 * this), an injectable `enqueue`, and a test that drives the overlap.
 */

/** Mirrors JOB_TYPES.AI_CV_SCORE without importing jobs-queue at load. */
export const CV_SCORE_JOB_TYPE = "ai_cv_score";

/** Postgres unique_violation - what 030's index raises on the second insert. */
const UNIQUE_VIOLATION = "23505";

export type EnqueueFn = (input: {
  type: string;
  payload?: Record<string, unknown>;
  companyId?: string | null;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string; code?: string }>;

export type CvScoreRequest =
  | { ok: true; outcome: "queued" | "already_queued" }
  | { ok: false; error: string };

export async function requestCvScore(
  applicationId: string,
  companyId: string | null,
  deps: { enqueue?: EnqueueFn } = {},
): Promise<CvScoreRequest> {
  const enqueue = deps.enqueue ?? (await import("@/lib/jobs-queue")).enqueue;
  const queued = await enqueue({
    type: CV_SCORE_JOB_TYPE,
    payload: { applicationId },
    companyId,
  });
  if (queued.ok) return { ok: true, outcome: "queued" };
  // The index did its job: a live job for this application already exists.
  // Not an error - the score is on its way.
  if (queued.code === UNIQUE_VIOLATION) return { ok: true, outcome: "already_queued" };
  return { ok: false, error: queued.error };
}
