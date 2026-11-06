/**
 * The orphan sweep's pure parts (#72, migration 056): the window, the RPC
 * names, the shape of what the database answers, and the operation id rule.
 * No I/O here, so the admin action's decisions are testable without a
 * database; the action in app/admin/erasure/actions.ts does the calling.
 */

/**
 * Rows orphaned inside this window are never swept. The sweep function
 * enforces the same number and REFUSES a nearer cutoff rather than clamping
 * it (migration 056, step 5), so this constant can only ever ask for the
 * same window or a wider one.
 */
export const SWEEP_WINDOW_DAYS = 30;

export const SWEEP_PREVIEW_RPC = "preview_orphaned_message_rows";
export const SWEEP_RPC = "erase_orphaned_message_rows";
export const ERASURE_AUDIT_TABLE = "candidate_erasures";

/** Postgres unique_violation, raised by candidate_erasures_operation_id_key. */
export const UNIQUE_VIOLATION = "23505";

export type SweepCounts = { communication_logs: number; notifications_company: number };

/** The cutoff the sweep passes: everything orphaned before it is eligible. */
export function sweepCutoff(nowMs: number): Date {
  return new Date(nowMs - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** The two counts the preview and the sweep return, or null for any other shape. */
export function readSweepCounts(value: unknown): SweepCounts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const logs = v.communication_logs;
  const bells = v.notifications_company;
  if (typeof logs !== "number" || typeof bells !== "number") return null;
  if (!Number.isInteger(logs) || !Number.isInteger(bells) || logs < 0 || bells < 0) return null;
  return { communication_logs: logs, notifications_company: bells };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A client-generated operation id: the retry key, so it has to be a real uuid. */
export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
