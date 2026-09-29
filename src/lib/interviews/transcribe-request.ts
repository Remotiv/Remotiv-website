/**
 * Asking for a transcript - the one way a `transcribe` job gets queued.
 *
 * Two callers: the candidate's upload confirmation and the recovery sweep in
 * the worker tick. Migration 032 puts a partial unique index on
 * (payload->>'answerId', payload->>'recordedAt') for queued/running rows, so a
 * second request for the same recording generation fails with 23505 and is
 * reported here as `already_queued`. A request for a NEWER generation of the
 * same answer has a different key and queues normally, which is what a
 * re-record needs; the older generation's queued job is then cancelled by
 * cancelSupersededTranscribeJobs (best effort - a running one discovers its
 * own irrelevance in the handler).
 *
 * `recordedAt` is REQUIRED. It must be the string PostgREST returned for the
 * row's recorded_at, not one formatted here - see transcribe-generation.ts.
 *
 * Same shape as lib/ai/cv-score-request.ts: no load-time import of jobs-queue
 * (it imports the handler that would import this), an injectable `enqueue`,
 * and a test that drives the overlap.
 */

/** Mirrors JOB_TYPES.TRANSCRIBE without importing jobs-queue at load. */
export const TRANSCRIBE_JOB_TYPE = "transcribe";

/** Postgres unique_violation - what 032's index raises on the second insert. */
const UNIQUE_VIOLATION = "23505";

export type EnqueueFn = (input: {
  type: string;
  payload?: Record<string, unknown>;
  companyId?: string | null;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string; code?: string }>;

export type TranscriptionRequest =
  | { ok: true; outcome: "queued" | "already_queued" }
  | { ok: false; error: string };

export async function requestTranscription(
  input: { answerId: string; recordedAt: string; companyId: string | null },
  deps: { enqueue?: EnqueueFn } = {},
): Promise<TranscriptionRequest> {
  if (!input.answerId) return { ok: false, error: "answerId missing" };
  if (!input.recordedAt)
    return { ok: false, error: "recordedAt missing - a transcribe job must name its recording" };

  const enqueue = deps.enqueue ?? (await import("@/lib/jobs-queue")).enqueue;
  const queued = await enqueue({
    type: TRANSCRIBE_JOB_TYPE,
    payload: { answerId: input.answerId, recordedAt: input.recordedAt },
    companyId: input.companyId,
  });
  if (queued.ok) return { ok: true, outcome: "queued" };
  // The index did its job: a live job for this recording already exists.
  if (queued.code === UNIQUE_VIOLATION) return { ok: true, outcome: "already_queued" };
  return { ok: false, error: queued.error };
}

/** The subset of a Supabase client this module needs, so tests can pass a fake. */
export type CancelService = {
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: unknown): CancelFilter;
    };
  };
};
type CancelFilter = {
  eq(column: string, value: unknown): CancelFilter;
  neq(column: string, value: unknown): CancelFilter;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * A re-record landed: retire any QUEUED transcribe job for an older generation
 * of this answer. Marked `succeeded` with a note, because that is exactly the
 * outcome the job would reach on its own (the handler's first generation check
 * skips it), and it keeps superseded work out of the dead list and the health
 * counts. Never touches `running` - that lease belongs to a worker, which
 * discovers the stale generation before any provider call. Best effort: the
 * caller ignores a failure here, since discovery covers it.
 */
export async function cancelSupersededTranscribeJobs(
  service: CancelService,
  answerId: string,
  currentRecordedAt: string,
): Promise<number> {
  const { data, error } = await service
    .from("background_jobs")
    .update({
      status: "succeeded",
      last_error: `superseded: answer re-recorded at ${currentRecordedAt}`,
      updated_at: new Date().toISOString(),
    })
    .eq("type", TRANSCRIBE_JOB_TYPE)
    .eq("status", "queued")
    .eq("payload->>answerId", answerId)
    .neq("payload->>recordedAt", currentRecordedAt)
    .select("id");
  if (error) {
    console.error("[transcribe-request] cancel superseded failed (non-fatal):", error.message);
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
}
