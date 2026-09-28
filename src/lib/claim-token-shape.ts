/**
 * The one shape check for a raw claim token, in a file with no node:crypto so
 * the two client components that gate on it (/jobs apply modal, /join-as-talent)
 * can import it too. Servers import it via claim-tokens.ts.
 *
 * New tokens are 43 chars of base64url; legacy raw tokens (in flight for at
 * most seven days after deploy) were 64 hex. Anything outside a generous band
 * is rejected before it reaches a query — a shape check, not authentication.
 */
export function looksLikeClaimToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
