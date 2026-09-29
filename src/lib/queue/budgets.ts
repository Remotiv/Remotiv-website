/**
 * Time budgets for worker jobs and the provider calls inside them.
 *
 * ── OPERATIONAL DEFAULTS, NOT MEASUREMENTS ───────────────────
 *
 * Every number here was chosen conservatively from one comment in the worker
 * route ("~30s for the slowest observed ai_cv_score") and nothing else. None
 * is a measured SLA. Each provider call in a worker handler writes one
 * `[provider-call]` line (see logProviderCall) with its duration and the
 * budget it had; after a few days of those, tune these from evidence. They
 * live in one file so that tuning is a one-line change.
 *
 * The arithmetic they serve (Phase 5, P2): the function dies at
 * FUNCTION_MAX_DURATION_MS. A job may only START if its first paid call can
 * finish before the deadline, and a handler may only make a further call if
 * MIN_PROVIDER_CALL_BUDGET_MS remains; otherwise it yields (lib/queue/
 * failure-class.ts JobYield) and the next tick resumes it. Together those two
 * rules mean no provider call is ever started that the platform will kill.
 */

/**
 * Mirrors vercel.json → functions["src/app/api/jobs/worker/route.ts"].maxDuration.
 * If that number changes, this one must change with it.
 */
export const FUNCTION_MAX_DURATION_MS = 60_000;

/** Reserved at the end of the invocation for the final row writes and the response. */
export const DEADLINE_MARGIN_MS = 5_000;

/** A single provider call is never allowed longer than this, whatever the budget. */
export const PROVIDER_CALL_TIMEOUT_CAP_MS = 45_000;

/** Below this much remaining budget a handler must not open another provider call. */
export const MIN_PROVIDER_CALL_BUDGET_MS = 20_000;

/**
 * How much budget a job of each type needs before the worker will START it.
 * At least its first provider call, with headroom for the reads before it.
 * Types not listed make no provider call and need only the default.
 */
export const MIN_START_BUDGET_MS: Readonly<Record<string, number>> = {
  ai_cv_score: 35_000,
  transcribe: 35_000,
  ai_scorecard: 20_000,
};
export const DEFAULT_MIN_START_BUDGET_MS = 5_000;

export function minStartBudgetMs(type: string): number {
  return MIN_START_BUDGET_MS[type] ?? DEFAULT_MIN_START_BUDGET_MS;
}

/** May a job of this type start with this much budget left? */
export function canStart(type: string, remainingMs: number): boolean {
  return remainingMs >= minStartBudgetMs(type);
}

/**
 * The timeout to hand a provider SDK for one call: the remaining budget less a
 * second for the write that follows, capped, never below one second so a
 * misconfigured deadline fails fast rather than never.
 */
export function providerTimeoutMs(remainingMs: number): number {
  return Math.max(1_000, Math.min(remainingMs - 1_000, PROVIDER_CALL_TIMEOUT_CAP_MS));
}

export type ProviderCallLog = {
  jobType: string;
  provider: "anthropic" | "openai-whisper";
  model?: string;
  durationMs: number;
  /** Budget the call had when it started; null outside the worker. */
  remainingAtStartMs: number | null;
  outcome: "ok" | "error" | "aborted";
  /** Set on error: the failure class from lib/queue/failure-class.ts. */
  failureClass?: string;
  status?: number | null;
};

/** One structured line per provider call. The evidence the constants above are tuned from. */
export function logProviderCall(entry: ProviderCallLog): void {
  console.log(`[provider-call] ${JSON.stringify(entry)}`);
}
