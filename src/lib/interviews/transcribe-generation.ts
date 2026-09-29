/**
 * Which recording a transcribe job belongs to.
 *
 * ── The problem (Phase 5, P3/P12) ────────────────────────────
 *
 * An answer keeps its row id across re-records: the confirm route upserts on
 * (session_id, position) and overwrites the video at the same path. A
 * transcribe job keyed on answerId alone therefore cannot say WHICH recording
 * it was queued for, so a stale job could write the old recording's words onto
 * the new one, and a recovery sweep could mistake an old job for evidence that
 * the current recording is being handled.
 *
 * `interview_answers.recorded_at` is the recording generation. The job payload
 * carries it as `recordedAt`, copied verbatim from the row PostgREST returned
 * on the upsert, so the string in every payload has the database's own
 * formatting and two jobs for the same generation compare equal in the 032
 * index. Inside the handler, comparisons are on the instant, not the string.
 *
 * ── Legacy payloads ──────────────────────────────────────────
 *
 * A payload with no `recordedAt` predates this contract. The handler runs it
 * once with no generation check, exactly as before. This path exists for
 * safety only: the pre-deploy check (migration 032, step 0b) confirmed ZERO
 * queued or running transcribe jobs without recordedAt at the time of this
 * deploy, so it is not exercised by it. Nothing enqueued after deploy can take
 * it, because requestTranscription refuses a payload without a generation.
 */

export type TranscribePayload = {
  answerId: string;
  /** The recording generation, or null on a legacy job. */
  recordedAt: string | null;
};

export type GenerationDecision =
  /** No generation on the job: run once, unchecked. Pre-deploy jobs only. */
  | "legacy"
  /** The job is for the recording the row currently holds. */
  | "match"
  /** The row has been re-recorded since this job was queued. Do nothing. */
  | "stale";

export function readTranscribePayload(
  payload: Record<string, unknown> | null | undefined,
): TranscribePayload | null {
  const answerId = payload?.answerId;
  if (typeof answerId !== "string" || !answerId) return null;
  const recordedAt = payload?.recordedAt;
  return { answerId, recordedAt: typeof recordedAt === "string" && recordedAt ? recordedAt : null };
}

/** Same instant, whatever the textual form. Two nulls are not the same recording. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

export function resolveGeneration(
  payloadRecordedAt: string | null,
  rowRecordedAt: string | null | undefined,
): GenerationDecision {
  if (payloadRecordedAt === null) return "legacy";
  return sameInstant(payloadRecordedAt, rowRecordedAt) ? "match" : "stale";
}

/**
 * May a write for this job land on this row? The rule the handler's
 * compare-and-set enforces in SQL (`.eq("recorded_at", payload.recordedAt)`):
 * a generationed job writes only to its own generation; a legacy job has no
 * generation to check.
 */
export function mayPersist(
  payloadRecordedAt: string | null,
  rowRecordedAt: string | null | undefined,
): boolean {
  return resolveGeneration(payloadRecordedAt, rowRecordedAt) !== "stale";
}
