import type { DeliveryOutcome } from "@/lib/email/candidate/deliver";

/**
 * A booking email that was not sent, said to the person who sent it (#19).
 *
 * deliverEmail's refusals are of two kinds. Ours ("cap", "not_configured",
 * "duplicate", "log", "deleting") carry sentences written for the sender. A
 * "provider" refusal carries the email service's own text (an address it
 * would not take, a key it rejected), which is not for anyone's screen: it is
 * replaced here by a plain sentence, and the log gets the kind only.
 */
export const BOOKING_EMAIL_NOT_SENT =
  "The email service couldn't send the booking link right now, so nothing was sent.";

export function bookingSendFailure(
  outcome: Extract<DeliveryOutcome, { ok: false }>,
  where: string,
): string {
  console.error(`[booking] ${where}: not sent (${outcome.kind})`);
  return outcome.kind === "provider" ? BOOKING_EMAIL_NOT_SENT : outcome.message;
}
