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

/**
 * The Failed tile's caption (#86).
 *
 * It names what is counted and claims nothing more. The counts cover current
 * applicants only (an erased applicant's messages are excluded by design), so
 * the zero-failure caption says so. It never says "delivered": an email row
 * stops at 'sent' when Resend accepts it, and no bounce is ever recorded. It
 * gives no percentage, because none is computed, and a queued message is in
 * neither count, so it can still fail.
 */
export function failedCaption({ failed, sent }: { failed: number; sent: number }): string {
  if (failed === 1) return "1 message failed";
  if (failed > 1) return `${failed} messages failed`;
  return sent > 0 ? "No failed messages for current applicants" : "Nothing sent yet";
}

/**
 * The message drawer's footer for every row that is neither pending nor
 * failed (those two keep their own footers), by the STORED status and never
 * upgraded. Nothing but 'delivered' and 'read' ever says delivered or read.
 *
 * Only the WhatsApp webhook writes 'delivered' and 'read' (it looks rows up
 * with channel = 'whatsapp'). An email row stops at 'sent' when Resend accepts
 * it, because no email delivery receipt is ever recorded, so it never reads
 * Delivered.
 *
 * The time is when the message was sent (sent_at, or created_at when that is
 * missing). The webhook records no delivery or read time, so a delivered or
 * read row still names its send time, and says so.
 *
 * A skipped row was never sent, and shows no time: its created_at is not
 * always when it was skipped. Most skips insert a new row at that moment, but
 * communication-attempt.ts marks an existing queued row skipped, so its
 * created_at is when the message was queued. Any other status gets a plain
 * "Status unknown", never a delivery claim.
 */
export function sentStatusLabel(status: string, sentTime: string): string {
  if (status === "sent") return `Sent · ${sentTime}`;
  if (status === "delivered") return `Delivered · sent ${sentTime}`;
  if (status === "read") return `Read · sent ${sentTime}`;
  if (status === "skipped") return "Not sent";
  return "Status unknown";
}
