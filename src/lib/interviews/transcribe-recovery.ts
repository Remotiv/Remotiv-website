/**
 * Heal answers stuck `pending`: queue what was never queued, and settle what
 * can no longer finish.
 *
 * ── Why (Phase 5, P3) ────────────────────────────────────────
 *
 * The confirm route used to await enqueue() inside try/catch, but enqueue
 * returns { ok: false } rather than throwing, so a queue insert that failed
 * left the answer `pending` forever. A pending transcript blocks the session's
 * scorecard AND the recruiter's recovery button (lib/interviews/scorecard.ts),
 * with nothing that would ever notice. The route now checks the result; this
 * sweep is the net under it.
 *
 * ── Where and how often ──────────────────────────────────────
 *
 * Inline in the worker tick, beside the maintenance scheduler - not a new job
 * type, because that would mean altering background_jobs_type_check, whose
 * DDL is not in this repo. One indexed-able SELECT per tick (about one a
 * minute), and job lookups only for the rows it finds.
 *
 * ── The state machine, per pending answer older than the threshold ──
 *
 * Only jobs for the answer's CURRENT recording generation (recorded_at) are
 * consulted. Jobs for earlier generations are irrelevant whatever their state.
 *
 *   no job for this generation            → enqueue  (the lost-enqueue case)
 *   a job is queued or running            → live: leave it
 *   a job is dead                         → mark `failed`: never re-queued, which
 *                                           would turn a missing API key into a
 *                                           provider call every 10 minutes. The
 *                                           admin replay still works: the handler
 *                                           treats a `failed` row as work to do
 *   a job succeeded, the row still pending → anomaly: one more try, then `failed`
 *
 * ── One more try, and only one ───────────────────────────────
 *
 * An anomaly re-queues under a job id derived from the answer and its recording
 * (transcribeRequeueJobId), so the database's primary key is the limit: a second
 * insert, from a later tick or one running at the same moment, is refused. That
 * job then has its own say: queued or running is live, dead is `failed`, and
 * succeeded with the row still pending is `failed` too, because the id already
 * exists. It needs no migration, and no flag anyone could forget to read.
 *
 * ── Leaving the scan ─────────────────────────────────────────
 *
 * The scan takes the oldest pending rows, so a row that stays pending for ever
 * would hold its place for ever, and enough of them would hide every newer lost
 * upload. Each decision above ends with the row settled or with a job running. A
 * row with a job running holds a place only until that job finishes.
 *
 * ── The last answer to settle asks for the scorecard ─────────
 *
 * Settling the last pending answer asks exactly as the transcribe handler does
 * when a transcript lands (requestScorecard). That includes a session with no
 * transcript at all: the scorer makes no provider call and writes a `skipped`
 * record saying no answer could be scored, with no number, so the recruiter reads
 * why. A replay that writes a transcript asks again and replaces it.
 *
 * Only the sweep whose write changed the row asks, and a settled row is never
 * scanned again, so a later sweep cannot ask twice. Two sweeps settling a session's
 * last answers at the same moment are stopped by migration 027's index.
 */
import { createHash } from "node:crypto";
import { requestScorecard } from "./scorecard";
import {
  requestTranscription,
  TRANSCRIBE_JOB_TYPE,
  type TranscriptionRequest,
} from "./transcribe-request";

/** How long an answer may sit `pending` before it is presumed unqueued. */
export const RECOVERY_AGE_MS = 10 * 60_000;
/** Rows examined per tick. */
export const RECOVERY_BATCH = 20;
/** What a settled answer says. On the safe list the review page will show. */
export const RECOVERY_FAILED_SENTENCE = "Transcription failed for this answer.";

/** Postgres unique_violation: this recording's one re-queue already exists. */
const UNIQUE_VIOLATION = "23505";

/** The one re-queue's id for this recording, the same every time it is asked for. */
export function transcribeRequeueJobId(answerId: string, recordedAt: string): string {
  const h = createHash("sha256")
    .update(`transcribe-requeue:${answerId}:${recordedAt}`)
    .digest("hex");
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type RecoveryDecision = "enqueue" | "live" | "dead" | "anomaly";

/** Pure: what to do given the jobs that exist for the CURRENT generation. */
export function decideRecovery(jobsForGeneration: { status: string }[]): RecoveryDecision {
  if (jobsForGeneration.length === 0) return "enqueue";
  if (jobsForGeneration.some((j) => j.status === "queued" || j.status === "running")) return "live";
  if (jobsForGeneration.some((j) => j.status === "dead" || j.status === "failed")) return "dead";
  return "anomaly";
}

export type RecoverySummary = {
  scanned: number;
  enqueued: number;
  alreadyQueued: number;
  live: number;
  dead: number;
  anomalies: number;
  /** Marked `failed` by this sweep. */
  failed: number;
  /** Given their one more try. */
  requeued: number;
  /** Re-recorded, deleted or settled since the read: nothing changed. */
  skipped: number;
  /** Scorecards queued because this sweep settled a session's last answer. */
  scorecardsRequested: number;
  errors: number;
};

type PendingRow = {
  id: string;
  session_id: string;
  recorded_at: string | null;
  interview_sessions: { company_id: string | null } | { company_id: string | null }[] | null;
};

/** The subset of a Supabase client this needs, so the test can pass a fake. */
export type RecoveryService = {
  from(table: string): {
    select(columns: string): RecoverySelect;
    update(patch: Record<string, unknown>): RecoveryUpdate;
  };
};
type RecoveryUpdate = {
  eq(column: string, value: unknown): RecoveryUpdate;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
type RecoverySelect = {
  eq(column: string, value: unknown): RecoverySelect;
  lt(column: string, value: unknown): RecoverySelect;
  not(column: string, op: string, value: unknown): RecoverySelect;
  order(column: string, opts: { ascending: boolean }): RecoverySelect;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  then?: PromiseLike<{ data: unknown; error: { message: string } | null }>["then"];
};

type RequeueFn = (input: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  companyId: string | null;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string; code?: string }>;

/**
 * This answer just settled: ask for the scorecard if it was the session's last.
 * Non-fatal, as in the transcribe handler: the answer is settled either way, and
 * the recruiter's button can still ask.
 */
async function askForScorecardIfLast(
  service: RecoveryService,
  sessionId: string,
  summary: RecoverySummary,
): Promise<void> {
  const { data, error } = await service
    .from("interview_answers")
    .select("transcript_status")
    .eq("session_id", sessionId)
    .limit(50);
  if (error) {
    summary.errors += 1;
    console.error(
      `[transcribe-recovery] session ${sessionId}: answers not read; scorecard not asked`,
    );
    return;
  }
  const statuses = ((data ?? []) as { transcript_status: string | null }[]).map(
    (a) => a.transcript_status,
  );
  if (statuses.includes("pending")) return;
  try {
    // Cast: see RecoveryService. The real client satisfies what this reads.
    const asked = await requestScorecard(service as never, sessionId);
    if (asked.ok) {
      if (asked.outcome === "queued") summary.scorecardsRequested += 1;
    } else if (asked.reason === "enqueue_failed") {
      summary.errors += 1;
      console.error(`[transcribe-recovery] session ${sessionId}: scorecard not queued`);
    }
  } catch {
    summary.errors += 1;
    console.error(`[transcribe-recovery] session ${sessionId}: scorecard request failed`);
  }
}

/**
 * Settle one answer for this recording. Only a row still pending: one a replay
 * finished since the read keeps its transcript. Throws on a refused write, so the
 * row stays pending and the next tick reads it again.
 */
async function markSettled(
  service: RecoveryService,
  answerId: string,
  sessionId: string,
  recordedAt: string,
  summary: RecoverySummary,
): Promise<void> {
  const { data, error } = await service
    .from("interview_answers")
    .update({ transcript_status: "failed", transcript_error: RECOVERY_FAILED_SENTENCE })
    .eq("id", answerId)
    .eq("recorded_at", recordedAt)
    .eq("transcript_status", "pending")
    .select("id");
  if (error) throw new Error(`transcribe-recovery: answer ${answerId} could not be marked failed`);
  if (((data ?? []) as unknown[]).length === 0) {
    summary.skipped += 1;
    console.log(
      `[transcribe-recovery] answer ${answerId}: nothing changed marking it failed; re-recorded, deleted or already settled`,
    );
    return;
  }
  summary.failed += 1;
  console.warn(`[transcribe-recovery] answer ${answerId}: marked failed`);
  await askForScorecardIfLast(service, sessionId, summary);
}

export async function runTranscribeRecovery(
  service: RecoveryService,
  deps: {
    request?: (input: {
      answerId: string;
      recordedAt: string;
      companyId: string | null;
    }) => Promise<TranscriptionRequest>;
    /** Queues the one more try; default the queue's enqueue, loaded on use. */
    requeue?: RequeueFn;
    now?: () => number;
  } = {},
): Promise<RecoverySummary> {
  const request = deps.request ?? requestTranscription;
  const now = deps.now ?? Date.now;
  const summary: RecoverySummary = {
    scanned: 0,
    enqueued: 0,
    alreadyQueued: 0,
    live: 0,
    dead: 0,
    anomalies: 0,
    failed: 0,
    requeued: 0,
    skipped: 0,
    scorecardsRequested: 0,
    errors: 0,
  };

  const cutoff = new Date(now() - RECOVERY_AGE_MS).toISOString();
  const { data, error } = await service
    .from("interview_answers")
    .select("id, session_id, recorded_at, interview_sessions(company_id)")
    .eq("transcript_status", "pending")
    .not("recorded_at", "is", null)
    .lt("recorded_at", cutoff)
    .order("recorded_at", { ascending: true })
    .limit(RECOVERY_BATCH);
  if (error) {
    console.error("[transcribe-recovery] scan failed");
    summary.errors += 1;
    return summary;
  }

  for (const row of (data ?? []) as PendingRow[]) {
    summary.scanned += 1;
    if (!row.recorded_at) continue;

    const { data: jobs, error: jobsErr } = await service
      .from("background_jobs")
      .select("id, status")
      .eq("type", "transcribe")
      .eq("payload->>answerId", row.id)
      .eq("payload->>recordedAt", row.recorded_at)
      .order("created_at", { ascending: false })
      .limit(10);
    if (jobsErr) {
      console.error(`[transcribe-recovery] job lookup failed for answer ${row.id}`);
      summary.errors += 1;
      continue;
    }

    const found = (jobs ?? []) as { id?: string; status: string }[];
    const decision = decideRecovery(found);
    if (decision === "live") {
      summary.live += 1;
      continue;
    }
    if (decision === "dead") {
      summary.dead += 1;
      await markSettled(service, row.id, row.session_id, row.recorded_at, summary);
      continue;
    }

    const sessions = row.interview_sessions;
    const companyId = (Array.isArray(sessions) ? sessions[0] : sessions)?.company_id ?? null;

    if (decision === "anomaly") {
      summary.anomalies += 1;
      const requeueId = transcribeRequeueJobId(row.id, row.recorded_at);
      if (found.some((j) => j.id === requeueId)) {
        await markSettled(service, row.id, row.session_id, row.recorded_at, summary);
        continue;
      }
      const requeue = deps.requeue ?? (await import("@/lib/jobs-queue")).enqueue;
      const queued = await requeue({
        id: requeueId,
        type: TRANSCRIBE_JOB_TYPE,
        payload: { answerId: row.id, recordedAt: row.recorded_at },
        companyId,
      });
      if (queued.ok) {
        summary.requeued += 1;
        console.warn(
          `[transcribe-recovery] answer ${row.id}: job succeeded but the row is pending; one more try queued`,
        );
      } else if (queued.code === UNIQUE_VIOLATION) {
        summary.alreadyQueued += 1;
      } else {
        summary.errors += 1;
        console.error(`[transcribe-recovery] one more try not queued for answer ${row.id}`);
      }
      continue;
    }

    const result = await request({ answerId: row.id, recordedAt: row.recorded_at, companyId });
    if (!result.ok) {
      summary.errors += 1;
      console.error(`[transcribe-recovery] enqueue failed for answer ${row.id}`);
      continue;
    }
    if (result.outcome === "queued") {
      summary.enqueued += 1;
      console.log(`[transcribe-recovery] answer ${row.id}: transcription re-queued`);
    } else {
      summary.alreadyQueued += 1;
    }
  }
  return summary;
}
