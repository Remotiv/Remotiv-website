/**
 * Median of N for CV scoring (AI_SCORING_RUNS).
 *
 * One scoring run can land a few points high or low - on the 50-CV benchmark
 * 6 of 50 applications moved by more than 5 points between identical runs - so
 * with AI_SCORING_RUNS=3 every CV is scored three times in parallel and the
 * card whose FINAL overall (after the job's weights) is the median is the one
 * stored. Each run is a complete scoring: its own model call, parse, quote
 * verification, must-haves and weights.
 *
 * Failures, run by run:
 *   - a failed run is tried once more, if the policy says there is time;
 *   - an error the policy calls final (billing, configuration, a skip, a
 *     yield) ends the whole scoring at once, as it would with one run;
 *   - three cards: the median; two: the LOWER, so partial data never inflates
 *     a score; fewer than two: the first failed run's error is thrown, and the
 *     caller's usual failure path takes it.
 *
 * Generic on purpose: nothing here knows what a scorecard or a provider is.
 */

export type ScoringRuns = 1 | 3;

/** AI_SCORING_RUNS: 1 (default) or 3. Anything else is 1, with a one-line warning. */
export function resolveScoringRuns(
  raw: string | undefined = process.env.AI_SCORING_RUNS,
): ScoringRuns {
  const value = raw?.trim();
  if (!value || value === "1") return 1;
  if (value === "3") return 3;
  console.warn(
    `[cv-scoring] AI_SCORING_RUNS must be 1 or 3 (got ${JSON.stringify(value.slice(0, 12))}); using 1`,
  );
  return 1;
}

export type RunPolicy<T> = {
  runs: number;
  /** One complete scoring. `retry` is true for the second try of a failed run. */
  attempt: (retry: boolean) => Promise<T>;
  /** The number the median is taken over. */
  overall: (value: T) => number;
  /** Errors that end the whole scoring immediately, with no retry. */
  isFinal: (err: unknown, retry: boolean) => boolean;
  /** Whether a failed run may be tried again now (the time budget). */
  canRetry: () => boolean;
};

export type RunResult<T> =
  | { ok: true; value: T; retried: boolean }
  | { ok: false; error: unknown; retried: boolean };

export type MedianOutcome<T> = {
  chosen: T;
  /** Index of the run whose card was chosen. */
  chosenRun: number;
  rule: "median" | "lower of two";
  results: RunResult<T>[];
};

async function oneRun<T>(policy: RunPolicy<T>): Promise<RunResult<T>> {
  try {
    return { ok: true, value: await policy.attempt(false), retried: false };
  } catch (first) {
    if (policy.isFinal(first, false)) throw first;
    if (!policy.canRetry()) return { ok: false, error: first, retried: false };
    try {
      return { ok: true, value: await policy.attempt(true), retried: true };
    } catch (second) {
      if (policy.isFinal(second, true)) throw second;
      return { ok: false, error: second, retried: true };
    }
  }
}

/** Run `policy.runs` scorings in parallel and choose one card. See the file comment. */
export async function medianOfRuns<T>(policy: RunPolicy<T>): Promise<MedianOutcome<T>> {
  const results = await Promise.all(Array.from({ length: policy.runs }, () => oneRun(policy)));

  // Ascending by overall; equal overalls keep run order, so the choice is stable.
  const succeeded = results
    .flatMap((r, run) => (r.ok ? [{ run, value: r.value, overall: policy.overall(r.value) }] : []))
    .sort((a, b) => a.overall - b.overall || a.run - b.run);

  if (succeeded.length < Math.min(2, policy.runs)) {
    const failed = results.find((r): r is Extract<RunResult<T>, { ok: false }> => !r.ok);
    throw failed?.error;
  }
  const pick =
    succeeded.length === 2 ? succeeded[0] : succeeded[Math.floor((succeeded.length - 1) / 2)];
  return {
    chosen: pick.value,
    chosenRun: pick.run,
    rule: succeeded.length === 2 ? "lower of two" : "median",
    results,
  };
}
