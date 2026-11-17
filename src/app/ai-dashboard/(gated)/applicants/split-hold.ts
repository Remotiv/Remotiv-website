/**
 * How long the Split panel holds a scored applicant's cards for its read
 * (QA R2 F2, task #34).
 *
 * The panel hides the cards while the read is in flight, so the scorecard
 * (Summary and Scored dimensions) and the cards appear together instead of
 * the scorecard landing on top of cards already on screen. A read that never
 * returns would hide them for good, so the hold is capped: after
 * SPLIT_HOLD_CAP_MS for that row the cards show anyway, and a scorecard that
 * lands later may push them down (accepted for reads that slow).
 *
 * Production's read lands about 1 s after first paint (QA R2), so the cap
 * should rarely fire. Pure and timer-only, so split-hold.test.ts can drive it
 * with mock timers.
 */

export const SPLIT_HOLD_CAP_MS = 8000;

/** Calls onExpire(id) once the cap passes for this row's read; returns the cancel. */
export function startHoldCap(
  id: string,
  onExpire: (id: string) => void,
  ms: number = SPLIT_HOLD_CAP_MS,
): () => void {
  const t = setTimeout(() => onExpire(id), ms);
  return () => clearTimeout(t);
}

/**
 * The panel is still waiting for this row's read: it has not landed (or
 * failed) for this row, and the cap has not passed for it.
 */
export function splitReading(
  rowId: string,
  readId: string | null | undefined,
  expiredId: string | null,
): boolean {
  return readId !== rowId && expiredId !== rowId;
}
