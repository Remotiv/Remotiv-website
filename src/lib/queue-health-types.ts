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

export type QueueHealth = {
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
  leaseTimeoutMs: number;
  rowCap: number;
};
