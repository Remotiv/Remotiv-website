import { createHash, randomBytes } from "node:crypto";

/**
 * Talent claim tokens: minted for an admin invite (/api/admin/send-invite) and
 * for the post-apply "create your profile" bridge (/api/apply). The raw value
 * lives in the URL or the response; only the digest is ever stored.
 *
 * ── Why this file exists ─────────────────────────────────────
 *
 * talent_claim_tokens.token_hash held the RAW token for its whole history —
 * the column name was aspirational. Every other token in this codebase is
 * sha256-at-rest (interviews/tokens.ts, calendar/bookings.ts,
 * talent-retention.ts, team/actions.ts); this brings the fifth into line.
 * The two writers and three readers all go through these two functions so the
 * shape cannot drift again.
 *
 * ── Why base64url and not hex ────────────────────────────────
 *
 * A legacy raw token is 64 hex characters. sha256 in hex is ALSO 64 hex
 * characters, so a hashed row and an unhashed row would be indistinguishable
 * by shape — and the backfill that hashes the legacy rows could never tell
 * whether it had already run. Encoding the digest as base64url (43 chars, with
 * `-` and `_`) makes the two populations disjoint: migration 025 hashes only
 * rows still matching ^[0-9a-f]{64}$, and a second run updates zero rows.
 *
 * ── Entropy ──────────────────────────────────────────────────
 *
 * randomBytes(32) — 256 bits, the same as the other four token types, so
 * sha256 rather than a slow hash: there is nothing to brute-force.
 */
export function mintClaimToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashClaimToken(rawToken) };
}

export function hashClaimToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("base64url");
}

// The shape check lives in its own crypto-free module so client components
// can share it; re-exported here so server routes have one import.
export { looksLikeClaimToken } from "./claim-token-shape";
