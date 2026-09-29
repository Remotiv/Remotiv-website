/**
 * Find answers whose transcription was never queued, and queue it.
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
 *   the newest job is dead                → leave it: a classified failure the
 *                                           admin replay owns; re-enqueuing
 *                                           here would turn a missing API key
 *                                           into a provider call every 10 min
 *   a job succeeded but the row is pending → anomaly: log loudly, do nothing;
 *                                           every success path writes done or
 *                                           failed, so this is a bug to find,
 *                                           not a loop to run
 */
import { requestTranscription, type TranscriptionRequest } from "./transcribe-request";

/** How long an answer may sit `pending` before it is presumed unqueued. */
export const RECOVERY_AGE_MS = 10 * 60_000;
/** Rows examined per tick. */
export const RECOVERY_BATCH = 20;

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
  errors: number;
};

type PendingRow = {
  id: string;
  recorded_at: string | null;
  interview_sessions: { company_id: string | null } | { company_id: string | null }[] | null;
};

/** The subset of a Supabase client this needs, so the test can pass a fake. */
export type RecoveryService = {
  from(table: string): {
    select(columns: string): RecoverySelect;
  };
};
type RecoverySelect = {
  eq(column: string, value: unknown): RecoverySelect;
  lt(column: string, value: unknown): RecoverySelect;
  not(column: string, op: string, value: unknown): RecoverySelect;
  order(column: string, opts: { ascending: boolean }): RecoverySelect;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  then?: PromiseLike<{ data: unknown; error: { message: string } | null }>["then"];
};

export async function runTranscribeRecovery(
  service: RecoveryService,
  deps: {
    request?: (input: {
      answerId: string;
      recordedAt: string;
      companyId: string | null;
    }) => Promise<TranscriptionRequest>;
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
    errors: 0,
  };

  const cutoff = new Date(now() - RECOVERY_AGE_MS).toISOString();
  const { data, error } = await service
    .from("interview_answers")
    .select("id, recorded_at, interview_sessions(company_id)")
    .eq("transcript_status", "pending")
    .not("recorded_at", "is", null)
    .lt("recorded_at", cutoff)
    .order("recorded_at", { ascending: true })
    .limit(RECOVERY_BATCH);
  if (error) {
    console.error("[transcribe-recovery] scan failed:", error.message);
    summary.errors += 1;
    return summary;
  }

  for (const row of (data ?? []) as PendingRow[]) {
    summary.scanned += 1;
    if (!row.recorded_at) continue;

    const { data: jobs, error: jobsErr } = await service
      .from("background_jobs")
      .select("status")
      .eq("type", "transcribe")
      .eq("payload->>answerId", row.id)
      .eq("payload->>recordedAt", row.recorded_at)
      .order("created_at", { ascending: false })
      .limit(10);
    if (jobsErr) {
      console.error(
        `[transcribe-recovery] job lookup failed for answer ${row.id}:`,
        jobsErr.message,
      );
      summary.errors += 1;
      continue;
    }

    const decision = decideRecovery((jobs ?? []) as { status: string }[]);
    if (decision === "live") {
      summary.live += 1;
      continue;
    }
    if (decision === "dead") {
      summary.dead += 1;
      console.log(
        `[transcribe-recovery] answer ${row.id}: dead job for current recording; awaiting admin replay`,
      );
      continue;
    }
    if (decision === "anomaly") {
      summary.anomalies += 1;
      console.error(
        `[transcribe-recovery] answer ${row.id}: transcribe job succeeded but transcript_status is still pending - investigate`,
      );
      continue;
    }

    const sessions = row.interview_sessions;
    const companyId = (Array.isArray(sessions) ? sessions[0] : sessions)?.company_id ?? null;
    const result = await request({ answerId: row.id, recordedAt: row.recorded_at, companyId });
    if (!result.ok) {
      summary.errors += 1;
      console.error(`[transcribe-recovery] enqueue failed for answer ${row.id}: ${result.error}`);
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
