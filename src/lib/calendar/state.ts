import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The OAuth `state` parameter.
 *
 * ── Why both a signature AND a cookie ────────────────────────
 *
 * They stop different attacks and neither is sufficient alone.
 *
 * The SIGNATURE proves we minted this state. Without it an attacker supplies
 * their own `state` and `code` to our callback and we would faithfully attach
 * THEIR calendar to whichever of our members the state named — a login-CSRF
 * that ends with the victim's bookings landing in the attacker's calendar.
 *
 * The COOKIE proves the same browser began the flow. A signature alone is
 * replayable: anything we minted is valid forever to anyone who obtains it,
 * so a state captured from a Referer header or a shared screen could be
 * re-fired later. The cookie nonce binds the callback to the session that
 * started it, and being httpOnly it is not readable by script.
 *
 * ── And the identity in the payload is still not trusted ─────
 *
 * memberId and companyId travel in the signed payload, but the callback does
 * NOT use them to decide whose connection to write. It re-derives the caller
 * from their session and compares. The payload's role is to detect a MISMATCH
 * — a state minted for one member arriving in another's session — which is
 * exactly the confused-deputy case a signature alone would wave through.
 */

/** Cookie holding the nonce. Host-only, httpOnly, SameSite=Lax so it survives
 *  the redirect back from the provider (a top-level GET). */
export const STATE_COOKIE = "rmtv_cal_oauth";

/**
 * How long a consent flow may take. Ten minutes is generous for picking an
 * account and reading a permission screen, and short enough that a captured
 * state is nearly always already dead.
 */
const STATE_TTL_MS = 10 * 60_000;

export type StatePayload = {
  /** company_members.id the flow was started by. */
  memberId: string;
  /** The company that member belonged to at start. */
  companyId: string;
  provider: string;
  /** Random, also set in the cookie. Binds state to browser. */
  nonce: string;
  /** Epoch ms. */
  issuedAt: number;
  /** Where to send the browser after the callback finishes. */
  returnTo: string;
};

/**
 * Signing key.
 *
 * Falls back to the service-role key so the flow works without a new
 * environment variable — the same choice the unsubscribe links make. Rotating
 * either invalidates in-flight consent screens, whose consequence is a
 * recruiter seeing "that took too long, try again" rather than anything
 * incorrect being stored.
 */
function signingKey(): string | null {
  return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** A fresh nonce for the cookie. */
export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** `<base64url payload>.<signature>`, or null when nothing can sign it. */
export function encodeState(payload: StatePayload): string | null {
  const key = signingKey();
  if (!key) {
    console.error("[calendar] no signing key configured — refusing to start OAuth");
    return null;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, key)}`;
}

export type StateResult =
  | { ok: true; payload: StatePayload }
  | {
      ok: false;
      reason: "unsigned" | "malformed" | "bad_signature" | "expired" | "nonce_mismatch";
    };

/**
 * Verify a state string against the cookie nonce.
 *
 * Returns a REASON rather than throwing, so the callback can redirect to a
 * settings page with a legible message instead of rendering a stack trace at
 * someone who has just clicked "Allow".
 *
 * The signature is compared in constant time. The comparison is on two
 * base64url digests of fixed length, so an early length check leaks nothing
 * beyond "this is not a signature".
 */
export function verifyState(
  raw: string | null | undefined,
  cookieNonce: string | null,
): StateResult {
  const key = signingKey();
  if (!key) return { ok: false, reason: "unsigned" };

  const value = (raw ?? "").trim();
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const body = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const expected = sign(body, key);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    typeof payload?.memberId !== "string" ||
    typeof payload?.companyId !== "string" ||
    typeof payload?.nonce !== "string" ||
    typeof payload?.issuedAt !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) return { ok: false, reason: "expired" };

  // Constant-time again: the nonce is a secret of the same kind as the
  // signature, and a fast-path string compare here would undo the care above.
  const n1 = Buffer.from(payload.nonce);
  const n2 = Buffer.from(cookieNonce ?? "");
  if (n1.length !== n2.length || !timingSafeEqual(n1, n2)) {
    return { ok: false, reason: "nonce_mismatch" };
  }

  return { ok: true, payload };
}
