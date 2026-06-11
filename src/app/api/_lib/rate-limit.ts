/**
 * Per-IP rate limiter for public API routes.
 *
 * Primary store: Upstash Redis — shared across all serverless instances and
 * regions, so a spammer can't multiply the limit by fanning requests out
 * across lambdas (the old failure mode of the pure in-memory version).
 *
 * Design: every caller invokes rateLimit() SYNCHRONOUSLY (no await at any
 * call site), but Redis is a network hop. So the decision is write-behind:
 *   1. The allow/block answer comes from a local in-memory bucket, instantly.
 *   2. Each allowed request also fires an async INCR against a shared Redis
 *      counter keyed by (bucket, epoch-aligned window).
 *   3. When the INCR response arrives, the GLOBAL count is folded back into
 *      the local bucket — so other instances' traffic raises this instance's
 *      count within ~one Redis round-trip.
 * Net effect: cross-instance enforcement lags by a few tens of ms; an
 * attacker can squeeze a handful of extra requests per instance, but nothing
 * like the old (instances × max) multiplier. Redis being down or slow simply
 * degrades to the previous per-instance behaviour — never blocks the request
 * path, never throws.
 *
 * Fallback: when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not
 * set (e.g. local dev without a Redis account), `redis` is null and the
 * limiter runs in-memory only — local dev keeps working with zero setup.
 *
 * Defaults: 30 requests / minute / IP. Per-route overrides via the opts
 * argument — see /api/check-duplicate which raises the cap to 100/min
 * because a single email-typing user produces ~30 keystroke calls.
 */

import { Redis } from "@upstash/redis";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

// Shared store across all instances; null → in-memory fallback (local dev).
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * Fire-and-forget: bump the shared counter for this (key, window) and fold
 * the global count back into the local bucket once the response arrives.
 * Errors are swallowed — Redis being unreachable must degrade to
 * per-instance limiting, never break the request path.
 */
function syncRemoteCount(key: string, windowMs: number, resetAt: number): void {
  if (!redis) return;
  const redisKey = `rl:${key}:${resetAt}`;
  redis
    .incr(redisKey)
    .then((remoteCount) => {
      if (remoteCount === 1) {
        // First increment in this window — self-cleaning TTL, with 1s slack
        // so the key outlives the window boundary.
        redis.pexpire(redisKey, windowMs + 1_000).catch(() => {});
      }
      const bucket = buckets.get(key);
      if (bucket && bucket.resetAt === resetAt && remoteCount > bucket.count) {
        bucket.count = remoteCount;
      }
    })
    .catch(() => {});
}

function check(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  // Epoch-aligned window end so every instance derives the SAME Redis key
  // for the same wall-clock window. (A first-request-anchored window would
  // give each lambda its own boundary and the counts could never merge.)
  const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt !== resetAt) {
    buckets.set(key, { count: 1, resetAt });
    syncRemoteCount(key, windowMs, resetAt);
    return { ok: true };
  }

  if (bucket.count >= max) {
    return { ok: false, retryAfter: Math.ceil((resetAt - now) / 1000) };
  }

  bucket.count++;
  syncRemoteCount(key, windowMs, resetAt);
  return { ok: true };
}

export function rateLimit(
  request: Request,
  opts?: { max?: number; windowMs?: number; bucketKey?: string },
): RateLimitResult {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  // Distinct bucket per (route, ip) pair so the per-route override doesn't
  // share state with another route's stricter limit.
  return check(`${opts?.bucketKey ?? "default"}:${ip}`, max, windowMs);
}

/**
 * Same limiter, keyed by an arbitrary caller-supplied string instead of an
 * IP from a Request object. Use this from server actions (which have no
 * Request) — typically with a key like `"unlock:" + userId`.
 *
 * Shares the same Redis write-behind path as rateLimit(), so the count is
 * global across instances (with the same ~one-round-trip lag).
 */
export function rateLimitByKey(
  key: string,
  opts?: { max?: number; windowMs?: number },
): RateLimitResult {
  return check(key, opts?.max ?? DEFAULT_MAX, opts?.windowMs ?? DEFAULT_WINDOW_MS);
}

// Periodic GC so the Map doesn't grow unbounded under steady traffic. Stored
// on globalThis so HMR doesn't double-register the interval in dev.
type RLGlobal = typeof globalThis & { __rateLimitCleanup?: NodeJS.Timeout };
const g = globalThis as RLGlobal;
if (!g.__rateLimitCleanup) {
  g.__rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }, 5 * 60_000);
}
