/**
 * The two operational alerts the worker emits, as pure functions.
 *
 * ── job_dead ─────────────────────────────────────────────────
 *
 * One notification per TICK that killed any job, never one per job. The
 * 17 August incident killed thirteen CV-scoring jobs in one tick; thirteen
 * notifications would have been noise, one saying "13 CV scoring, all billing"
 * is the signal. Deduplication is structural: a job transitions to dead exactly
 * once and dead is never re-run, so a tick's set of dead jobs can never be
 * reported twice.
 *
 * ── What the message may contain ─────────────────────────────
 *
 * Counts, job types, the SAFE failure class (billing, configuration,
 * deterministic, retryable), and a link to the panel. Never `last_error`,
 * never a provider or database message, never a payload field. Raw diagnostics
 * stay in background_jobs and the logs; this text lands in a notifications
 * table read from the browser.
 *
 * ── worker_stale ─────────────────────────────────────────────
 *
 * A dead worker cannot raise its own alarm, so the live alert during an
 * outage comes from an external monitor polling GET /api/health/worker. What
 * the worker CAN do is notice, on its first tick back, that its previous
 * heartbeat was older than the staleness threshold, and record that an outage
 * happened. That is this notice: retrospective, authenticated, one per gap.
 *
 * Pure so every branch is unit-testable under bare node:test.
 */

import type { FailureClass } from "@/lib/queue/failure-class";

export type DeadJobEntry = {
  type: string;
  /** The classifier's word for it, or "retryable" for the out-of-attempts path. */
  failureClass: FailureClass;
};

export type AlertContent = {
  title: string;
  message: string;
  link: string;
  metadata: Record<string, unknown>;
};

export const QUEUE_PANEL_LINK = "/admin/companies";

const CLASS_HINT: Record<FailureClass, string> = {
  billing: "billing - check the provider's credit balance",
  configuration: "configuration - a key or setting the worker needs is missing or wrong",
  deterministic: "deterministic - the same input will fail the same way; needs a code or data fix",
  retryable: "out of attempts after transient failures",
};

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Deterministic order so two ticks with the same deaths produce identical text. */
function sortedEntries(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Build the single job_dead notification for a tick. Returns null when nothing
 * died, so the caller can `if (content) notify(content)` without a length check.
 */
export function summariseDeadJobs(entries: readonly DeadJobEntry[]): AlertContent | null {
  if (entries.length === 0) return null;

  const byType = countBy(entries.map((e) => e.type));
  const byClass = countBy(entries.map((e) => e.failureClass));
  const n = entries.length;

  const typeLine = sortedEntries(byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
  const classLine = sortedEntries(byClass)
    .map(([cls, count]) => `${count} ${CLASS_HINT[cls as FailureClass] ?? cls}`)
    .join("; ");

  return {
    title: n === 1 ? "1 background job died" : `${n} background jobs died`,
    message:
      `${typeLine}. Failure class: ${classLine}. ` +
      `Nothing retries a dead job on its own; the queue panel can retry by type.`,
    link: QUEUE_PANEL_LINK,
    metadata: { deadCount: n, byType, byClass },
  };
}

export type StaleNotice = AlertContent & { gapMinutes: number };

/**
 * If the previous heartbeat is older than the threshold, the worker was down
 * for the gap between it and now. Returns the retrospective notice, or null
 * when the previous tick was recent enough or there was no previous tick at
 * all (first run after migration 035 is not an outage).
 */
export function staleGapNotice(
  previousTickAt: string | null,
  nowMs: number,
  thresholdMs: number,
): StaleNotice | null {
  if (!previousTickAt) return null;
  const prev = new Date(previousTickAt).getTime();
  if (!Number.isFinite(prev)) return null;
  const gapMs = nowMs - prev;
  if (gapMs <= thresholdMs) return null;

  const gapMinutes = Math.round(gapMs / 60_000);
  return {
    title: "Background worker was not running",
    message:
      `No worker tick for about ${gapMinutes} minutes, until now. Jobs queued in that ` +
      `window waited; anything with a deadline in it (interview reminders, expiries) ` +
      `may have fired late. The scheduler that calls the worker is configured outside ` +
      `the repository - check it.`,
    link: QUEUE_PANEL_LINK,
    metadata: { previousTickAt, gapMinutes, thresholdMinutes: Math.round(thresholdMs / 60_000) },
    gapMinutes,
  };
}
