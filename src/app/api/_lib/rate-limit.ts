/**
 * In-memory per-IP rate limiter for public API routes.
 *
 * Best-effort only — buckets live in process memory, so they reset on every
 * serverless cold start and aren't shared across regions. That's fine for
 * blocking the obvious "loop curl in a tight script" abuse pattern; for
 * proper protection put a real WAF / Upstash Redis layer in front.
 *
 * Defaults: 30 requests / minute / IP. Per-route overrides via the opts
 * argument — see /api/check-duplicate which raises the cap to 100/min
 * because a single email-typing user produces ~30 keystroke calls.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

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
  const key = `${opts?.bucketKey ?? "default"}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (bucket.count >= max) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count++;
  return { ok: true };
}

/**
 * Same in-memory limiter, keyed by an arbitrary caller-supplied string
 * instead of an IP from a Request object. Use this from server actions
 * (which have no Request) — typically with a key like `"unlock:" + userId`.
 *
 * Same in-memory caveats apply: per-lambda counters, reset on cold start,
 * not shared across regions. Good for burst protection; not a hard global cap.
 */
export function rateLimitByKey(
  key: string,
  opts?: { max?: number; windowMs?: number },
): RateLimitResult {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (bucket.count >= max) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count++;
  return { ok: true };
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
