import "server-only";

/**
 * The OAuth redirect URI.
 *
 * ── Why this is an allowlist and not derived from the request ──
 *
 * The value must be byte-identical in the authorize step and the token
 * exchange or Google rejects the exchange with `redirect_uri_mismatch`, and it
 * must match one of the URIs registered on the OAuth client exactly.
 *
 * Deriving it from the incoming request's Host header would satisfy the first
 * requirement and break the second on every preview deployment — and worse, it
 * would let an attacker-controlled Host header choose where the consent
 * redirect lands. Host is client-supplied; the registered URIs are not. So the
 * set is closed, hardcoded, and matches exactly what is registered.
 *
 * Registered on the OAuth client:
 *   https://remotiv.work/api/calendar/google/callback
 *   http://localhost:3000/api/calendar/google/callback
 */

const PRODUCTION_ORIGIN = "https://remotiv.work";
const DEVELOPMENT_ORIGIN = "http://localhost:3000";

/**
 * Production is decided by NODE_ENV, which Next sets to "production" for a
 * real build and "development" for `next dev`. A preview deployment therefore
 * resolves to the production URI and will fail the redirect check — correctly,
 * because a preview host is not a registered URI and pretending otherwise
 * would mean registering a wildcard, which is a far worse thing to own.
 */
export function calendarRedirectUri(provider: "google"): string {
  const origin = process.env.NODE_ENV === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
  return `${origin}/api/calendar/${provider}/callback`;
}

/** Where the browser is sent once the callback has finished, success or not. */
export function settingsReturnUrl(): string {
  const origin = process.env.NODE_ENV === "production" ? PRODUCTION_ORIGIN : DEVELOPMENT_ORIGIN;
  return `${origin}/ai-dashboard/settings`;
}
