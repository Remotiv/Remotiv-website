/**
 * What a server action tells the recruiter when a database write fails
 * (Phase 6, A6-26).
 *
 * The actions used to return `error.message` from PostgREST, and the clients
 * toasted it: "duplicate key value violates unique constraint …" after a stage
 * change that had already snapped back. The recruiter needs three things -
 * what happened, whether anything changed, what to do - and none of them is in
 * a Postgres message. The raw message still goes to the server log, where the
 * person who can act on it will look.
 *
 * One template, not a catalogue: the caller supplies the verb phrase.
 */
export function actionFailed(
  what: string,
  err: { message?: string } | string | null | undefined,
): string {
  const detail = typeof err === "string" ? err : err?.message;
  console.error(`[action] ${what} failed:`, detail ?? "(no message)");
  return `Couldn't ${what}. Nothing was changed - try again in a moment.`;
}

/**
 * For an action that may have PARTLY happened before the failure - an earlier
 * write in the same action succeeded, or a rollback itself failed. The
 * promise "nothing was changed" would be false here, so the sentence sends
 * the recruiter to look instead.
 */
export function actionIncomplete(
  what: string,
  err: { message?: string } | string | null | undefined,
): string {
  const detail = typeof err === "string" ? err : err?.message;
  console.error(`[action] ${what} failed part-way:`, detail ?? "(no message)");
  return "We couldn't finish that action. Refresh to check the current state, then try again.";
}

/** For enqueue failures, where the queue's own message may carry a SQLSTATE. */
export function queueFailed(what: string, err: string | null | undefined): string {
  console.error(`[action] ${what} could not be queued:`, err ?? "(no message)");
  return `Couldn't queue ${what} - try again in a moment.`;
}
