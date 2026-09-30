import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { type RecoveryService, runTranscribeRecovery } from "@/lib/interviews/transcribe-recovery";
import {
  claimJobs,
  completeJob,
  ensureMaintenanceScheduled,
  failJob,
  reclaimStaleJobs,
  registeredTypes,
  releaseJob,
  runJob,
  yieldJob,
} from "@/lib/jobs-queue";
import { notifyAllAdmins } from "@/lib/notifications";
import { canStart, DEADLINE_MARGIN_MS, FUNCTION_MAX_DURATION_MS } from "@/lib/queue/budgets";
import { type DeadJobEntry, staleGapNotice, summariseDeadJobs } from "@/lib/queue/alerts";
import { JobYield, TerminalJobError } from "@/lib/queue/failure-class";
import { createJobContext } from "@/lib/queue/job-context";
import { WORKER_TICK_STALE_MS } from "@/lib/queue-health-types";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Background job worker.
 *
 * Invoked on a schedule by an EXTERNAL scheduler — never by a browser.
 * vercel.json carries this route's maxDuration but no `crons` block, so the
 * tick interval is configured outside this repo and cannot be read from it;
 * measured from the live job timestamps in September 2026 it is about one
 * minute. Drains a batch of due jobs, runs the handlers concurrently, records
 * each outcome, and returns a summary.
 *
 * Node runtime, not edge: handlers will do Node-only work (Buffer, crypto,
 * the Supabase service client) from Step 4 onwards.
 */
export const runtime = "nodejs";
/** Never cached — every invocation must re-read the queue. */
export const dynamic = "force-dynamic";

/**
 * How many claimed jobs run AT ONCE.
 *
 * ── Why this is the change that mattered ─────────────────────
 *
 * The batch used to run in a serial `for` loop. Job handlers here are almost
 * entirely I/O — an HTTP call to Anthropic and some Supabase writes — so the
 * CPU sat idle for the whole of each job's ~25-30s while the next four waited
 * their turn. A real run claimed 5, finished 1, and gave up on the other 4.
 * Run concurrently, five I/O-bound jobs cost roughly the wall time of one.
 *
 * ── Why 4 and not 10 ─────────────────────────────────────────
 *
 * The ceiling here is Anthropic's rate limits, not this process. A CV scoring
 * request carries the whole CV plus the job description plus the rubric, so it
 * is large in INPUT TOKENS, and the tokens-per-minute limit binds well before
 * the requests-per-minute one. The SDK retries a 429 with backoff, but a retry
 * spends wall clock the invocation does not have, so tripping the limit costs
 * more than the extra parallelism buys.
 *
 * Four is a 4x throughput gain — most of the available win — while leaving
 * headroom. Raise it only alongside a known account tier.
 */
const WORKER_CONCURRENCY = 4;

/**
 * Jobs leased per invocation.
 *
 * Deliberately larger than WORKER_CONCURRENCY so a batch of FAST jobs (a
 * send_message is ~1s) drains in several waves within one tick rather than
 * stopping at four. Slow jobs simply never reach the second wave and are
 * released untouched, which costs nothing now that the not-started path is a
 * release rather than a failure — see releaseJob in jobs-queue.ts.
 */
const BATCH_SIZE = 10;

/**
 * The invocation's deadline, and how it is enforced (Phase 5, P2).
 *
 * The route is configured for maxDuration 60 in vercel.json. Everything the
 * worker does is measured against `startedAt + FUNCTION_MAX_DURATION_MS -
 * DEADLINE_MARGIN_MS` (55s), which every handler receives as a JobContext:
 *
 *   - a job STARTS only if the budget left is at least what its type needs
 *     for one provider call (canStart, lib/queue/budgets.ts) - otherwise it is
 *     released untouched for the next tick;
 *   - inside a handler every provider call takes the context's AbortSignal
 *     and a timeout inside the remaining budget, with SDK retries off;
 *   - a handler with several calls checks the budget before each and YIELDS
 *     (JobYield) when the next would not fit; the job goes back on the queue
 *     with attempts untouched and resumes where it stopped.
 *
 * So no provider call is ever started that the platform will kill, and the
 * old flat 30s gate plus "about 30s for the slowest job" arithmetic - which
 * had zero margin and no way to stop a call already in flight - is gone. The
 * per-type numbers are operational defaults, not measurements; see budgets.ts
 * for how they are tuned.
 */
const deadlineFor = (startedAt: number) =>
  startedAt + FUNCTION_MAX_DURATION_MS - DEADLINE_MARGIN_MS;

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed to a fixed length first: timingSafeEqual throws on
 * length mismatch, and that throw would itself leak the secret's length.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the reject path costs roughly the same.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Gate the worker.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * the CRON_SECRET environment variable is set on the project, so the same
 * check covers both the scheduler and a manual curl during an incident.
 *
 * Fails CLOSED: if CRON_SECRET is unset the route refuses every request rather
 * than falling open. An unauthenticated worker is a free way to make the
 * server do arbitrary queued work.
 */
function authorize(request: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[worker] CRON_SECRET is not set — refusing to run.");
    return NextResponse.json({ error: "Worker is not configured." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token || !secretMatches(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function drain() {
  const startedAt = Date.now();
  const deadlineAt = deadlineFor(startedAt);
  const summary = {
    purgesScheduled: [] as string[],
    /** Answers whose transcription was never queued and has now been re-queued. */
    transcribeRecovery: null as null | Record<string, number>,
    reclaimed: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    /** Claimed but never started — no attempt charged. Not a failure. */
    released: 0,
    /** Stopped for budget after real progress — no attempt charged. Resumes next tick. */
    yielded: 0,
    dead: 0,
    /**
     * Every job that died THIS tick, with its safe failure class. Folded into
     * one job_dead notification after the pool drains (lib/queue/alerts.ts) -
     * one per tick, never one per job. Not returned to the caller.
     */
    deadJobs: [] as DeadJobEntry[],
    timedOut: false,
  };

  /*
   * Recovery for answers stuck `pending` with no transcribe job for their
   * current recording (lib/interviews/transcribe-recovery.ts). One small read
   * per tick; non-fatal for the same reason as the scheduler below.
   */
  try {
    // Cast: the recovery module types the client structurally so a test can
    // pass a fake; the real client satisfies it but TypeScript's check of the
    // full PostgREST builder against it does not terminate in useful time.
    summary.transcribeRecovery = await runTranscribeRecovery(
      createServiceClient() as unknown as RecoveryService,
    );
  } catch (err) {
    console.error("[worker] transcribe recovery failed (non-fatal):", err);
  }

  /*
   * Recurring maintenance has no scheduler; this tick IS the scheduler. Runs
   * before claiming so a purge enqueued here is eligible on this very tick.
   * Non-fatal: a failure to schedule must not stop the queue draining.
   */
  try {
    summary.purgesScheduled = await ensureMaintenanceScheduled();
  } catch (err) {
    console.error("[worker] purge scheduling failed (non-fatal):", err);
  }

  // Recover leases orphaned by a crashed invocation before claiming, so those
  // jobs are eligible again on this very tick.
  summary.reclaimed = await reclaimStaleJobs();

  const jobs = await claimJobs(BATCH_SIZE);
  summary.claimed = jobs.length;

  /*
   * A bounded worker pool over the claimed batch.
   *
   * `cursor` is shared across the pool without a lock, which is safe because
   * JavaScript is single-threaded: `cursor++` cannot interleave, so no two
   * pool slots can ever draw the same index. Each slot then owns its job
   * outright and only ever writes that job's own row.
   *
   * Deliberately NOT Promise.all over the whole batch — that would start all
   * ten at once and put the concurrency limit back in the hands of whatever
   * the batch size happens to be.
   */
  let cursor = 0;

  const slot = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (!job) return;

      if (!canStart(job.type, deadlineAt - Date.now())) {
        /*
         * Not enough budget left for this type's first provider call. This
         * job has NOT been started, so it must not be charged an attempt or
         * pushed into backoff — release it and let the next tick have it
         * immediately. Calling failJob here was the bug that turned a busy
         * queue into a dying one: four "Worker budget exhausted before start"
         * failures per tick burned four attempts and delayed all four, so a
         * job could reach 'dead' having never executed once.
         */
        summary.timedOut = true;
        await releaseJob(job);
        summary.released += 1;
        continue;
      }

      try {
        await runJob(job, createJobContext(deadlineAt));
        await completeJob(job.id);
        summary.succeeded += 1;
      } catch (err) {
        if (err instanceof JobYield) {
          // Stopped itself before a call that would not fit. Progress is
          // persisted; the next tick resumes it. Not a failure.
          await yieldJob(job, err);
          summary.yielded += 1;
          console.log(`[worker] job ${job.id} (${job.type}) yielded: ${err.message}`);
          continue;
        }
        // One bad job must never abort the batch — or, now, its pool slot.
        const outcome = await failJob(job, err);
        if (outcome === "dead") {
          summary.dead += 1;
          // The CLASS travels to the notification; the message does not. A
          // TerminalJobError names its class; the out-of-attempts path is
          // "retryable" - transient failures that never stopped being transient.
          summary.deadJobs.push({
            type: job.type,
            failureClass: err instanceof TerminalJobError ? err.failureClass : "retryable",
          });
        } else {
          summary.failed += 1;
        }
        console.error(`[worker] job ${job.id} (${job.type}) failed:`, err);
      }
    }
  };

  /*
   * Every slot resolves rather than rejects — the try/catch above is inside
   * the loop — so Promise.all here cannot reject and cannot abandon a
   * half-finished pool. If it ever could, the remaining leases would strand
   * until the stale-lease reclaim after LEASE_TIMEOUT_MS - and, since Phase 5,
   * each of those would be charged an attempt.
   */
  await Promise.all(Array.from({ length: Math.min(WORKER_CONCURRENCY, jobs.length) }, slot));

  // After the pool has drained, so the heartbeat records what THIS tick did
  // and a tick that died mid-batch leaves no heartbeat - which is the truth.
  await recordHeartbeatAndAlerts(summary, startedAt);

  const { deadJobs: _internalOnly, ...publicSummary } = summary;
  return { ...publicSummary, concurrency: WORKER_CONCURRENCY, durationMs: Date.now() - startedAt };
}

type TickSummary = {
  claimed: number;
  succeeded: number;
  failed: number;
  yielded: number;
  dead: number;
  deadJobs: DeadJobEntry[];
};

/**
 * The worker's own liveness record, and the two alerts it can raise.
 *
 * ── Heartbeat ────────────────────────────────────────────────
 *
 * One row in worker_heartbeats (migration 035), upserted at the end of EVERY
 * tick including an empty one. Before this, a tick with nothing to do wrote
 * nothing, so an idle worker and a stopped one were indistinguishable from the
 * database. The admin panel's liveness tile and GET /api/health/worker both
 * read this row and nothing else.
 *
 * ── worker_stale, retrospectively ────────────────────────────
 *
 * A dead worker cannot raise its own alarm; the live alert comes from an
 * external monitor polling the health route. What this tick CAN know is that
 * the previous heartbeat is older than the staleness threshold, which means
 * an outage just ended. It records that once per gap: `stale_noticed_at` is
 * set to the previous tick's timestamp, so a second tick after the same gap
 * finds it already noticed and stays quiet.
 *
 * ── job_dead, aggregated ─────────────────────────────────────
 *
 * One notification per tick that killed any job, built from counts and safe
 * failure classes only (lib/queue/alerts.ts). last_error never leaves the
 * background_jobs row.
 *
 * ── Non-fatal, every step ────────────────────────────────────
 *
 * Nothing here may fail the tick. The jobs are already finished; a heartbeat
 * that cannot be written (035 not yet applied) or a notification that cannot
 * be inserted is logged and the tick still returns its summary. notifyAllAdmins
 * never throws by contract; the reads and the upsert are wrapped anyway.
 */
async function recordHeartbeatAndAlerts(summary: TickSummary, startedAt: number): Promise<void> {
  const service = createServiceClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let previousTickAt: string | null = null;
  let staleNoticedAt: string | null = null;
  try {
    const { data, error } = await service
      .from("worker_heartbeats")
      .select("last_tick_at, stale_noticed_at")
      .eq("id", "worker")
      .maybeSingle();
    if (error) {
      console.error("[worker] heartbeat read failed (non-fatal):", error.message);
    } else if (data) {
      const row = data as { last_tick_at: string | null; stale_noticed_at: string | null };
      previousTickAt = row.last_tick_at;
      staleNoticedAt = row.stale_noticed_at;
    }
  } catch (err) {
    console.error("[worker] heartbeat read threw (non-fatal):", err);
  }

  // Was the worker down until just now? Notice it once per gap.
  const stale = staleGapNotice(previousTickAt, now, WORKER_TICK_STALE_MS);
  const alreadyNoticed = stale !== null && staleNoticedAt !== null && staleNoticedAt === previousTickAt;
  if (stale && !alreadyNoticed) {
    await notifyAllAdmins({
      event_type: "worker_stale",
      title: stale.title,
      message: stale.message,
      link: stale.link,
      metadata: stale.metadata,
    });
  }

  try {
    const { error } = await service.from("worker_heartbeats").upsert(
      {
        id: "worker",
        last_tick_at: nowIso,
        claimed: summary.claimed,
        succeeded: summary.succeeded,
        failed: summary.failed,
        dead: summary.dead,
        yielded: summary.yielded,
        duration_ms: now - startedAt,
        // Carry the marker forward when a gap was noticed on this or an
        // earlier tick, so it is not re-announced; clear it once the previous
        // tick was recent, so the NEXT gap will be noticed afresh.
        stale_noticed_at: stale ? previousTickAt : null,
        updated_at: nowIso,
      },
      { onConflict: "id" },
    );
    if (error) console.error("[worker] heartbeat write failed (non-fatal):", error.message);
  } catch (err) {
    console.error("[worker] heartbeat write threw (non-fatal):", err);
  }

  const dead = summariseDeadJobs(summary.deadJobs);
  if (dead) {
    await notifyAllAdmins({
      event_type: "job_dead",
      title: dead.title,
      message: dead.message,
      link: dead.link,
      metadata: dead.metadata,
    });
  }
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    return NextResponse.json({ ok: true, ...(await drain()) });
  } catch (err) {
    // A failure here is the queue itself being unreachable, not a job.
    console.error("[worker] drain failed:", err);
    return NextResponse.json({ ok: false, error: "Worker run failed" }, { status: 500 });
  }
}

/**
 * Vercel Cron issues GET. Same gate, same work — the handler is idempotent at
 * the batch level because claiming is atomic, so a duplicate tick simply
 * finds nothing to claim.
 */
export async function GET(request: Request) {
  return POST(request);
}

/** Unauthenticated probe of what the worker can run. No queue access. */
export async function OPTIONS(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, registeredTypes: registeredTypes() });
}
