import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe links, authenticated WITHOUT a login.
 *
 * A candidate has no Remotiv account, so the link has to prove on its own that
 * we issued it. It carries a base64url payload of `companyId:email` plus an
 * HMAC-SHA256 signature over that exact string.
 *
 * That gives three properties:
 *
 *   - Unforgeable. Without the secret you cannot mint a token, so nobody can
 *     opt somebody else out by guessing a URL.
 *   - Scoped. The signature covers the COMPANY id as well as the address, so a
 *     link from one company can never opt the candidate out of another's mail.
 *   - Stateless. No token table, no expiry to manage, and the link keeps
 *     working in an email somebody opens six months later — which is exactly
 *     when people unsubscribe.
 *
 * Deliberately NOT encrypted, only signed: the address is already visible to
 * whoever received the mail, so confidentiality buys nothing while
 * integrity is the whole requirement.
 */

/**
 * Signing key. A dedicated secret is preferred; the service-role key is the
 * fallback so this cannot silently ship unsigned in an environment that has not
 * added the new variable yet. Both are server-only and high entropy.
 *
 * Rotating the secret invalidates outstanding links — acceptable, since the
 * consequence is a candidate seeing "this link is no longer valid" rather than
 * anything being wrongly opted out.
 */
function signingKey(): string | null {
  return (
    process.env.EMAIL_UNSUBSCRIBE_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    null
  );
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** `<payload>.<signature>`, or null when no signing key is configured. */
export function makeUnsubscribeToken(
  companyId: string,
  email: string,
): string | null {
  const key = signingKey();
  if (!key) {
    console.error("[unsubscribe] no signing key configured — link omitted");
    return null;
  }
  const payload = b64url(`${companyId}:${email.trim().toLowerCase()}`);
  return `${payload}.${sign(payload, key)}`;
}

export type UnsubscribeClaim = { companyId: string; email: string };

/**
 * Verify and decode a token.
 *
 * Compared with timingSafeEqual rather than `===`. The window is small, but a
 * string compare on a signature leaks its prefix through timing and there is no
 * reason to hand that away for the sake of one operator.
 */
export function readUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const key = signingKey();
  if (!key) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }

  // The email may legitimately contain no colon, but the company id never
  // does — so split on the FIRST one only.
  const idx = decoded.indexOf(":");
  if (idx <= 0) return null;
  const companyId = decoded.slice(0, idx);
  const email = decoded.slice(idx + 1);
  if (!companyId || !email) return null;
  return { companyId, email };
}

/** Absolute unsubscribe URL, or null when a token could not be minted. */
export function unsubscribeUrl(companyId: string, email: string): string | null {
  const token = makeUnsubscribeToken(companyId, email);
  if (!token) return null;
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://remotiv.work";
  return `${base}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}
