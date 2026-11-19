import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Asking for an interview scorecard - the ONE way an `ai_scorecard` job gets
 * queued, shared by the three callers that can want it:
 *
 *   - the transcribe handler, when the last transcript lands
 *   - the candidate's submit, when the session closes
 *   - a recruiter's "Score interview" on the review page
 *
 * ── Why submit has to ask too ────────────────────────────────
 *
 * Until this file, only transcription asked, and it read the session status
 * ONCE. The ordering that strands a session is ordinary: the last answer's
 * transcript finishes while the candidate is still on the review screen, the
 * check sees `started` and returns, the candidate then submits, and nothing is
 * left to ask again. Submitted, every transcript done, no scorecard, no job.
 *
 * Both paths now WRITE THEN ASK: transcription marks its answer done and then
 * asks; submit marks the session submitted and then asks. For neither to
 * enqueue, submit's pending-count would have to run before transcription's
 * write AND transcription's status read before submit's write - which puts
 * submit's read before its own write. Under READ COMMITTED at least one of
 * them sees the other's committed row, so at least one asks with a complete
 * picture.
 *
 * ── Why at most one job ──────────────────────────────────────
 *
 * The queue has no dedupe key, so two callers can both pass the "is one
 * already queued?" read and both insert. The handler upserts, so the RESULT is
 * idempotent, but both jobs run and both are paid for. The guard is a partial
 * unique index - migration 027 - on (payload->>'sessionId') for live
 * `ai_scorecard` rows; the second insert fails with 23505 and is reported here
 * as `already_queued`, which every caller treats as success. Once the job
 * completes the row leaves the index, so a later deliberate re-score is still
 * possible. The pre-check below stays as a cheap way to keep the queue
 * readable; it is NOT the guard, and without the index the window is open.
 *
 * ── Testable under bare Node ─────────────────────────────────
 *
 * No "server-only", no load-time import of jobs-queue (it imports the
 * transcribe handler, which imports this - a cycle), and `enqueue` is
 * injectable. scorecard.test.ts drives the interleavings above with an
 * in-memory service and an enqueue that models the index.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Mirrors JOB_TYPES.AI_SCORECARD without importing jobs-queue at load. */
export const SCORECARD_JOB_TYPE = "ai_scorecard";

/** The statuses the partial index (027) and the pre-check both call "live". */
const LIVE_JOB_STATUSES = ["queued", "running"];

/** Postgres unique_violation - what 027's index raises on the second insert. */
const UNIQUE_VIOLATION = "23505";

export type EnqueueFn = (input: {
  type: string;
  payload?: Record<string, unknown>;
  companyId?: string | null;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string; code?: string }>;

export type ScorecardRequest =
  | { ok: true; outcome: "queued" | "already_queued" }
  | {
      ok: false;
      reason: "no_session" | "not_submitted" | "transcripts_pending" | "enqueue_failed";
      error?: string;
    };

/** What the eligibility rules need to know that the caller has to read. */
export type ScorecardFacts = {
  /** Answers whose transcript is still `pending`. Failed and skipped are settled. */
  pendingTranscripts: number;
  /** An `ai_scorecard` job for this session is queued or running. */
  liveJob: boolean;
};

/**
 * Throws when either read fails. Read as zero and none, an unknown state would
 * look like "nothing pending, nothing queued" and let a caller queue (or offer
 * to queue) a run it knows nothing about.
 */
export async function readScorecardFacts(
  service: Service,
  sessionId: string,
): Promise<ScorecardFacts> {
  const [{ count, error: countError }, { data: live, error: liveError }] = await Promise.all([
    service
      .from("interview_answers")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("transcript_status", "pending"),
    service
      .from("background_jobs")
      .select("id")
      .eq("type", SCORECARD_JOB_TYPE)
      .in("status", LIVE_JOB_STATUSES)
      .contains("payload", { sessionId })
      .limit(1),
  ]);
  if (countError || liveError) throw new Error("[scorecard] facts read failed");
  return { pendingTranscripts: count ?? 0, liveJob: (live ?? []).length > 0 };
}

/**
 * Ask for the scorecard if the session is ready for one.
 *
 * Ready means: the session is `submitted` and no transcript is still pending.
 * A `failed` or `skipped` transcript counts as settled on purpose - a
 * recording over Whisper's ceiling must not block the other answers forever;
 * the handler skips that one answer, scores the rest and says "based on N of
 * M answers" in the summary.
 *
 * Deliberately does NOT check whether scoring is enabled for the deployment.
 * When it is off, the handler writes a `skipped` scorecard that SAYS so, and a
 * reviewer reading "turned off for this deployment" is better served than one
 * reading nothing. The recruiter's button is gated on it separately - see
 * scorecardRecoveryEligibility - because that button costs money on purpose.
 */
export async function requestScorecard(
  service: Service,
  sessionId: string,
  deps: { enqueue?: EnqueueFn } = {},
): Promise<ScorecardRequest> {
  const { data: sessionRow, error: sessionError } = await service
    .from("interview_sessions")
    .select("id, status")
    .eq("id", sessionId)
    .maybeSingle();
  // A failed read is not "no session": throw, as readScorecardFacts does.
  if (sessionError) throw new Error("[scorecard] session read failed");
  const session = sessionRow as { status: string } | null;
  if (!session) return { ok: false, reason: "no_session" };
  if (session.status !== "submitted") return { ok: false, reason: "not_submitted" };

  const facts = await readScorecardFacts(service, sessionId);
  if (facts.pendingTranscripts > 0) return { ok: false, reason: "transcripts_pending" };
  if (facts.liveJob) return { ok: true, outcome: "already_queued" };

  // Imported at CALL time so this module can be loaded by the transcribe
  // handler without closing an initialisation cycle through jobs-queue.
  const enqueue = deps.enqueue ?? (await import("@/lib/jobs-queue")).enqueue;

  const queued = await enqueue({
    type: SCORECARD_JOB_TYPE,
    payload: { sessionId },
    companyId: null,
  });
  if (queued.ok) return { ok: true, outcome: "queued" };
  // The index did its job: somebody else's insert landed between our pre-check
  // and this insert. Not an error - the scorecard is on its way.
  if (queued.code === UNIQUE_VIOLATION) return { ok: true, outcome: "already_queued" };
  return { ok: false, reason: "enqueue_failed", error: queued.error };
}

/**
 * The automatic askers' call (the submit route and the transcribe handler).
 *
 * Never throws and never fails the caller: the interview is submitted, or the
 * transcript stored, either way, and the review page offers "Score interview"
 * for a session with no scorecard and nothing queued. But a request that did
 * not queue is logged, never dropped: requestScorecard RETURNS a failed
 * enqueue rather than throwing it, so a bare try/catch never saw one.
 * `transcripts_pending` and `not_submitted` are expected and stay quiet; the
 * other asker queues later.
 */
export async function askForScorecard(
  service: Service,
  sessionId: string,
  label: string,
  deps: { enqueue?: EnqueueFn } = {},
): Promise<ScorecardRequest | null> {
  try {
    const asked = await requestScorecard(service, sessionId, deps);
    if (!asked.ok && (asked.reason === "enqueue_failed" || asked.reason === "no_session")) {
      console.error(`[${label}] session ${sessionId}: scorecard not queued (${asked.reason})`);
    }
    return asked;
  } catch {
    console.error(`[${label}] session ${sessionId}: scorecard request failed (read error)`);
    return null;
  }
}

export type RecoveryBlock =
  | "not_async"
  | "not_submitted"
  | "scoring_disabled"
  | "already_decided"
  | "transcripts_pending"
  | "already_queued";

/**
 * May a recruiter be offered "Score interview" for this session?
 *
 * Pure, so the review page and the action derive the same answer from the
 * same facts, and the tests can enumerate every reason without a database.
 *
 * `hasScoreRow` covers a `scored` row AND a `skipped` or `failed` one. A
 * skipped row is a decision the system already recorded - scoring was off, or
 * nothing was assessable - and a failed row is a run that was attempted. Both
 * already say why in the panel. Offering the button over them and having it
 * silently produce the same row again would read as the button being broken;
 * a deliberate re-score is a different feature with different copy.
 */
export function scorecardRecoveryEligibility(input: {
  kind: string;
  status: string;
  scoringEnabled: boolean;
  hasScoreRow: boolean;
  pendingTranscripts: number;
  liveJob: boolean;
}): { ok: true } | { ok: false; block: RecoveryBlock } {
  if (input.kind !== "async") return { ok: false, block: "not_async" };
  if (input.status !== "submitted") return { ok: false, block: "not_submitted" };
  if (!input.scoringEnabled) return { ok: false, block: "scoring_disabled" };
  if (input.hasScoreRow) return { ok: false, block: "already_decided" };
  if (input.pendingTranscripts > 0) return { ok: false, block: "transcripts_pending" };
  if (input.liveJob) return { ok: false, block: "already_queued" };
  return { ok: true };
}
