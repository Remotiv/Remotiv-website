/**
 * Shapes and constants for the background-queue panel.
 *
 * Split out of queue-health.ts for the same reason review-types.ts is split
 * out of the interview reader: that module carries `import "server-only"` and
 * reaches jobs-queue.ts, which drags the entire handler graph — Anthropic,
 * Supabase service client, the transcriber — behind it. A client component
 * that imports one VALUE from such a module pulls the whole graph into the
 * browser bundle and the build fails. Types erase; constants do not.
 *
 * Nothing here may import anything server-side.
 */

export const QUEUE_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "dead",
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type QueueJob = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  runAfter: string | null;
  lockedAt: string | null;
  companyId: string | null;
  companyName: string | null;
  /**
   * Payload rendered as safe key/value pairs. See `SAFE_PAYLOAD_KEYS` in
   * queue-health.ts — the raw object is deliberately never carried here.
   */
  payload: { key: string; value: string }[];
  /** True when the payload held a key that file does not recognise. */
  payloadHasUnknown: boolean;
};

/**
 * Worker liveness thresholds, shared by the admin panel tile, the health route
 * an external monitor polls, and the worker's own retrospective stale notice.
 * The documented tick cadence is about one minute (lib/jobs-queue.ts), so five
 * minutes is already several missed ticks and ten is unambiguous.
 */
export const WORKER_TICK_WARN_MS = 5 * 60_000;
export const WORKER_TICK_STALE_MS = 10 * 60_000;

/**
 * One health read that failed. Carries the SOURCE CATEGORY only - "queued
 * page", "dead count" - never the database message. This type crosses into a
 * client component, and a PostgREST error string in the browser is exactly the
 * kind of diagnostic that belongs in server logs and nowhere else.
 */
export type QueueReadError = { source: string };

export type QueueHealth = {
  /**
   * Reads that failed. When non-empty the panel must say so and must not
   * present the affected figures as zeros: a failed count and an empty queue
   * used to render identically, which turned an observability outage into a
   * healthy-looking dashboard.
   */
  readErrors: QueueReadError[];
  /** counts[type][status] — the grid. */
  counts: Record<string, Record<QueueStatus, number>>;
  totals: Record<QueueStatus, number>;
  /** True when a status held more rows than the cap, so its grid row is a floor. */
  capped: Record<string, boolean>;
  dead: QueueJob[];
  /** Running past the lease window — a crashed invocation left these behind. */
  stale: QueueJob[];
  staleTotal: number;
  oldestQueued: { at: string; type: string } | null;
  /** Most recent lease taken by any worker invocation. Null when never. */
  lastClaimAt: string | null;
  /** Most recent self-scheduled maintenance job — liveness even when idle. */
  lastMaintenanceAt: string | null;
  /**
   * The worker's own heartbeat, written at the end of EVERY tick including an
   * empty one. This is the liveness signal; `lastClaimAt` measures throughput
   * and is silent on an idle queue. Null until migration 035 is applied and
   * the first tick has run.
   */
  lastTickAt: string | null;
  leaseTimeoutMs: number;
  rowCap: number;
};
