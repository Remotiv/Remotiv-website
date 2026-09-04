import { combineChunks, stringFromBase64URL } from "@supabase/ssr";

/**
 * Look at the session cookie WITHOUT waking auth-js up.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * Every auth-js call that reads the session — getUser(), getSession(),
 * refreshSession() — goes through __loadSession, and __loadSession refreshes
 * an expired token unconditionally (GoTrueClient.js, the `hasExpired` branch;
 * `autoRefreshToken: false` only disables the background timer, not this).
 * In a Server Component that refresh has nowhere to land: createClient()'s
 * setAll is a no-op during render, so the rotation is spent and the browser
 * keeps the OLD refresh token. The next thing to use that token is inside
 * Supabase's reuse window or it is not, and outside it the whole family is
 * revoked. That is the hole this module closes: the gate must never let
 * auth-js see an expired token during a render.
 *
 * So the gate reads the cookie itself, the same way @supabase/ssr does —
 * same key, same chunking, same base64url envelope — and decides on
 * `expires_at` alone. It never touches auth-js. When the token is live, the
 * later getUser() finds nothing to refresh; when it is not, the gate sends the
 * browser somewhere a refresh CAN be persisted (a Route Handler) instead.
 *
 * A PLAIN MODULE. No "use server" — it would turn peekSession into a POST
 * endpoint that hands out a session's expiry to anyone who asks.
 */

/** What the cookie says, before anything has been verified against Supabase. */
export type SessionPeek =
  /** No session cookie at all — signed out, or never signed in. */
  | { state: "none" }
  /**
   * A session cookie whose access token is inside the refresh margin. There is
   * a refresh token; it just cannot be spent from a render.
   */
  | { state: "expired"; expiresAt: number }
  /** An access token with usable life left. Unverified — that is getUser()'s job. */
  | { state: "live"; expiresAt: number };

/**
 * The gate's margin is WIDER than auth-js's, on purpose.
 *
 * auth-js treats a token as expired EXPIRY_MARGIN_MS (90s) before expires_at.
 * If the gate used the same line, a token judged "live" here could cross it in
 * the milliseconds before getUser() runs, and __loadSession would refresh
 * after all — the exact thing this module exists to prevent. Two minutes puts
 * the gate's line comfortably ahead of auth-js's, so anything the gate calls
 * live is still live when auth-js looks.
 */
/**
 * auth-js's own line: AUTO_REFRESH_TICK_THRESHOLD (3) × AUTO_REFRESH_TICK_DURATION_MS
 * (30s). Copied rather than imported — the constant lives at a deep dist path
 * that Node's loader will not resolve extensionless, and a public-page module
 * should not depend on a library's internal file layout. The unit test imports
 * the real value and fails if this copy drifts.
 */
export const AUTH_JS_EXPIRY_MARGIN_MS = 3 * 30 * 1000;

export const PEEK_MARGIN_MS = AUTH_JS_EXPIRY_MARGIN_MS + 30 * 1000;

/** The cookie name supabase-js derives: `sb-<project-ref>-auth-token`. */
export function sessionCookieName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

const BASE64_PREFIX = "base64-";

type CookieReader = { get(name: string): { value: string } | undefined };

/**
 * Decode `expires_at` out of the session cookie.
 *
 * Mirrors @supabase/ssr's storage.getItem exactly: reassemble the `.0`, `.1`…
 * chunks, strip the `base64-` envelope, parse. Anything malformed is treated
 * as "none" rather than thrown — a corrupt cookie should read as signed out,
 * not take the dashboard down.
 */
export async function peekSession(
  cookies: CookieReader,
  supabaseUrl: string = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  now: number = Date.now(),
): Promise<SessionPeek> {
  if (!supabaseUrl) return { state: "none" };
  const key = sessionCookieName(supabaseUrl);

  let raw: string | null;
  try {
    raw = await combineChunks(key, async (chunkName) => cookies.get(chunkName)?.value ?? null);
  } catch {
    return { state: "none" };
  }
  if (!raw) return { state: "none" };

  let json = raw;
  if (raw.startsWith(BASE64_PREFIX)) {
    try {
      json = stringFromBase64URL(raw.slice(BASE64_PREFIX.length));
    } catch {
      return { state: "none" };
    }
  }

  let expiresAt: unknown;
  try {
    expiresAt = (JSON.parse(json) as { expires_at?: unknown }).expires_at;
  } catch {
    return { state: "none" };
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { state: "none" };

  return expiresAt * 1000 - now < PEEK_MARGIN_MS
    ? { state: "expired", expiresAt }
    : { state: "live", expiresAt };
}

/**
 * The one-attempt latch. Set by the recover handler, read by the gate.
 *
 * Path-scoped to the dashboard and short-lived: it exists only to make "we
 * already tried" visible to the very next render, not to remember anything.
 */
export const RECOVER_ATTEMPTED_COOKIE = "ai-recover-attempted";
export const RECOVER_ATTEMPTED_MAX_AGE_S = 30;

/**
 * Where the recover handler may send the browser afterwards.
 *
 * `next` arrives from a query string, so it is attacker-shaped whatever the
 * gate put there. Only a same-origin dashboard path survives: a scheme, a
 * protocol-relative `//host`, a backslash, a line break, the recover URL
 * itself, or the login page all collapse to the dashboard root rather than
 * being followed.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/ai-dashboard";
  if (!raw.startsWith("/ai-dashboard")) return "/ai-dashboard";
  if (raw.startsWith("//") || raw.includes("\\") || /[\r\n]/.test(raw)) return "/ai-dashboard";
  if (raw.startsWith("/ai-dashboard/api/") || raw.startsWith("/ai-dashboard/login")) {
    return "/ai-dashboard";
  }
  return raw;
}
