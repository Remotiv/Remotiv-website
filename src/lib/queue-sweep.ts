import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * background_jobs row retention.
 *
 * ── What this is for ─────────────────────────────────────────
 *
 * Nothing has ever deleted a queue row. `succeeded` grows with every CV
 * scored, every email sent and every transcript taken, and the health panel's
 * status counts read across that set — so the one screen that exists to tell
 * an operator the queue is healthy gets slower every month that it is.
 *
 * A job that succeeded three months ago tells nobody anything. It is not
 * evidence, nobody will retry it, and no product surface reads it.
 *
 * ── What is kept, and why ────────────────────────────────────
 *
 *   succeeded  DELETED past RETAIN_DAYS. Nothing reads it.
 *   failed     KEPT regardless of age. It is diagnostic: a job that failed
 *              twice and then succeeded is the evidence that something is
 *              flaky, and age is exactly what makes that pattern visible.
 *   dead       KEPT regardless of age. The dead letter is the ONE place a
 *              human is expected to look, and a retention rule that quietly
 *              emptied it would remove the only record that work was lost.
 *   queued     KEPT — it has not run.
 *   running    KEPT — it is running.
 *
 * ── Bounded batches, not one statement ───────────────────────
 *
 * A single unbounded DELETE on a large table holds row locks and a long
 * transaction for as long as it takes, and this runs unattended on a schedule
 * nobody is watching. So it deletes in fixed batches, oldest first, and stops
 * on a wall-clock budget — the same shape as the interview and CV purges.
 *
 * PostgREST has no LIMIT on DELETE, so each batch is a bounded SELECT of ids
 * followed by a DELETE of exactly those ids.
 */

/**
 * Rows per batch.
 *
 * Chosen against the live API rather than guessed. A DELETE carries its ids in
 * the URL as `id=in.(…)`, and 37 bytes per uuid adds up fast — probing the real
 * endpoint:
 *
 *   100 ids →  3.8KB → 200 OK
 *   200 ids →  7.5KB → 200 OK      ← this
 *   300 ids → 11.2KB → 200 OK
 *   500 ids → 18.6KB → connection failed
 *   800 ids → 29.7KB → 400 Bad Request
 *
 * 200 sits at roughly a third of the observed ceiling, which leaves room for
 * the gateway in front of PostgREST to be configured more tightly than it is
 * today without this silently starting to fail. It also matches the 100-200
 * chunking the rest of this codebase already uses for `.in()` filters.
 */
const SWEEP_BATCH = 200;

/** How long a succeeded row is kept. See the report for why 30. */
const RETAIN_DAYS = 30;

/**
 * Wall-clock budget, matching the other sweeps.
 *
 * Stopping early is free: the selector is derived from current state, never a
 * cursor, so the next run resumes exactly where this one stopped without
 * anything having to remember where that was.
 */
const BUDGET_MS = 18_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleQueueSweep(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const service = createServiceClient();
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - RETAIN_DAYS * DAY_MS).toISOString();

  let deleted = 0;
  let batches = 0;
  let truncated = false;

  for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      truncated = true;
      break;
    }

    /*
     * ── Not deleting itself ──
     *
     * TWO independent reasons, and the first holds on its own:
     *
     * 1. This job's row is `running` for the whole time this function
     *    executes — completeJob only marks it `succeeded` after the handler
     *    returns. `status = 'succeeded'` therefore cannot match it, and the
     *    row it becomes afterwards is timestamped now, so it is RETAIN_DAYS
     *    away from being a candidate anyway.
     *
     * 2. `.neq("id", job.id)` says so explicitly. Reason 1 is a property of
     *    the queue's lifecycle rather than of this file, so it would be
     *    silently lost the day someone widened the status filter to include,
     *    say, `running` rows older than the lease. This makes the invariant
     *    local to the query that depends on it.
     *
     * A PREVIOUS sweep's row is a legitimate target and is deliberately not
     * excluded — it is an ordinary succeeded row once it is old enough.
     */
    const { data, error } = await service
      .from("background_jobs")
      .select("id")
      .eq("status", "succeeded")
      .lt("created_at", cutoff)
      .neq("id", job.id)
      // Oldest first, so every batch makes progress from the far end and a
      // budget stop leaves the newest rows for last.
      .order("created_at", { ascending: true })
      .limit(SWEEP_BATCH);

    if (error) throw new Error(`queue sweep: select: ${error.message}`);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) break;

    /*
     * The status filter is REPEATED on the delete rather than trusted from the
     * select above. Nothing can move a row out of `succeeded` today — it is
     * terminal, and only the dead-letter retry writes a status at all — but a
     * delete that names rows by id alone is one future feature away from
     * removing something it did not choose. Re-asserting costs nothing.
     */
    const { error: delErr } = await service
      .from("background_jobs")
      .delete()
      .in("id", ids)
      .eq("status", "succeeded")
      .neq("id", job.id);

    if (delErr) throw new Error(`queue sweep: delete: ${delErr.message}`);

    deleted += ids.length;
    batches += 1;

    // A short page means the table is drained of eligible rows.
    if (ids.length < SWEEP_BATCH) break;
  }

  console.log(
    `[queue-sweep] job ${job.id}: deleted=${deleted} batches=${batches} ` +
      `cutoff=${cutoff}` +
      (truncated ? " (budget reached — resumes next run)" : ""),
  );
}
