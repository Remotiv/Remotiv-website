import "server-only";

/**
 * A job whose subject no longer exists is DONE, not broken.
 *
 * ── The failure this replaces ────────────────────────────────
 *
 * Deleting an interview or an application leaves its queued jobs behind. The
 * handlers threw "answer <id> not found", which the queue correctly treats as
 * an error: three attempts, exponential backoff up to an hour between them,
 * then the dead-letter queue. Retrying is pointless by construction — the row
 * was deleted on purpose and is never coming back — so each one burned three
 * worker slots to reach a conclusion that was available on the first read.
 *
 * Worse, it filled the dead letter with entries an operator has to triage and
 * cannot action, which is exactly the noise that makes a real dead job easy to
 * miss.
 *
 * ── Why this logs rather than setting a status ───────────────
 *
 * background_jobs has no `skipped` status: its CHECK constraint allows
 * queued / running / succeeded / failed / dead, and completeJob() clears
 * last_error on success. So a handler that returns without throwing lands as
 * `succeeded` with no stored trace of having done nothing.
 *
 * That is the right OUTCOME — one attempt, no backoff, no dead letter — but it
 * does mean the only record is this log line, which is why it carries a fixed
 * prefix worth grepping for. Giving skips a status of their own needs a CHECK
 * constraint change and a queue change; see the report.
 */
export function skipJob(
  type: string,
  jobId: string,
  reason: string,
): void {
  console.log(`[job-skip] ${type} ${jobId}: ${reason}`);
}
