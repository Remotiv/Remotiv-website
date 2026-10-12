import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify that a webhook came from Recall.ai.
 *
 * ── The scheme (docs.recall.ai, "Verifying webhooks, websockets and
 *    callback requests") ──
 *
 * Recall signs through Svix, in the Standard Webhooks format:
 *
 *   signed content  `${id}.${timestamp}.${rawBody}`
 *   key             base64-decode of the secret after its `whsec_` prefix
 *   signature       base64(HMAC-SHA256(key, signed content))
 *   header          one or more space-separated `v1,<signature>` entries;
 *                   during a secret rotation Recall sends one per live secret
 *
 * ── Which headers, which secret ──
 *
 * A workspace created on or after 15 December 2025 (Remotiv's Tokyo workspace
 * is one) signs with its WORKSPACE VERIFICATION SECRET and sends
 * `webhook-id`, `webhook-timestamp`, `webhook-signature`. That secret, from
 * Recall dashboard > Developers > API Keys & Secrets > Create Workspace
 * Secret, is what RECALL_WEBHOOK_SECRET holds.
 *
 * An older workspace signs Svix webhooks with each endpoint's own signing
 * secret and sends `svix-*` headers. The algorithm is identical, so this
 * accepts that family too, but only with that endpoint's secret in the same
 * variable. The families are never mixed: an id from one and a signature from
 * the other is refused, because Svix signs one triple, not a blend.
 *
 * ── What this does not do ──
 *
 * It does not remember webhook ids. A captured request replayed within the
 * five-minute window verifies again; what keeps a replay harmless is that
 * every effect of an event is idempotent, not that it is refused.
 *
 * Pure apart from node:crypto. Never puts the secret, the key or a signature
 * into a returned value or an error.
 */

export const RECALL_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type HeaderReader = (name: string) => string | null;

export type VerifyResult =
  | { ok: true; id: string; timestamp: number; family: "webhook" | "svix" }
  | {
      ok: false;
      /**
       * no_secret, bad_secret: our configuration, not the sender's fault.
       * Everything else: the request did not prove it came from Recall.
       */
      reason:
        | "no_secret"
        | "bad_secret"
        | "missing_headers"
        | "mixed_headers"
        | "bad_timestamp"
        | "stale_timestamp"
        | "bad_signature";
    };

const FAMILIES = ["webhook", "svix"] as const;

function decodeSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("whsec_")) return null;
  const body = trimmed.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const key = Buffer.from(body, "base64");
  return key.length >= 16 ? key : null;
}

/** Pick one complete header family. Mixed or partial families are refused. */
function readFamily(
  header: HeaderReader,
):
  | { family: "webhook" | "svix"; id: string; timestamp: string; signature: string }
  | "missing"
  | "mixed" {
  const present = FAMILIES.map((family) => ({
    family,
    id: header(`${family}-id`),
    timestamp: header(`${family}-timestamp`),
    signature: header(`${family}-signature`),
  }));
  const complete = present.filter((p) => p.id && p.timestamp && p.signature);
  const partial = present.filter(
    (p) => (p.id || p.timestamp || p.signature) && !(p.id && p.timestamp && p.signature),
  );
  // Svix may send both families with identical values; prefer the standard one.
  const chosen = complete[0];
  if (chosen) {
    if (partial.length > 0) return "mixed";
    return {
      family: chosen.family,
      id: chosen.id as string,
      timestamp: chosen.timestamp as string,
      signature: chosen.signature as string,
    };
  }
  // Two families each half-present is a blend; one incomplete family is just missing headers.
  return partial.length > 1 ? "mixed" : "missing";
}

export function verifyRecallWebhook(input: {
  secret: string | undefined | null;
  header: HeaderReader;
  rawBody: string;
  nowMs: number;
}): VerifyResult {
  if (!input.secret?.trim()) return { ok: false, reason: "no_secret" };
  const key = decodeSecret(input.secret);
  if (!key) return { ok: false, reason: "bad_secret" };

  const headers = readFamily(input.header);
  if (headers === "missing") return { ok: false, reason: "missing_headers" };
  if (headers === "mixed") return { ok: false, reason: "mixed_headers" };

  if (!/^\d{1,12}$/.test(headers.timestamp)) return { ok: false, reason: "bad_timestamp" };
  const timestamp = Number(headers.timestamp);
  if (Math.abs(input.nowMs / 1000 - timestamp) > RECALL_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${input.rawBody}`, "utf8")
    .digest();

  for (const entry of headers.signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const provided = Buffer.from(entry.slice(comma + 1), "base64");
    // Length first: timingSafeEqual throws on unequal lengths.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true, id: headers.id, timestamp, family: headers.family };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
