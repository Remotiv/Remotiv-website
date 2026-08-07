import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Interview session tokens.
 *
 * The token is the ONLY credential on /interview/[token] — there is no login,
 * so it is a bearer secret and treated like one.
 *
 * Only the SHA-256 hash is persisted, in interview_sessions.token_hash; the raw
 * value exists solely inside the emailed URL. This follows company_invites.
 *
 * It deliberately does NOT follow talent_claim_tokens, which stores its token
 * RAW despite the column being named token_hash — a leaked backup of that table
 * hands out working links, and copying it here would put candidate video behind
 * the same flaw.
 *
 * SHA-256 rather than bcrypt because the token already carries 256 bits of
 * entropy: there is no low-entropy secret to slow an attacker down on, and a
 * per-request bcrypt would just make the candidate page slow.
 */
export function mintSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashSessionToken(rawToken) };
}

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Public URL a candidate opens. Raw token, never the hash. */
export function interviewUrl(rawToken: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv.work";
  return `${base}/interview/${rawToken}`;
}

/** Days a session stays open. Stated in the invite and on the Welcome screen. */
export const SESSION_EXPIRY_DAYS = 5;

/**
 * How long a recording is kept before deletion.
 *
 * Six months, and the consent screen says so in those words — the value here
 * and the copy the candidate agreed to must not drift apart.
 */
export const RETENTION_MONTHS = 6;
