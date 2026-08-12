import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Authenticity checks for the WhatsApp Cloud API webhook.
 *
 * ── Why this is a module and not four lines in the route ─────
 *
 * This endpoint is PUBLIC and unauthenticated. There is no session, no cookie
 * and no bearer token — the signature is the only thing between Meta and
 * anybody who finds the URL, and the URL is not a secret (it is pasted into
 * Meta's dashboard and appears in their logs). Everything that decides whether
 * a payload is trustworthy lives here, in one place, so it can be read as a
 * unit rather than reconstructed from a route handler.
 *
 * Nothing in this file logs, returns or embeds a secret in an error. A
 * comparison result is a boolean and never says which side was wrong.
 */

/**
 * Constant-time string equality.
 *
 * Same shape as the worker route's `secretMatches`: length mismatch cannot
 * short-circuit, because `timingSafeEqual` throws on unequal lengths and that
 * throw would itself leak the expected length. The reject path burns an
 * equivalent comparison so it costs roughly the same as the accept path.
 */
export function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Verify Meta's `X-Hub-Signature-256` over the RAW request body.
 *
 * ── The raw body is load-bearing ─────────────────────────────
 *
 * The HMAC is computed over the exact bytes Meta sent. Parsing to JSON and
 * re-serialising changes key order, whitespace and unicode escaping, so a
 * signature checked against `JSON.stringify(parsed)` fails for valid requests
 * and — worse — tempts whoever debugs it into removing the check. The caller
 * must read `await request.text()` ONCE and pass that string here before
 * parsing it.
 *
 * Returns false rather than throwing on every failure mode: a malformed
 * header, a missing secret, a wrong digest. The route turns that into one
 * indistinguishable 403, so a prober cannot tell a bad signature from an
 * unconfigured server.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !signatureHeader) return false;

  // Meta sends `sha256=<hex>`. Anything else is not a signature we understand,
  // and guessing at the format is how a check gets weakened.
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return constantTimeEquals(provided.toLowerCase(), expected);
}
