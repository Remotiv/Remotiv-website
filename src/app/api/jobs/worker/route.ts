import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimJobs,
  completeJob,
  ensureInterviewPurgeScheduled,
  failJob,
  reclaimStaleJobs,
  registeredTypes,
  runJob,
} from "@/lib/jobs-queue";

/**
 * Background job worker.
 *
 * Invoked on a schedule (see vercel.json) — never by a browser. Drains a small
 * batch of due jobs, runs each handler, records the outcome, and returns a
 * summary.
 *
 * Node runtime, not edge: handlers will do Node-only work (Buffer, crypto,
 * the Supabase service client) from Step 4 onwards.
 */
export const runtime = "nodejs";
/** Never cached — every invocation must re-read the queue. */
export const dynamic = "force-dynamic";

/** Jobs leased per invocation. Small on purpose: the cron tick is frequent,
 *  and a smaller batch means a crash strands fewer leases. */
const BATCH_SIZE = 5;

/**
 * Hard wall-clock bound on starting new work.
 *
 * The route is configured for maxDuration 60 in vercel.json. Stopping at 25s
 * leaves room for the job in flight to finish and for its completion write to
 * land, so the platform never kills the invocation mid-write and strands a
 * lease. Anything left over is simply picked up on the next tick.
 *
 * Must stay well under LEASE_TIMEOUT_MS (5 min) — see jobs-queue.ts.
 */
const WORKER_BUDGET_MS = 25_000;

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
    return NextResponse.json(
      { error: "Worker is not configured." },
      { status: 503 },
    );
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
  const summary = {
    purgeScheduled: false,
    reclaimed: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    timedOut: false,
  };

  /*
   * Recurring maintenance has no scheduler; this tick IS the scheduler. Runs
   * before claiming so a purge enqueued here is eligible on this very tick.
   * Non-fatal: a failure to schedule must not stop the queue draining.
   */
  try {
    summary.purgeScheduled = await ensureInterviewPurgeScheduled();
  } catch (err) {
    console.error("[worker] purge scheduling failed (non-fatal):", err);
  }

  // Recover leases orphaned by a crashed invocation before claiming, so those
  // jobs are eligible again on this very tick.
  summary.reclaimed = await reclaimStaleJobs();

  const jobs = await claimJobs(BATCH_SIZE);
  summary.claimed = jobs.length;

  for (const job of jobs) {
    if (Date.now() - startedAt > WORKER_BUDGET_MS) {
      // Out of budget. Release the remaining leases immediately instead of
      // leaving them to time out five minutes from now.
      summary.timedOut = true;
      await failJob(job, new Error("Worker budget exhausted before start"));
      summary.failed += 1;
      continue;
    }

    try {
      await runJob(job);
      await completeJob(job.id);
      summary.succeeded += 1;
    } catch (err) {
      // One bad job must never abort the batch.
      const outcome = await failJob(job, err);
      if (outcome === "dead") summary.dead += 1;
      else summary.failed += 1;
      console.error(`[worker] job ${job.id} (${job.type}) failed:`, err);
    }
  }

  return { ...summary, durationMs: Date.now() - startedAt };
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    return NextResponse.json({ ok: true, ...(await drain()) });
  } catch (err) {
    // A failure here is the queue itself being unreachable, not a job.
    console.error("[worker] drain failed:", err);
    return NextResponse.json(
      { ok: false, error: "Worker run failed" },
      { status: 500 },
    );
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
