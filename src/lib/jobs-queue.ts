import { randomUUID } from "node:crypto";
import { handleCvPurge } from "@/lib/cv-purge";
import { handleQueueSweep } from "@/lib/queue-sweep";
import { handleWhatsAppMessage } from "@/lib/whatsapp/dispatch";
import { handleAiCvScore } from "@/lib/ai/cv-scoring";
import { handleSendMessage } from "@/lib/email/candidate/dispatch";
import { handleAiScorecard } from "@/lib/ai/interview-scoring";
import { handleInterviewPurge } from "@/lib/interviews/purge";
import { handleTranscribe } from "@/lib/interviews/transcribe";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Background job queue.
 *
 * A plain module, NOT a "use server" file: such a module may only export async
 * functions, and this one exports types, constants and the handler registry.
 * It is imported by the worker route (src/app/api/jobs/worker/route.ts) and,
 * from Step 4 onwards, by whatever enqueues work.
 *
 * Storage is the `background_jobs` table, reached with the service-role client
 * — the table has RLS enabled with NO policies, so it is unreachable by any
 * anon or user-scoped client by design.
 *
 * Schema (verified against the live table):
 *   id uuid pk · company_id uuid null · type text · payload jsonb
 *   status text default 'queued' · attempts int default 0
 *   max_attempts int default 3 · run_after timestamptz default now()
 *   locked_at timestamptz null · locked_by text null · last_error text null
 *   created_at / updated_at timestamptz default now()
 *
 * `type` and `status` each carry a CHECK constraint
 * (background_jobs_type_check / background_jobs_status_check).
 */

/** The status vocabulary, confirmed against background_jobs_status_check. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "dead",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type BackgroundJob = {
  id: string;
  company_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type JobHandler = (job: BackgroundJob) => Promise<void>;

// ── Tuning ───────────────────────────────────────────────────

/**
 * How long a lease may be held before another worker may steal it.
 *
 * Must be comfortably LONGER than the worker's own hard time bound
 * (WORKER_BUDGET_MS in the route, 25s) — otherwise a job that is merely slow
 * would be reclaimed and run twice concurrently. Five minutes leaves a wide
 * margin while still recovering from a crashed or OOM-killed invocation
 * within one or two cron ticks.
 */
export const LEASE_TIMEOUT_MS = 5 * 60_000;

/** First retry delay; each subsequent attempt doubles it. */
const BACKOFF_BASE_MS = 30_000;
/** Ceiling, so attempt 10 doesn't schedule a retry days out. */
const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Exponential backoff with jitter: 30s, 60s, 2m, 4m … capped at 1h.
 *
 * The ±20% jitter matters because a downstream outage typically fails every
 * in-flight job at once; without it they would all retry on the same tick and
 * hammer the recovering dependency in lockstep.
 */
export function backoffMs(attempts: number): number {
  const exp = Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKOFF_MAX_MS,
  );
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.round(exp + jitter);
}

// ── Handler registry ─────────────────────────────────────────

const handlers = new Map<string, JobHandler>();

/**
 * Bind a handler to a job type.
 *
 * Keyed by string rather than a union: the allowed types live in a CHECK
 * constraint on the table, so the authoritative list is in the database, not
 * here. A type with no handler is not silently dropped — runJob throws, which
 * routes it through the normal retry/dead path and surfaces in last_error.
 */
export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export function registeredTypes(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * The complete set of job types accepted by background_jobs_type_check.
 *
 * The CHECK is on a `text` column rather than a Postgres enum, so it is
 * invisible to schema introspection — this list is the authoritative mirror of
 * the constraint and must be kept in step with it by hand. A value here that
 * the constraint rejects fails loudly at the first enqueue (see enqueue's
 * comment); a constraint value missing here simply has no handler and takes
 * the retry-then-dead path.
 */
export const JOB_TYPES = {
  /** Step 4 — AI CV scoring. */
  AI_CV_SCORE: "ai_cv_score",
  /** Step 5 — outbound candidate messaging. */
  SEND_MESSAGE: "send_message",
  /** Step 6 — remind a candidate their interview is due. */
  INTERVIEW_REMINDER: "interview_reminder",
  /** Step 6 — close out an interview whose window has passed. */
  INTERVIEW_EXPIRY: "interview_expiry",
  /** Step 7 — interview transcription. */
  TRANSCRIBE: "transcribe",
  /** Step 8 — AI scorecard from the transcript. */
  AI_SCORECARD: "ai_scorecard",
  /** Step 11 — external calendar synchronisation. */
  CALENDAR_SYNC: "calendar_sync",
  /** Retention — delete interview media past delete_after, and sweep orphans. */
  INTERVIEW_PURGE: "interview_purge",
  /** Retention — delete company applicants' CVs past cv_delete_after. */
  CV_PURGE: "cv_purge",
  /** Retention — delete this table's own long-succeeded rows. */
  QUEUE_SWEEP: "queue_sweep",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/**
 * Step 3 ships the machinery, not the work. Every handler below is a
 * deliberate stub that THROWS.
 *
 * Throwing rather than returning success is the important part: a stub that
 * returned success would mark real jobs 'succeeded' without doing anything,
 * which is the worst failure mode a queue has — the job is then gone, with no
 * record that the work never happened. Throwing routes it through the normal
 * path instead: attempts increments, last_error names exactly what is missing,
 * backoff applies, and after max_attempts the job lands in 'dead' where it can
 * be found and replayed.
 *
 * Implementing one is a single-line change: swap notImplemented for the real
 * handler in the corresponding registerHandler call.
 */
async function notImplemented(job: BackgroundJob): Promise<never> {
  throw new Error(
    `Handler for "${job.type}" is not implemented yet (job ${job.id}).`,
  );
}

// Step 4 — the first real handler. Loads the application and its job
// server-side; the payload carries only an applicationId.
registerHandler(JOB_TYPES.AI_CV_SCORE, handleAiCvScore);
/*
 * ── send_message fans out by channel ──
 *
 * One job type, two channels. The payload carries `channel`, and this is the
 * only place that reads it — the two handlers stay independent, neither
 * knowing the other exists, so an email failure cannot affect a WhatsApp send
 * for the same candidate or vice versa.
 *
 * Absent channel means email: every job enqueued before WhatsApp existed omits
 * the field, and those must keep working unchanged.
 */
registerHandler(JOB_TYPES.SEND_MESSAGE, async (job) => {
  const channel = (job.payload as { channel?: unknown })?.channel;
  if (channel === "whatsapp") {
    await handleWhatsAppMessage(job);
    return;
  }
  await handleSendMessage(job);
});
registerHandler(JOB_TYPES.INTERVIEW_REMINDER, notImplemented); // Step 6
registerHandler(JOB_TYPES.INTERVIEW_EXPIRY, notImplemented); // Step 6
registerHandler(JOB_TYPES.TRANSCRIBE, handleTranscribe);
// Step 8 — interview scoring. The plumbing is real; the PROMPT is a marked
// placeholder and scoring stays off until AI_INTERVIEW_SCORING_ENABLED is set,
// so a run today records an honest 'skipped' rather than a scorecard.
registerHandler(JOB_TYPES.AI_SCORECARD, handleAiScorecard);
registerHandler(JOB_TYPES.CALENDAR_SYNC, notImplemented); // Step 11
registerHandler(JOB_TYPES.INTERVIEW_PURGE, handleInterviewPurge);
registerHandler(JOB_TYPES.CV_PURGE, handleCvPurge);
registerHandler(JOB_TYPES.QUEUE_SWEEP, handleQueueSweep);

// ── Enqueue ──────────────────────────────────────────────────

export type EnqueueInput = {
  type: string;
  payload?: Record<string, unknown>;
  /** Scopes the job to a company. Null for workspace-wide maintenance work. */
  companyId?: string | null;
  /** Delay the first attempt until this instant. Defaults to now. */
  runAfter?: Date;
  /** Overrides the table default of 3. */
  maxAttempts?: number;
};

export type EnqueueResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Insert a queued job.
 *
 * A CHECK violation on `type` is returned verbatim rather than swallowed: an
 * unknown type is a programming error and must fail loudly at the first call
 * with the constraint name in the message, not turn into a job that silently
 * never runs.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const service = createServiceClient();

  const row: Record<string, unknown> = {
    type: input.type,
    payload: input.payload ?? {},
    company_id: input.companyId ?? null,
    status: "queued" satisfies JobStatus,
  };
  if (input.runAfter) row.run_after = input.runAfter.toISOString();
  if (input.maxAttempts !== undefined) row.max_attempts = input.maxAttempts;

  const { data, error } = await service
    .from("background_jobs")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("[jobs-queue] enqueue failed:", error);
    return { ok: false, error: error.message };
  }
  return { ok: true, id: (data as { id: string }).id };
}

// ── Recurring maintenance ────────────────────────────────────

/** How often each retention purge should run. */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The recurring maintenance jobs, and how often each should start.
 *
 * All three are retention sweeps, paced identically, and scheduled
 * INDEPENDENTLY rather than sharing one job. They read different tables,
 * honour different promises, and can fail separately — folding them together
 * would mean a storage outage on interview video stopped CVs expiring too, and
 * one `last_error` would have to describe all three.
 */
const RECURRING: readonly { type: string; intervalMs: number }[] = [
  { type: JOB_TYPES.INTERVIEW_PURGE, intervalMs: PURGE_INTERVAL_MS },
  { type: JOB_TYPES.CV_PURGE, intervalMs: PURGE_INTERVAL_MS },
  // Row retention for this table itself, paced identically and scheduled by
  // the same check — a second mechanism would be a second thing to notice had
  // stopped.
  { type: JOB_TYPES.QUEUE_SWEEP, intervalMs: PURGE_INTERVAL_MS },
];

/**
 * Keep the retention purges scheduled, from the worker tick.
 *
 * There is no scheduler in this product and this does not add one. The worker
 * is already hit every 5 minutes by cron-job.org, so the cheapest thing that
 * ACTUALLY RUNS is to check on each tick whether a purge is due and enqueue
 * one if so.
 *
 * Chosen over a self-enqueueing job — where the handler queues its own
 * successor — for one reason: a self-enqueueing chain has a single point of
 * failure. If that job ever lands in 'dead', or an enqueue fails, the chain
 * stops silently and nothing ever deletes anything again. The failure is
 * invisible and the consequence is retaining personal data we promised to
 * delete. This is self-healing instead: whatever happened to the last job,
 * the next tick re-creates one.
 *
 * Two cheap indexed reads per type per tick, and no work at all if one is
 * already queued or running.
 *
 * Returns the types it enqueued, so the worker's response says which.
 */
export async function ensureMaintenanceScheduled(): Promise<string[]> {
  const service = createServiceClient();
  const scheduled: string[] = [];

  for (const { type, intervalMs } of RECURRING) {
    const { data: live } = await service
      .from("background_jobs")
      .select("id")
      .eq("type", type)
      .in("status", ["queued", "running"])
      .limit(1);
    if ((live ?? []).length > 0) continue;

    // created_at, not a completion timestamp: this paces how often a purge is
    // STARTED, which is the thing being rate-limited. A run that failed still
    // counts, because the next one is a day away and will redo its work anyway.
    const { data: last } = await service
      .from("background_jobs")
      .select("created_at")
      .eq("type", type)
      .order("created_at", { ascending: false })
      .limit(1);

    const lastAt = (last ?? [])[0]
      ? new Date((last as { created_at: string }[])[0].created_at).getTime()
      : 0;
    if (Date.now() - lastAt < intervalMs) continue;

    const result = await enqueue({ type, companyId: null });
    if (result.ok) scheduled.push(type);
  }

  return scheduled;
}

// ── Lease recovery ───────────────────────────────────────────

/**
 * Return jobs whose lease has expired to the queue.
 *
 * Without this a crashed invocation leaks its jobs forever: the row sits in
 * 'running' and no claim predicate will ever match it again.
 *
 * Race-safe for the same reason claimJobs is — it is ONE conditional UPDATE.
 * Two workers reclaiming concurrently both issue it; the second blocks on the
 * row lock, then re-evaluates `status = 'running' AND locked_at < cutoff`
 * against the committed row, which no longer matches. Only one gets the row
 * back in its RETURNING set.
 */
export async function reclaimStaleJobs(): Promise<number> {
  const service = createServiceClient();
  const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();

  const { data, error } = await service
    .from("background_jobs")
    .update({
      status: "queued" satisfies JobStatus,
      locked_by: null,
      locked_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("locked_at", cutoff)
    .select("id");

  if (error) {
    console.error("[jobs-queue] reclaimStaleJobs failed:", error);
    return 0;
  }
  return (data ?? []).length;
}

// ── Claim ────────────────────────────────────────────────────

/**
 * Atomically lease up to `limit` due jobs.
 *
 * Two steps, and only the second one matters for correctness:
 *
 *   1. SELECT candidate ids (status='queued', run_after <= now), oldest first.
 *      Advisory only — by the time the UPDATE runs another worker may have
 *      taken some of them.
 *
 *   2. ONE conditional UPDATE ... RETURNING:
 *
 *        UPDATE background_jobs
 *           SET status='running', locked_by=$token, locked_at=now(), updated_at=now()
 *         WHERE id = ANY($candidates)
 *           AND status = 'queued'          -- the race guard
 *           AND run_after <= now()
 *        RETURNING *;
 *
 * Why that is race-safe without SELECT … FOR UPDATE SKIP LOCKED: under READ
 * COMMITTED, when two workers issue this UPDATE against the same row, the
 * second blocks on the first's row lock; when the first commits, Postgres
 * re-evaluates the second's WHERE clause against the NEW committed version of
 * the row. `status` is now 'running', the predicate fails, and the row is
 * excluded from the second worker's RETURNING set. Each row is therefore
 * handed to exactly one worker, and the unique `locked_by` token makes the
 * winner identifiable in the returned rows.
 *
 * SKIP LOCKED would avoid the brief lock wait, but it needs a SQL function
 * (PostgREST cannot express it) and it buys throughput, not correctness.
 */
export async function claimJobs(limit = 5): Promise<BackgroundJob[]> {
  const service = createServiceClient();
  const nowIso = new Date().toISOString();
  const token = `worker-${randomUUID()}`;

  const { data: candidates, error: selErr } = await service
    .from("background_jobs")
    .select("id")
    .eq("status", "queued")
    .lte("run_after", nowIso)
    .order("run_after", { ascending: true })
    .limit(limit);

  if (selErr) {
    console.error("[jobs-queue] claim candidate select failed:", selErr);
    return [];
  }

  const ids = (candidates ?? []).map((c) => (c as { id: string }).id);
  if (ids.length === 0) return [];

  const { data, error } = await service
    .from("background_jobs")
    .update({
      status: "running" satisfies JobStatus,
      locked_by: token,
      locked_at: nowIso,
      updated_at: nowIso,
    })
    .in("id", ids)
    .eq("status", "queued")
    .lte("run_after", nowIso)
    .select("*");

  if (error) {
    console.error("[jobs-queue] claim update failed:", error);
    return [];
  }
  return (data ?? []) as BackgroundJob[];
}

// ── Completion ───────────────────────────────────────────────

export async function completeJob(jobId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from("background_jobs")
    .update({
      status: "succeeded" satisfies JobStatus,
      locked_by: null,
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) console.error("[jobs-queue] completeJob failed:", error);
}

/**
 * Record a failed attempt: requeue with backoff, or bury the job.
 *
 * `attempts` is taken from the leased row rather than re-read, so two
 * concurrent failures can't both read the same stale count and write the same
 * incremented value. The lease already guarantees a single owner, so this is
 * belt-and-braces.
 */
export async function failJob(
  job: BackgroundJob,
  err: unknown,
): Promise<"queued" | "dead"> {
  const service = createServiceClient();
  const attempts = job.attempts + 1;
  const isDead = attempts >= job.max_attempts;
  const message = err instanceof Error ? err.message : String(err);

  const patch: Record<string, unknown> = {
    attempts,
    // Postgres text has no length cap, but a runaway stack trace in every row
    // makes the table unreadable.
    last_error: message.slice(0, 2000),
    locked_by: null,
    locked_at: null,
    updated_at: new Date().toISOString(),
  };

  if (isDead) {
    patch.status = "dead" satisfies JobStatus;
  } else {
    patch.status = "queued" satisfies JobStatus;
    patch.run_after = new Date(Date.now() + backoffMs(attempts)).toISOString();
  }

  const { error } = await service
    .from("background_jobs")
    .update(patch)
    .eq("id", job.id);

  if (error) console.error("[jobs-queue] failJob failed:", error);
  return isDead ? "dead" : "queued";
}

/** Dispatch one leased job to its handler. Unknown types throw, so they take
 *  the normal retry-then-dead path with a legible last_error. */
export async function runJob(job: BackgroundJob): Promise<void> {
  const handler = getHandler(job.type);
  if (!handler) {
    throw new Error(
      `No handler registered for job type "${job.type}". Registered: ${
        registeredTypes().join(", ") || "(none)"
      }`,
    );
  }
  await handler(job);
}
