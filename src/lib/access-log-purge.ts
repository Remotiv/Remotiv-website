import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Access-record retention (migration 047): a record of who opened a CV or a
 * recording is kept for 24 months, then deleted. Both admin_access_logs and
 * signed_url_logs, one rule.
 *
 * ── The database decides what is old ─────────────────────────
 *
 * This job never computes an age, a date or a cutoff. It calls
 * purge_expired_access_logs(), which deletes rows older than 24 months by the
 * database's own now() and each row's own (database-stamped) timestamp, and
 * the guard trigger on each table refuses any other delete. A wrong clock on
 * this server, or a wrong batch size, can change how many rows go per call,
 * never which ones.
 *
 * ── Bounded, like the other purges ───────────────────────────
 *
 * Batches of ACCESS_LOG_PURGE_BATCH per table per call, on the same wall-clock
 * budget as the queue sweep. The function selects from current state, so a
 * run stopped by the budget resumes on the next one with nothing remembered.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Ids, user ids, candidate ids, dates. The log line carries counts only, and
 * a database error is logged by its code and raised as a fixed sentence.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Rows per table per call. The function clamps it to 1..5000 regardless. */
export const ACCESS_LOG_PURGE_BATCH = 1000;

/** Wall-clock budget, matching the queue sweep. */
const BUDGET_MS = 18_000;

type PurgeRow = { admin_access_logs_deleted: number; signed_url_logs_deleted: number };

export async function handleAccessLogPurge(
  job: { id: string; payload?: Record<string, unknown> },
  _ctx?: unknown,
  deps: { service?: Service; now?: () => number } = {},
): Promise<void> {
  const service = deps.service ?? createServiceClient();
  const now = deps.now ?? Date.now;
  const startedAt = now();

  let admin = 0;
  let signed = 0;
  let batches = 0;
  let truncated = false;

  for (;;) {
    if (now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }
    const { data, error } = await service.rpc("purge_expired_access_logs", {
      p_limit: ACCESS_LOG_PURGE_BATCH,
    });
    if (error) {
      console.error(
        `[access-log-purge] job ${job.id}: purge failed (${(error as { code?: string }).code ?? "db"})`,
      );
      throw new Error("access log purge: the purge function failed");
    }
    const row = (Array.isArray(data) ? data[0] : data) as PurgeRow | null | undefined;
    const a = row?.admin_access_logs_deleted;
    const s = row?.signed_url_logs_deleted;
    if (!Number.isInteger(a) || !Number.isInteger(s)) {
      throw new Error("access log purge: the purge function returned no counts");
    }
    admin += a as number;
    signed += s as number;
    batches += 1;
    // Both tables short of a full batch: nothing older than 24 months is left.
    if ((a as number) < ACCESS_LOG_PURGE_BATCH && (s as number) < ACCESS_LOG_PURGE_BATCH) break;
  }

  console.log(
    `[access-log-purge] job ${job.id}: admin_access_logs=${admin} signed_url_logs=${signed} batches=${batches}` +
      (truncated ? " (budget reached - resumes next run)" : ""),
  );
}
