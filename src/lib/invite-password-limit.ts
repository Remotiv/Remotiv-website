import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import {
  redisCredentialPair,
  redisReasonCode,
  storeChoice,
  storeChoiceLine,
} from "@/app/api/_lib/redis-diagnostics";

/**
 * Password attempts on the team-invitation accept page (task #48, QA-SAFETY-40
 * T-2).
 *
 * When an invitation goes to an address that already has a Remotiv login,
 * acceptInvite proves ownership with that account's password, through a
 * cookie-bound client: a correct guess signs the guessing browser in. The only
 * throttle used to be 10 a minute per TOKEN, and every Resend or new
 * invitation mints a new token, so an admin could keep guessing an existing
 * user's password by re-inviting them.
 *
 * This limit is keyed on the ACCOUNT being guessed: the SHA-256 of the invited
 * address, trimmed and lower-cased (acceptInvite binds the account to that
 * address and nothing else). It is the same key whichever invitation, Resend or
 * company the attempt arrives through.
 *
 * ATOMIC BY RESERVATION, not by counting failures after the fact. Each attempt
 * takes a slot BEFORE the password is checked: one INCR that also re-arms the
 * expiry, in a single Redis script, so N concurrent requests get N distinct
 * counts and at most INVITE_PASSWORD_MAX_ATTEMPTS of them ever reach the
 * password check. A correct password clears the count. The expiry is re-armed
 * on every attempt, so the lock lasts INVITE_PASSWORD_LOCK_MS after the LAST
 * attempt: guessing through the lock keeps it locked.
 *
 * STORE. Upstash Redis when it is configured (production), which is shared by
 * every serverless instance: the count lives in Redis, and Redis runs each
 * script to completion before the next command, so two instances can never
 * read the same count. Without Redis (local dev, staging) a per-process counter
 * whose increment is synchronous, so it is atomic within the one process that
 * serves those environments.
 *
 * LOGS (names and reason codes only, never a value): the store chosen, once
 * at module load, `[invite-password-limit] store=redis source=upstash|kv`,
 * `store=memory` or `store=production-without-redis missing=...`; each refused attempt,
 * `[invite-password-limit] attempt refused reason=<CODE>` (`code send refused`,
 * `code check refused` for the email code, #51), with the codes of
 * api/_lib/redis-diagnostics.ts.
 *
 * FAILS CLOSED. If the shared store cannot answer (Redis configured but
 * unreachable, or a Vercel production deployment with no Redis configured),
 * the attempt is REFUSED: the password is not checked and the invitation is
 * not spent. A limiter that silently became per-instance, or disappeared,
 * would hand back exactly the guessing this exists to stop.
 *
 * Unlike api/_lib/rate-limit.ts, which decides locally and syncs to Redis after
 * the fact, this one waits for the shared count before deciding. That costs one
 * Redis round trip on an attempt that is already a password check.
 */

export const INVITE_PASSWORD_MAX_ATTEMPTS = 10;
export const INVITE_PASSWORD_LOCK_MS = 15 * 60 * 1000;

export type AttemptStore = {
  /** Count one attempt for `key`, (re)arm its expiry, and return the new count. */
  increment(key: string, ttlMs: number): Promise<number>;
  clear(key: string): Promise<void>;
};

/** INCR and PEXPIRE in one script: Redis runs a script atomically. */
const INCREMENT_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) redis.call('PEXPIRE', KEYS[1], ARGV[1]) return c";

export function redisAttemptStore(redis: Redis): AttemptStore {
  return {
    async increment(key, ttlMs) {
      const count = Number(await redis.eval(INCREMENT_SCRIPT, [key], [String(ttlMs)]));
      if (!Number.isInteger(count) || count < 1) throw new Error("bad count");
      return count;
    },
    async clear(key) {
      await redis.del(key);
    },
  };
}

/** No timers: an expired entry is dropped when it is next touched, or in a sweep. */
export function memoryAttemptStore(now: () => number = Date.now): AttemptStore {
  const entries = new Map<string, { count: number; expiresAt: number }>();
  return {
    async increment(key, ttlMs) {
      const t = now();
      if (entries.size > 10_000) {
        for (const [k, e] of entries) if (e.expiresAt <= t) entries.delete(k);
      }
      const e = entries.get(key);
      const count = e && e.expiresAt > t ? e.count + 1 : 1;
      entries.set(key, { count, expiresAt: t + ttlMs });
      return count;
    },
    async clear(key) {
      entries.delete(key);
    },
  };
}

/** The prefix of every line this module writes. Lines carry names and reason codes, never values. */
const LOG = "[invite-password-limit]";

/** Thrown by the production store that has no Redis: logged as reason=NO_STORE. */
class NoSharedStoreError extends Error {
  name = "NoSharedStoreError";
}

/**
 * A Redis store whose client is built on FIRST USE, inside the caller's try:
 * a bad URL (the client constructor throws UrlError on one) becomes a logged,
 * fail-closed refusal of that attempt instead of a crash when the module
 * loads, which would take the whole accept action down, or during a build.
 * A constructor that threw is retried on the next attempt.
 */
function lazyRedisAttemptStore(url: string, token: string): AttemptStore {
  let inner: AttemptStore | null = null;
  const get = () => {
    inner ??= redisAttemptStore(new Redis({ url, token }));
    return inner;
  };
  return {
    async increment(key, ttlMs) {
      return get().increment(key, ttlMs);
    },
    async clear(key) {
      return get().clear(key);
    },
  };
}

/**
 * The store this deployment uses; exported so the choice itself is tested.
 * Credentials come as a COMPLETE pair (redisCredentialPair): the
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN pair, else the
 * KV_REST_API_URL + KV_REST_API_TOKEN pair, never one name from each. A
 * mixed or partial setup is "no Redis": memory in dev, a refusal in
 * production, and the store line names what is missing.
 */
export function defaultAttemptStore(env: Record<string, string | undefined>): AttemptStore {
  const creds = redisCredentialPair(env, { kvFallback: true });
  if (creds) return lazyRedisAttemptStore(creds.url, creds.token);
  if (env.VERCEL_ENV === "production") {
    // Production without a shared store: refuse rather than count per instance.
    return {
      async increment() {
        throw new NoSharedStoreError("no shared store");
      },
      async clear() {},
    };
  }
  return memoryAttemptStore();
}

/** The line written once at module load: which store, by names only. */
export function inviteStoreLine(env: Record<string, string | undefined>): string {
  return storeChoiceLine(storeChoice(env, { kvFallback: true }), LOG, { withSource: true });
}

if (process.env.NEXT_PHASE !== "phase-production-build") {
  console.info(inviteStoreLine(process.env));
}

let store: AttemptStore = defaultAttemptStore(process.env);

/** Tests only: swap the store (and with it the clock). */
export function setInvitePasswordStoresForTests(next: AttemptStore) {
  store = next;
}

export function invitePasswordKey(email: string): string {
  return `invite-pw:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: "locked"; retryAfterSeconds: number }
  | { ok: false; reason: "unavailable" };

/** Take an attempt slot for this account. Refused once locked, or if the count cannot be taken. */
export function reserveInvitePasswordAttempt(email: string): Promise<ReserveResult> {
  return reserve(invitePasswordKey(email), INVITE_PASSWORD_MAX_ATTEMPTS, "attempt");
}

/**
 * The email code every invitation acceptance now requires (#51) uses the SAME
 * store, the same atomic reservation and the same fail-closed rule, under two
 * more keys per invited address: one for sending a code (each send is an email
 * to that address, so an admin re-inviting cannot flood it) and one for
 * checking a code (a wrong guess costs a slot BEFORE the code reaches Supabase).
 * Keyed on the address like the password count, so a Resend or another
 * company's invitation shares the budget.
 */
export const INVITE_CODE_SEND_MAX = 5;
export const INVITE_CODE_VERIFY_MAX = 10;

export function inviteCodeKey(kind: "send" | "verify", email: string): string {
  return `invite-code-${kind}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

async function reserve(key: string, max: number, what: string): Promise<ReserveResult> {
  let count: number;
  try {
    count = await store.increment(key, INVITE_PASSWORD_LOCK_MS);
  } catch (err) {
    console.error(`${LOG} ${what} refused reason=${redisReasonCode(err)}`);
    return { ok: false, reason: "unavailable" };
  }
  if (count > max) {
    return {
      ok: false,
      reason: "locked",
      retryAfterSeconds: Math.ceil(INVITE_PASSWORD_LOCK_MS / 1000),
    };
  }
  return { ok: true };
}

/** One code email to this address. Refused once 5 have gone in the window, or if the count cannot be taken. */
export function reserveInviteCodeSend(email: string): Promise<ReserveResult> {
  return reserve(inviteCodeKey("send", email), INVITE_CODE_SEND_MAX, "code send");
}

/** One code check for this address. Refused once 10 have been tried in the window, or if the count cannot be taken. */
export function reserveInviteCodeVerify(email: string): Promise<ReserveResult> {
  return reserve(inviteCodeKey("verify", email), INVITE_CODE_VERIFY_MAX, "code check");
}

/** A correct code: the address's check count starts again. The send count is left to expire. */
export async function clearInviteCodeVerify(email: string): Promise<void> {
  await store.clear(inviteCodeKey("verify", email)).catch((err) => {
    console.error(`${LOG} clear failed reason=${redisReasonCode(err)}`);
  });
}

/**
 * ONE password budget per account (#58): the invitation page (#48), the
 * company dashboard sign-in and the settings re-check all take their slot
 * from invitePasswordKey, so guessing through one of them uses up the others.
 * The dashboard paths also take a slot per IP: 50 attempts in the same
 * sliding 15 minutes, never cleared by a success, so an office behind one
 * address still signs in but one machine cannot spray many accounts.
 */
export const SIGN_IN_IP_MAX_ATTEMPTS = 50;

export function signInIpKey(ip: string): string {
  return `signin-ip:${createHash("sha256").update(ip.trim()).digest("hex")}`;
}

export type SignInReserve =
  | { ok: true }
  | { ok: false; reason: "locked" }
  | { ok: false; reason: "unavailable" };

/**
 * A slot for one password check: the IP's first (a refused IP spends nothing
 * of the account's), then the account's. No trusted IP is a refusal, logged
 * as reason=NO_TRUSTED_IP; a store that cannot answer is a refusal too.
 */
export async function reserveSignInAttempt(input: {
  email: string;
  ip: string | null;
}): Promise<SignInReserve> {
  if (!input.ip) {
    console.error(`${LOG} sign-in refused reason=NO_TRUSTED_IP`);
    return { ok: false, reason: "unavailable" };
  }
  const byIp = await reserve(signInIpKey(input.ip), SIGN_IN_IP_MAX_ATTEMPTS, "sign-in ip");
  if (!byIp.ok) return { ok: false, reason: byIp.reason };
  const byAccount = await reserveInvitePasswordAttempt(input.email);
  if (!byAccount.ok) return { ok: false, reason: byAccount.reason };
  return { ok: true };
}

/** A correct password on the dashboard: the ACCOUNT's count starts again, never the IP's. */
export async function clearSignInAttempts(email: string): Promise<void> {
  await clearInvitePasswordAttempts(email);
}

/** A correct password: the account's count starts again. */
export async function clearInvitePasswordAttempts(email: string): Promise<void> {
  // Best effort: a failed clear leaves the count to expire on its own.
  await store.clear(invitePasswordKey(email)).catch((err) => {
    console.error(`${LOG} clear failed reason=${redisReasonCode(err)}`);
  });
}
