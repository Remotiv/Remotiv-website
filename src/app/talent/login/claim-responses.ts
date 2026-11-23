import { refusalMessage } from "@/lib/rate-limit-copy";

/**
 * What the talent login page does with an answer from /api/claim/verify and
 * /api/claim/initiate (#57). A pure module so the decision can be tested
 * without a DOM: login-client.tsx calls these and only renders the result.
 *
 * A refusal (429 over the limit, 503 the limit store could not answer) is
 * neither a bad link nor a sent code, so it is decided first: before the
 * invalid-link banner, and before "We sent a 6-digit code".
 */

export const REASON_BANNER: Record<string, string> = {
  unauthorized: "Please sign in to access the talent dashboard.",
  expired: "Your invite link has expired. Enter your email below to get a new code.",
  invalid: "We couldn't recognise that invite link. Enter your email below to continue.",
  already_claimed:
    "This profile is already claimed. If that's not you, contact talent@remotiv.work.",
  email_conflict:
    "This email is already registered as a client or admin. Please use a different email or contact support.",
};

// Token failures split two ways. Recoverable ones (bad/stale link) drop the
// candidate back to the email step so they can self-serve a fresh code via the
// existing /api/claim/initiate flow; the banner copy already promises that.
// Terminal ones can't be fixed by a resend, so they stay a dead end.
export const TERMINAL_TOKEN_REASONS = new Set(["already_claimed", "email_conflict"]);

type ClaimBody = { ok?: boolean; reason?: string; email?: string; message?: string };

export type VerifyOutcome =
  | { kind: "refused"; message: string }
  | { kind: "verified"; email: string }
  | { kind: "terminal"; reason: string }
  | { kind: "recoverable"; banner: string };

export function verifyOutcome(status: number, body: ClaimBody): VerifyOutcome {
  const refused = refusalMessage(status);
  if (refused) return { kind: "refused", message: refused };
  if (body.ok && body.email) return { kind: "verified", email: body.email };
  const reason = body.reason ?? "invalid";
  if (TERMINAL_TOKEN_REASONS.has(reason)) return { kind: "terminal", reason };
  return { kind: "recoverable", banner: REASON_BANNER[reason] ?? REASON_BANNER.invalid };
}

export type InitiateOutcome =
  | { kind: "refused"; message: string }
  | { kind: "conflict" }
  | { kind: "sent"; message: string | null }
  | { kind: "failed" };

/** Only an ok answer means a code went out; anything else is said as it is. */
export function initiateOutcome(status: number, body: ClaimBody): InitiateOutcome {
  const refused = refusalMessage(status);
  if (refused) return { kind: "refused", message: refused };
  if (body.reason === "email_conflict") return { kind: "conflict" };
  if (body.ok) return { kind: "sent", message: body.message ?? null };
  return { kind: "failed" };
}
