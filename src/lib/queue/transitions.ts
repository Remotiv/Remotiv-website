/**
 * The row patches the queue writes on failure, reclaim, and yield - as pure
 * planners, so the rules can be tested without a database and jobs-queue.ts
 * only has to apply them.
 *
 * Phase 5, P2: a reclaim now counts as an attempt (a job killed by the
 * platform was tried), a terminal failure goes straight to dead (P13), and a
 * yield is a release with a note (no attempt: the job stopped itself before
 * spending anything it could not finish).
 */
import { TerminalJobError } from "./failure-class";

/** First retry delay; each subsequent attempt doubles it. */
export const BACKOFF_BASE_MS = 30_000;
/** Ceiling, so attempt 10 doesn't schedule a retry days out. */
export const BACKOFF_MAX_MS = 60 * 60_000;

/**
 * Exponential backoff with jitter: 30s, 60s, 2m, 4m … capped at 1h.
 *
 * The ±20% jitter matters because a downstream outage typically fails every
 * in-flight job at once; without it they would all retry on the same tick and
 * hammer the recovering dependency in lockstep.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  const jitter = exp * 0.2 * (random() * 2 - 1);
  return Math.round(exp + jitter);
}

export type FailurePlan = {
  attempts: number;
  status: "queued" | "dead";
  last_error: string;
  /** Present only when requeued. */
  run_after?: string;
  locked_by: null;
  locked_at: null;
  updated_at: string;
};

const LAST_ERROR_MAX = 2000;

/**
 * A handler threw. Terminal errors are buried at once with their class in
 * last_error; everything else climbs the attempt ladder.
 */
export function planFailure(
  job: { attempts: number; max_attempts: number },
  err: unknown,
  now: number,
  random: () => number = Math.random,
): FailurePlan {
  const attempts = job.attempts + 1;
  const updated_at = new Date(now).toISOString();
  if (err instanceof TerminalJobError) {
    return {
      attempts,
      status: "dead",
      last_error: `terminal(${err.failureClass}): ${err.message}`.slice(0, LAST_ERROR_MAX),
      locked_by: null,
      locked_at: null,
      updated_at,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (attempts >= job.max_attempts) {
    return {
      attempts,
      status: "dead",
      last_error: message.slice(0, LAST_ERROR_MAX),
      locked_by: null,
      locked_at: null,
      updated_at,
    };
  }
  return {
    attempts,
    status: "queued",
    last_error: message.slice(0, LAST_ERROR_MAX),
    run_after: new Date(now + backoffMs(attempts, random)).toISOString(),
    locked_by: null,
    locked_at: null,
    updated_at,
  };
}

export type ReclaimPlan = {
  attempts: number;
  status: "queued" | "dead";
  last_error: string;
  run_after: string;
  locked_by: null;
  locked_at: null;
  updated_at: string;
};

/**
 * A `running` row whose lease expired. The invocation that held it is gone -
 * killed at maxDuration, crashed, or out of memory - so the job WAS tried and
 * the attempt counts. Requeued immediately (no backoff: nothing downstream
 * failed) unless that was its last attempt, in which case it is dead with a
 * note saying it was reclaimed, so the dead-letter panel shows a job that kept
 * outliving the worker rather than one that kept failing.
 */
export function planReclaim(
  row: {
    attempts: number;
    max_attempts: number;
    locked_at: string | null;
    locked_by: string | null;
    type: string;
  },
  now: number,
): ReclaimPlan {
  const attempts = row.attempts + 1;
  const heldFor = row.locked_at
    ? Math.round((now - new Date(row.locked_at).getTime()) / 1000)
    : null;
  const note = `reclaimed: lease expired after ${heldFor ?? "?"}s (locked_by ${row.locked_by ?? "?"}, locked_at ${
    row.locked_at ?? "?"
  }); attempt ${attempts} of ${row.max_attempts}`;
  const iso = new Date(now).toISOString();
  return {
    attempts,
    status: attempts >= row.max_attempts ? "dead" : "queued",
    last_error: note.slice(0, LAST_ERROR_MAX),
    run_after: iso,
    locked_by: null,
    locked_at: null,
    updated_at: iso,
  };
}

export type YieldPlan = {
  status: "queued";
  last_error: string;
  run_after: string;
  locked_by: null;
  locked_at: null;
  updated_at: string;
};

/** The handler stopped for budget after real progress. Back on the queue now, attempts untouched. */
export function planYield(note: string, now: number): YieldPlan {
  const iso = new Date(now).toISOString();
  return {
    status: "queued",
    last_error: `yielded: ${note}`.slice(0, LAST_ERROR_MAX),
    run_after: iso,
    locked_by: null,
    locked_at: null,
    updated_at: iso,
  };
}
