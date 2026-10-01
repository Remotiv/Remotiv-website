/**
 * The public URLs a candidate opens with a bearer token in the path, and the
 * one function that scrubs them out of anything we store.
 *
 * They live in one file so the list of link shapes and the redactor can never
 * drift apart: a builder added here is covered by redactCandidateLinks the
 * moment it uses TOKEN_PATHS, and candidate-links.test.ts feeds every builder
 * in CANDIDATE_LINK_BUILDERS through the redactor, so a builder that bypasses
 * the list fails a test rather than leaking silently into communication_logs.
 *
 * Deliberately dependency-free (no "server-only", no supabase) so the test
 * runs under bare Node. interviews/tokens.ts and calendar/bookings.ts
 * re-export their builder from here; their callers did not move.
 */

function siteBase(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv.work";
}

/** Path prefixes under which a raw token appears as the next segment. */
export const TOKEN_PATHS = {
  interview: "/interview/",
  booking: "/book/",
} as const;

/** The URL a candidate opens to record an interview. Raw token, never the hash. */
export function interviewUrl(rawToken: string): string {
  return `${siteBase()}${TOKEN_PATHS.interview}${rawToken}`;
}

/** The URL a candidate opens to book a slot. Raw token, never the hash. */
export function bookingUrl(rawToken: string): string {
  return `${siteBase()}${TOKEN_PATHS.booking}${rawToken}`;
}

/** Every builder above, by name, for the test to iterate. Add new ones here. */
export const CANDIDATE_LINK_BUILDERS = { interviewUrl, bookingUrl } as const;

/** What replaces the token in a stored body. Never a valid token character run. */
export const REDACTED_LINK = "[link-removed]";

/**
 * A raw token is 43 chars of base64url. The floor is 20 so the pattern still
 * catches a shorter future token, and never catches a placeholder or a slug.
 * Mirrors the regexp in migrations/026_redact_stored_candidate_links.sql.
 */
const TOKEN_SEGMENT = "[A-Za-z0-9_-]{20,}";

const REDACTIONS = Object.values(TOKEN_PATHS).map((path) => ({
  pattern: new RegExp(`(${path.replace(/\//g, "\\/")})${TOKEN_SEGMENT}`, "g"),
  replacement: `$1${REDACTED_LINK}`,
}));

/**
 * Strip the token out of every candidate link in a rendered email so the copy
 * kept in communication_logs.body cannot be used to open the interview or take
 * the slot. The message the candidate receives is untouched; only the stored
 * copy changes. Idempotent: a redacted body has no token run to match.
 *
 * ── What this does NOT do ────────────────────────────────────
 *
 * It covers OUR database and nothing else. Resend keeps the full sent body,
 * live token included, for every one of these emails on the provider side, and
 * the token is a URL path, so it is in the request logs of whatever served the
 * click. A placeholder in a stored row means the link was removed from THIS
 * copy - not that the link is gone.
 *
 * The unsubscribe footer is left alone on purpose: it is an HMAC claim over
 * company + email whose worst case is one candidate's opt-out, and the queued
 * rows that sendScheduledNow re-sends need their footer intact.
 *
 * ── Every write, not most of them ────────────────────────────
 *
 * Every value written to communication_logs.body goes through this function at
 * the write site itself, never upstream of it. The first version redacted one
 * of deliverEmail's two inserts, the daily-cap one, and stored the normal send
 * raw, so the fix covered the path that almost never runs.
 * communication-log-writes.test.ts reads every write to the table and fails on
 * any body that is not passed through here, an empty string, or null.
 *
 * Accepts null and undefined so a nullable column can be written as
 * `body: redactCandidateLinks(row.body)` rather than a ternary around it, which
 * keeps the one shape that test accepts.
 */
export function redactCandidateLinks(html: string): string;
export function redactCandidateLinks(html: string | null | undefined): string | null;
export function redactCandidateLinks(html: string | null | undefined): string | null {
  if (html == null) return null;
  return REDACTIONS.reduce(
    (out, { pattern, replacement }) => out.replace(pattern, replacement),
    html,
  );
}
