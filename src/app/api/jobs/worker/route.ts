import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  claimJobs,
  completeJob,
  ensureMaintenanceScheduled,
  failJob,
  reclaimStaleJobs,
  registeredTypes,
  releaseJob,
  runJob,
} from "@/lib/jobs-queue";

/**
 * Background job worker.
 *
 * Invoked on a schedule by an EXTERNAL scheduler (cron-job.org) — never by a
 * browser. vercel.json carries this route's maxDuration but no `crons` block,
 * so the tick interval is configured outside this repo and cannot be read from
 * it. Drains a batch of due jobs, runs the handlers concurrently, records each
 * outcome, and returns a summary.
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
 * Hard wall-clock bound on STARTING new work. It does not interrupt a job
 * already running.
 *
 * The route is configured for maxDuration 60 in vercel.json, and the number
 * that matters is the gap between the two: a job may start at the instant the
 * budget expires, so `budget + longest single job` must stay inside
 * maxDuration or the platform kills the invocation mid-flight and the paid-for
 * Anthropic call is thrown away.
 *
 *   30s budget + ~30s for the slowest observed ai_cv_score = 60s
 *
 * That is why this is 30s and not 50s. Raising it further is only safe with a
 * higher maxDuration, which depends on the Vercel plan — the 60 configured
 * here is the Hobby ceiling.
 *
 * Under concurrency this rarely binds at all: every job in a wave starts at
 * roughly t=0, so the gate now exists to stop a LATE wave rather than to stop
 * job number two.
 */
const WORKER_BUDGET_MS = 30_000;

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
  const summary = {
    purgesScheduled: [] as string[],
    reclaimed: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    /** Claimed but never started — no attempt charged. Not a failure. */
    released: 0,
    dead: 0,
    timedOut: false,
  };

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

      if (Date.now() - startedAt > WORKER_BUDGET_MS) {
        /*
         * Out of budget. This job has NOT been started, so it must not be
         * charged an attempt or pushed into backoff — release it and let the
         * next tick have it immediately. Calling failJob here was the bug that
         * turned a busy queue into a dying one: four "Worker budget exhausted
         * before start" failures per tick burned four attempts and delayed all
         * four, so a job could reach 'dead' having never executed once.
         */
        summary.timedOut = true;
        await releaseJob(job);
        summary.released += 1;
        continue;
      }

      try {
        await runJob(job);
        await completeJob(job.id);
        summary.succeeded += 1;
      } catch (err) {
        // One bad job must never abort the batch — or, now, its pool slot.
        const outcome = await failJob(job, err);
        if (outcome === "dead") summary.dead += 1;
        else summary.failed += 1;
        console.error(`[worker] job ${job.id} (${job.type}) failed:`, err);
      }
    }
  };

  /*
   * Every slot resolves rather than rejects — the try/catch above is inside
   * the loop — so Promise.all here cannot reject and cannot abandon a
   * half-finished pool. If it ever could, the remaining leases would strand
   * until the stale-lease reclaim five minutes later.
   */
  await Promise.all(Array.from({ length: Math.min(WORKER_CONCURRENCY, jobs.length) }, slot));

  return { ...summary, concurrency: WORKER_CONCURRENCY, durationMs: Date.now() - startedAt };
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
