/**
 * What the worker hands a handler alongside the job: the invocation's
 * deadline, as a number and as an AbortSignal.
 *
 * Before Phase 5 a handler had no idea when the platform would kill it, so a
 * provider call could outlive the function, leave the row `running`, and be
 * reclaimed and re-run in full. Every worker-side provider call now takes
 * `ctx.signal` and a timeout derived from `ctx.remainingMs()`, and asks
 * `assertProviderBudget` before opening the call at all.
 *
 * Optional on the handler signature so the scorers can still be called from
 * a script or a test without a worker around: with no context they behave as
 * before (SDK defaults, no yield).
 */
import { JobYield } from "./failure-class";

export type JobContext = {
  /** Epoch ms after which the platform may kill the invocation. */
  deadlineAt: number;
  /** Aborts at the deadline. Pass to every fetch and SDK call. */
  signal: AbortSignal;
  /** Milliseconds left before the deadline; never negative. */
  remainingMs(): number;
};

export function createJobContext(deadlineAt: number, now: () => number = Date.now): JobContext {
  const remaining = Math.max(0, deadlineAt - now());
  return {
    deadlineAt,
    signal: AbortSignal.timeout(remaining),
    remainingMs: () => Math.max(0, deadlineAt - now()),
  };
}

/**
 * Refuse to open a provider call that cannot fit. Throws JobYield, which the
 * worker turns into "back on the queue, attempts untouched, run now".
 * No-op without a context.
 */
export function assertProviderBudget(
  ctx: JobContext | undefined,
  minMs: number,
  label: string,
): void {
  if (!ctx) return;
  const left = ctx.remainingMs();
  if (left < minMs) {
    throw new JobYield(
      `${label}: ${Math.round(left / 1000)}s left, needs ${Math.round(minMs / 1000)}s`,
    );
  }
}

/**
 * Per-request options for the Anthropic SDK inside a worker: our signal, a
 * timeout inside the budget, and NO SDK retries - the queue is the single
 * retry controller (P13). Empty outside the worker so scripts keep defaults.
 */
export function providerRequestOptions(
  ctx: JobContext | undefined,
  timeoutMs: (remaining: number) => number,
): { signal?: AbortSignal; timeout?: number; maxRetries?: number } {
  if (!ctx) return {};
  return { signal: ctx.signal, timeout: timeoutMs(ctx.remainingMs()), maxRetries: 0 };
}
