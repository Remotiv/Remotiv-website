/**
 * Which communication_logs statuses each Messages number counts.
 *
 * Every count names its statuses. None of them is "everything except X": the
 * hero's numerator was neq('queued'), which silently absorbed 'read' when the
 * WhatsApp webhook started writing it, and that is how the page reached 102%
 * (#44). A status nobody listed here is now left out of every count instead,
 * and fetchMessageAggregates logs how many rows that was.
 *
 * The seven known values come from scripts/staging/seed-plan.mjs, not from
 * production's CHECK constraint, which has not been read. The logged count of
 * unrecognised rows is what would show the two disagreeing.
 *
 * A plain module rather than part of actions.ts: that file is "use server",
 * and the client needs splitPercents.
 */

/** Manual vs automatic is split over these: every message that was attempted. */
export const SPLIT_STATUSES = ["sent", "delivered", "read", "failed", "skipped"] as const;

/** "Messages sent": left us and was not reported failed. */
export const SENT_STATUSES = ["sent", "delivered", "read"] as const;

export const SCHEDULED_STATUS = "queued";
export const FAILED_STATUS = "failed";
export const CANCELLED_STATUS = "cancelled";

/** What the All tab lists: the split, plus what is still waiting to go. */
export const VISIBLE_STATUSES = [...SPLIT_STATUSES, SCHEDULED_STATUS] as const;

/** Every value the code knows about. Anything else is reported, not counted. */
export const KNOWN_STATUSES = [...VISIBLE_STATUSES, CANCELLED_STATUS] as const;

/**
 * NULL is not "manual", so it is automatic: the same reading kindOf gives a
 * row. A plain neq('event', 'manual') would drop NULL from both halves.
 */
export const AUTOMATIC_EVENT_FILTER = "event.is.null,event.neq.manual";

/**
 * The manual and automatic shares of the split, as whole percentages.
 *
 * Rounded once. Rounding both halves independently can total 101 (12.5 and
 * 87.5 round to 13 and 88), so the automatic half is whatever is left. With
 * nothing to split, both read 0 rather than NaN.
 */
export function splitPercents(
  manual: number,
  population: number,
): { manual: number; automatic: number } {
  if (!(population > 0)) return { manual: 0, automatic: 0 };
  const share = Math.min(100, Math.max(0, Math.round((manual / population) * 100)));
  return { manual: share, automatic: 100 - share };
}
