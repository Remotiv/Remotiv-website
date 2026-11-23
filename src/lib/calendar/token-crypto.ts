import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Google Calendar tokens sealed at rest (#68, step 12a).
 *
 * AES-256-GCM, a fresh random 12-byte IV per seal, a 16-byte tag. The sealed
 * text carries everything needed to open it except the key:
 *
 *   v1.<key id>.<iv>.<tag>.<ciphertext>      (base64url, dot-separated)
 *
 * ── Bound to its row ─────────────────────────────────────────
 *
 * The additional authenticated data is the row the token belongs to
 * (tokenAad: connection id | member id | provider) plus the version and key
 * id. A sealed token copied onto another row, or another member's, or another
 * provider's, does not open: it is not that row's token.
 *
 * ── Keys ─────────────────────────────────────────────────────
 *
 * CALENDAR_TOKEN_KEYS: JSON, { "<key id>": "<base64 of 32 random bytes>" }.
 * CALENDAR_TOKEN_KEY_CURRENT: the id that seals. Every listed key opens, so a
 * rotation adds a key, points CURRENT at it, re-seals the rows on the old id
 * (token_key_id finds them), and only then removes the old key.
 *
 * ── Failing closed ───────────────────────────────────────────
 *
 * Anything wrong (no keys, a key that is not 32 bytes, an unknown key id, a
 * malformed or tampered value, the wrong row) throws TokenCryptoError with a
 * reason code and nothing else: never the key, the token or the sealed value.
 * This module logs nothing; a caller logs the reason code.
 *
 * Not wired in yet: 12a adds this and the columns (migration 073) only. How
 * the app reads and writes tokens changes in 12b.
 */

export type TokenCryptoReason =
  | "keys_missing"
  | "keys_invalid"
  | "current_key_missing"
  | "unknown_key"
  | "aad_invalid"
  | "plaintext_invalid"
  | "malformed"
  | "auth_failed";

export class TokenCryptoError extends Error {
  readonly reason: TokenCryptoReason;
  constructor(reason: TokenCryptoReason) {
    super(`calendar token crypto failed: ${reason}`);
    this.name = "TokenCryptoError";
    this.reason = reason;
  }
}

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AAD_DOMAIN = "remotiv:calendar-token";

/** The row a token belongs to, as the additional authenticated data. */
export function tokenAad(row: { id: string; memberId: string; provider: string }): string {
  const parts = [row.id, row.memberId, row.provider];
  if (parts.some((p) => typeof p !== "string" || p === "" || p.includes("|"))) {
    throw new TokenCryptoError("aad_invalid");
  }
  return parts.join("|");
}

function keys(): { byId: Map<string, Buffer>; current: string } {
  const raw = process.env.CALENDAR_TOKEN_KEYS;
  if (!raw) throw new TokenCryptoError("keys_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TokenCryptoError("keys_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TokenCryptoError("keys_invalid");
  }
  const byId = new Map<string, Buffer>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!KEY_ID.test(id) || typeof value !== "string") throw new TokenCryptoError("keys_invalid");
    const key = Buffer.from(value, "base64");
    // A strict decode: Buffer.from skips characters it cannot read, so a
    // mangled value must also round-trip to count as 32 bytes.
    if (key.length !== KEY_BYTES || key.toString("base64") !== value.trim()) {
      throw new TokenCryptoError("keys_invalid");
    }
    byId.set(id, key);
  }
  if (byId.size === 0) throw new TokenCryptoError("keys_missing");
  const current = process.env.CALENDAR_TOKEN_KEY_CURRENT ?? "";
  if (!byId.has(current)) throw new TokenCryptoError("current_key_missing");
  return { byId, current };
}

function aadBytes(header: string, aad: string): Buffer {
  if (typeof aad !== "string" || aad === "") throw new TokenCryptoError("aad_invalid");
  return Buffer.from(`${AAD_DOMAIN}|${header}|${aad}`, "utf8");
}

const b64 = (b: Buffer) => b.toString("base64url");

function fromB64(part: string, bytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new TokenCryptoError("malformed");
  const out = Buffer.from(part, "base64url");
  if (bytes !== undefined && out.length !== bytes) throw new TokenCryptoError("malformed");
  return out;
}

/** Seal a token for one row (tokenAad) under the current key. */
export function seal(plaintext: string, aad: string): string {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new TokenCryptoError("plaintext_invalid");
  }
  const { byId, current } = keys();
  const header = `${VERSION}.${current}`;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, byId.get(current) as Buffer, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aadBytes(header, aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${header}.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

/** Open a sealed token for the same row it was sealed for; any key listed opens. */
export function open(sealed: string, aad: string): string {
  if (typeof sealed !== "string") throw new TokenCryptoError("malformed");
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION || !KEY_ID.test(parts[1])) {
    throw new TokenCryptoError("malformed");
  }
  const [version, keyId, ivPart, tagPart, ctPart] = parts;
  const iv = fromB64(ivPart, IV_BYTES);
  const tag = fromB64(tagPart, TAG_BYTES);
  const ct = fromB64(ctPart);
  if (ct.length === 0) throw new TokenCryptoError("malformed");
  const key = keys().byId.get(keyId);
  if (!key) throw new TokenCryptoError("unknown_key");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadBytes(`${version}.${keyId}`, aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenCryptoError("auth_failed");
  }
}

/** The key id a sealed value names (for token_key_id), or null when it is not one. */
export function sealedKeyId(sealed: string): string | null {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  return parts.length === 5 && parts[0] === VERSION && KEY_ID.test(parts[1]) ? parts[1] : null;
}
