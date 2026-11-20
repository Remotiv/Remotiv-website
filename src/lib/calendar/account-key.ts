import "server-only";
import { createHmac } from "node:crypto";

/**
 * Which calendar account an event lives in, without storing who it is (#56).
 *
 * A cleanup alert for a deleted applicant's leftover Google event may be
 * resolved automatically when the host reconnects Google, but only if it is
 * the SAME account: a silent delete against a different account answers 404
 * on a calendar it can read, which #61 counts as "already gone", and would
 * clear the alert while the event still sits in the old account.
 *
 * The key is an HMAC (SHA-256) with a server secret, never the address or the
 * id in the clear: Google's stable account id (userinfo `id`, the OpenID
 * `sub`) when the provider gave it, else the address, trimmed and lower-cased.
 * Domain-separated, so the same secret's other uses never collide with it.
 *
 * The secret is GOOGLE_CALENDAR_CLIENT_SECRET, present exactly where this
 * runs. Rotating it changes every key: old records then never match, so they
 * are only ever resolved by hand, which is the safe direction. With no secret
 * there is no key ("" in the tables): nothing auto-resolves.
 */
const DOMAIN = "remotiv:calendar-account-key:v1";

function secret(): string | null {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET || null;
}

function hmac(material: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`${DOMAIN}:${material}`).digest("hex");
}

/** The key from the provider's stable account id. */
export function accountKeyFromId(provider: string, accountId: string | null | undefined) {
  const id = (accountId ?? "").trim();
  return id ? hmac(`${provider}:id:${id}`) : null;
}

/** The key from the account's address, when no stable id was known. */
export function accountKeyFromEmail(provider: string, email: string | null | undefined) {
  const address = (email ?? "").trim().toLowerCase();
  return address ? hmac(`${provider}:email:${address}`) : null;
}

/** The key to store: the id's when known, else the address's, else null. */
export function accountKeyFor(
  provider: string,
  account: { accountId?: string | null; email?: string | null },
): string | null {
  return (
    accountKeyFromId(provider, account.accountId) ?? accountKeyFromEmail(provider, account.email)
  );
}

/**
 * Every key this account may have been stored under: by id and by address.
 * A connection made before ids were kept stored the address's key, so a
 * reconnect matches either, never a different account's.
 */
export function accountKeysOf(
  provider: string,
  account: { accountId?: string | null; email?: string | null },
): string[] {
  return [
    accountKeyFromId(provider, account.accountId),
    accountKeyFromEmail(provider, account.email),
  ].filter((k): k is string => Boolean(k));
}
