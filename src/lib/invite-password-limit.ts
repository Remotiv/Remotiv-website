import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

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

/** The store this deployment uses; exported so the choice itself is tested. */
export function defaultAttemptStore(env: Record<string, string | undefined>): AttemptStore {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return redisAttemptStore(
      new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
    );
  }
  if (env.VERCEL_ENV === "production") {
    // Production without a shared store: refuse rather than count per instance.
    return {
      async increment() {
        throw new Error("no shared store");
      },
      async clear() {},
    };
  }
  return memoryAttemptStore();
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
export async function reserveInvitePasswordAttempt(email: string): Promise<ReserveResult> {
  let count: number;
  try {
    count = await store.increment(invitePasswordKey(email), INVITE_PASSWORD_LOCK_MS);
  } catch {
    console.error("[invite-password-limit] attempt store unavailable; attempt refused");
    return { ok: false, reason: "unavailable" };
  }
  if (count > INVITE_PASSWORD_MAX_ATTEMPTS) {
    return {
      ok: false,
      reason: "locked",
      retryAfterSeconds: Math.ceil(INVITE_PASSWORD_LOCK_MS / 1000),
    };
  }
  return { ok: true };
}

/** A correct password: the account's count starts again. */
export async function clearInvitePasswordAttempts(email: string): Promise<void> {
  // Best effort: a failed clear leaves the count to expire on its own.
  await store.clear(invitePasswordKey(email)).catch(() => {
    console.error("[invite-password-limit] could not clear an account's count");
  });
}
