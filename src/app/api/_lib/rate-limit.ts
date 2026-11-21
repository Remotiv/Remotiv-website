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
 * Fallback: with no complete credential pair (UPSTASH_REDIS_REST_URL +
 * UPSTASH_REDIS_REST_TOKEN, else KV_REST_API_URL + KV_REST_API_TOKEN, never one
 * name from each), or a pair the client refuses, there is no Redis client and
 * the limiter runs in-memory only. Local dev keeps working with zero setup.
 *
 * Defaults: 30 requests / minute / IP. Per-route overrides via the opts
 * argument — see /api/check-duplicate which raises the cap to 100/min
 * because a single email-typing user produces ~30 keystroke calls.
 */

import { Redis } from "@upstash/redis";
import {
  LOG_PREFIX,
  redisCheckLine,
  redisCredentialPair,
  redisReasonCode,
  storeChoice,
  storeChoiceLine,
  throttledFailureLog,
} from "@/app/api/_lib/redis-diagnostics";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

/**
 * The shared store's client, built on FIRST USE inside a try (#57), the way
 * invite-password-limit.ts builds #48's. It used to be built while this module
 * loaded (Redis.fromEnv()), and the client's constructor throws UrlError on a
 * malformed URL, so one bad setting threw out of the import: every route that
 * limits (41 call sites) and `next build` with it, and the error's message is
 * the URL itself, which then sat in the build log.
 *
 * Now a refused client is one line, `[rate-limit] redis-client=failed
 * reason=BADURL` (a reason code, never the message), and the limiter runs in
 * memory, as it does with no Redis configured. Settings do not change inside a
 * running instance, so the answer is kept for its life: no retry, no repeated
 * line. Credentials only as a complete pair (redisCredentialPair).
 */
let client: Redis | null | undefined;
function redisClient(): Redis | null {
  if (client !== undefined) return client;
  const creds = redisCredentialPair(process.env, { kvFallback: true });
  client = null;
  if (!creds) return client;
  try {
    client = new Redis({ url: creds.url, token: creds.token });
  } catch (err) {
    console.error(`${LOG_PREFIX} redis-client=failed reason=${redisReasonCode(err)}`);
  }
  return client;
}

/**
 * The PUBLIC group's own database (#57 slice 2): public forms and reads count
 * here, so a bot burst spends this database's budget, never the main one the
 * security and interview limits depend on.
 *
 * Read from RATE_LIMIT_PUBLIC_REDIS_REST_URL + RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN
 * ONLY, as a complete pair. There is deliberately no fallback to UPSTASH_* or
 * KV_* and no path to redisClient(): this function returns its own client or
 * none. A pair that names the main database (either URL or either token) is
 * treated as missing. Without a client the public group runs in this
 * instance's memory, which is the per-instance limiting every route had before
 * Redis, and one store line says why.
 */
const PUBLIC_URL_VAR = "RATE_LIMIT_PUBLIC_REDIS_REST_URL";
const PUBLIC_TOKEN_VAR = "RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN";

export type PublicStoreChoice =
  | { store: "redis"; url: string; token: string }
  | { store: "memory"; reason: "PUBLIC_CREDS_MISSING" | "PUBLIC_SAME_AS_SECURITY" };

const normalUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

export function publicStoreChoice(env: Record<string, string | undefined>): PublicStoreChoice {
  const url = env[PUBLIC_URL_VAR]?.trim();
  const token = env[PUBLIC_TOKEN_VAR]?.trim();
  if (!url || !token) return { store: "memory", reason: "PUBLIC_CREDS_MISSING" };
  const mainUrls = [env.UPSTASH_REDIS_REST_URL, env.KV_REST_API_URL]
    .filter((u): u is string => !!u)
    .map(normalUrl);
  const mainTokens = [env.UPSTASH_REDIS_REST_TOKEN, env.KV_REST_API_TOKEN].map((t) => t?.trim());
  if (mainUrls.includes(normalUrl(url)) || mainTokens.includes(token)) {
    return { store: "memory", reason: "PUBLIC_SAME_AS_SECURITY" };
  }
  return { store: "redis", url, token };
}

/** The public store line, by reason code only. */
export function publicStoreLine(choice: PublicStoreChoice): string {
  return choice.store === "redis"
    ? `${LOG_PREFIX} public-store=redis`
    : `${LOG_PREFIX} public-store=memory reason=${choice.reason}`;
}

let publicClient: Redis | null | undefined;
function publicRedisClient(): Redis | null {
  if (publicClient !== undefined) return publicClient;
  const choice = publicStoreChoice(process.env);
  publicClient = null;
  if (choice.store !== "redis") return publicClient;
  try {
    publicClient = new Redis({ url: choice.url, token: choice.token });
  } catch (err) {
    console.error(`${LOG_PREFIX} public-redis-client=failed reason=${redisReasonCode(err)}`);
  }
  return publicClient;
}

/*
 * Diagnostics only (#48 / #57): which store this instance picked, and whether
 * Redis answers, once per cold start; Redis errors at most once a minute. No
 * decision reads any of this, and no line carries a value
 * (redis-diagnostics.ts). Skipped while `next build` loads modules.
 */
const diagnosticsOn = process.env.NEXT_PHASE !== "phase-production-build";
if (diagnosticsOn) {
  console.info(storeChoiceLine(storeChoice(process.env, { kvFallback: true })));
  const redis = redisClient();
  if (redis) void redisCheckLine(redis).then((line) => console.info(line));
  // Without its own database in production the public group is per-instance:
  // an error line, so it is seen.
  const publicChoice = publicStoreChoice(process.env);
  const inProduction = process.env.VERCEL_ENV === "production";
  (publicChoice.store === "memory" && inProduction ? console.error : console.info)(
    publicStoreLine(publicChoice),
  );
}
const logSyncFailure = throttledFailureLog((line) => console.error(line));

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * A limit's group (#57): which store it counts in, and its Redis error lines.
 *
 *   interview  the main database (slice 1)
 *   public     the public database only (publicRedisClient), never the main one
 *   local      no Redis at all: noisy buckets a shared count buys nothing for
 *   security   the main database, failing OPEN to memory (slice 3: CV views,
 *              talent unlock and save). The fail-CLOSED security limits do not
 *              take a group: they call rateLimitClosed / rateLimitClosedByKey.
 *
 * A grouped limit's Redis errors are written per route, at most one line a
 * minute, the next line carrying how many were held back:
 *
 *   [rate-limit] redis-error route=<route> group=<group> outcome=<open|closed> reason=<CODE> [suppressed=<N>]
 *
 * `route` is the key up to its first ":" (the constant part, never the token,
 * id or IP after it). `outcome=open`: the request was decided from this
 * instance's memory; `outcome=closed`: it was refused. Never the token, IP,
 * user id, URL or error text.
 */
export type RateLimitGroup = "interview" | "public" | "local" | "security";

/** The constant route part of a key; "unknown" if it does not look like one. */
function routeOf(key: string): string {
  const route = key.split(":", 1)[0];
  return /^[a-z0-9-]{1,64}$/.test(route) ? route : "unknown";
}

const GROUP_LOG_INTERVAL_MS = 60_000;
/** Per route: when its last line was written, and how many errors since were held back. */
const groupLogs = new Map<string, { last: number; suppressed: number }>();

function groupFailureLog(
  key: string,
  group: RateLimitGroup,
  outcome: "open" | "closed" = "open",
): (err: unknown) => void {
  return (err) => {
    const route = routeOf(key);
    const now = Date.now();
    const state = groupLogs.get(route);
    if (state && now - state.last < GROUP_LOG_INTERVAL_MS) {
      state.suppressed++;
      return;
    }
    const held = state?.suppressed ? ` suppressed=${state.suppressed}` : "";
    groupLogs.set(route, { last: now, suppressed: 0 });
    console.error(
      `${LOG_PREFIX} redis-error route=${route} group=${group} outcome=${outcome} reason=${redisReasonCode(err)}${held}`,
    );
  };
}

/** The store a group counts in: the public group only ever gets the public client. */
function storeFor(group: RateLimitGroup | undefined): Redis | null {
  if (group === "local") return null;
  if (group === "public") return publicRedisClient();
  return redisClient();
}

/**
 * Fire-and-forget: bump the shared counter for this (key, window) and fold
 * the global count back into the local bucket once the response arrives.
 * Errors never reach the request — Redis being unreachable must degrade to
 * per-instance limiting, never break the request path — but they are logged
 * as a reason code, at most once a minute (redis-diagnostics.ts).
 */
function syncRemoteCount(
  key: string,
  windowMs: number,
  resetAt: number,
  group: RateLimitGroup | undefined,
  onError: (err: unknown) => void,
): void {
  const redis = storeFor(group);
  if (!redis) return;
  const redisKey = `rl:${key}:${resetAt}`;
  redis
    .incr(redisKey)
    .then((remoteCount) => {
      if (remoteCount === 1) {
        // First increment in this window — self-cleaning TTL, with 1s slack
        // so the key outlives the window boundary.
        redis.pexpire(redisKey, windowMs + 1_000).catch(onError);
      }
      const bucket = buckets.get(key);
      if (bucket && bucket.resetAt === resetAt && remoteCount > bucket.count) {
        bucket.count = remoteCount;
      }
    })
    .catch(onError);
}

function check(
  key: string,
  max: number,
  windowMs: number,
  group?: RateLimitGroup,
): RateLimitResult {
  const onError = group && group !== "local" ? groupFailureLog(key, group) : logSyncFailure;
  const now = Date.now();
  // Epoch-aligned window end so every instance derives the SAME Redis key
  // for the same wall-clock window. (A first-request-anchored window would
  // give each lambda its own boundary and the counts could never merge.)
  const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt !== resetAt) {
    buckets.set(key, { count: 1, resetAt });
    syncRemoteCount(key, windowMs, resetAt, group, onError);
    return { ok: true };
  }

  // Refused from this instance's own count: no Redis command, so a refused
  // burst costs nothing in either database.
  if (bucket.count >= max) {
    return { ok: false, retryAfter: Math.ceil((resetAt - now) / 1000) };
  }

  bucket.count++;
  syncRemoteCount(key, windowMs, resetAt, group, onError);
  return { ok: true };
}

/**
 * Derive the client IP using Vercel-trusted headers only.
 *
 * Why not x-forwarded-for in production: clients can prepend arbitrary values
 * to XFF, so the leftmost token is attacker-controlled. Rotating XFF would
 * give a fresh rate-limit bucket per request, nullifying the limiter.
 *
 * Vercel sets x-vercel-forwarded-for and x-real-ip at the edge after stripping
 * any client-supplied versions, so those are trustworthy.
 *
 * In local dev (NODE_ENV !== "production") the Vercel headers aren't set; fall
 * back to x-forwarded-for so the limiter still works during development.
 */
function getClientIp(request: Request): string {
  const vercelFwd = request.headers.get("x-vercel-forwarded-for");
  if (vercelFwd) return vercelFwd.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  if (process.env.NODE_ENV !== "production") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }

  return "unknown";
}

export function rateLimit(
  request: Request,
  opts?: { max?: number; windowMs?: number; bucketKey?: string; group?: RateLimitGroup },
): RateLimitResult {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const ip = getClientIp(request);

  // Distinct bucket per (route, ip) pair so the per-route override doesn't
  // share state with another route's stricter limit.
  return check(`${opts?.bucketKey ?? "default"}:${ip}`, max, windowMs, opts?.group);
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
  opts?: { max?: number; windowMs?: number; group?: RateLimitGroup },
): RateLimitResult {
  return check(key, opts?.max ?? DEFAULT_MAX, opts?.windowMs ?? DEFAULT_WINDOW_MS, opts?.group);
}

/**
 * FAIL-CLOSED limits (#57 slice 3): the security routes where every allowed
 * call sends an email to a third party, tests a secret, or spends a paid model
 * call (team invite send and resend, admin send-invite, accept per token, the
 * three claim routes, the two admin CV extractions).
 *
 * Decided by the main database, not by this instance's memory: one atomic
 * script per call counts the call and, only when the key has no expiry yet,
 * sets one, so the window is fixed from its first call and a steady caller is
 * let in again when it ends (no lockout). N instances share one count, so the
 * limit is the limit, not the limit times the instances.
 *
 * When the main database cannot answer (an error, a timeout, a bad reply, or
 * no client in production) the call is REFUSED with reason "unavailable"; the
 * route shows TRY_AGAIN_SOON and sends nothing. One `outcome=closed` line,
 * throttled like the other groups'. Outside production with no Redis set up,
 * local development decides from memory.
 *
 * A call this instance has already seen refused in the current window is
 * refused again without asking Redis, so a refused burst costs nothing.
 *
 * Always the main database; never publicRedisClient().
 */
export type ClosedLimitResult =
  | { ok: true }
  | { ok: false; reason: "limited"; retryAfter: number }
  | { ok: false; reason: "unavailable" };

/** What a fail-closed route says when the limit store cannot answer. */
export const TRY_AGAIN_SOON = "Please try again in a minute.";

const CLOSED_SCRIPT = `local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}`;
const CLOSED_TIMEOUT_MS = 3_000;
/** Keys this instance has seen refused, until their window ends. */
const closedRefused = new Map<string, number>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function rateLimitClosedByKey(
  key: string,
  opts: { max: number; windowMs: number },
): Promise<ClosedLimitResult> {
  const now = Date.now();
  const until = closedRefused.get(key);
  if (until !== undefined && now < until) {
    return { ok: false, reason: "limited", retryAfter: Math.ceil((until - now) / 1000) };
  }
  const closed = groupFailureLog(key, "security", "closed");
  const redis = redisClient();
  if (!redis) {
    if (process.env.VERCEL_ENV === "production") {
      closed(Object.assign(new Error("no store"), { name: "NoSharedStoreError" }));
      return { ok: false, reason: "unavailable" };
    }
    const local = check(key, opts.max, opts.windowMs, "local");
    return local.ok ? local : { ok: false, reason: "limited", retryAfter: local.retryAfter };
  }
  try {
    const reply = await withTimeout(
      redis.eval(CLOSED_SCRIPT, [`rlc:${key}`], [String(opts.windowMs)]),
      CLOSED_TIMEOUT_MS,
    );
    const [count, ttl] = (Array.isArray(reply) ? reply : []).map(Number);
    if (!Number.isFinite(count) || count < 1) throw new Error("unexpected reply");
    if (count <= opts.max) return { ok: true };
    const wait = Number.isFinite(ttl) && ttl > 0 ? ttl : opts.windowMs;
    closedRefused.set(key, now + wait);
    return { ok: false, reason: "limited", retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
  } catch (err) {
    closed(err);
    return { ok: false, reason: "unavailable" };
  }
}

/** rateLimitClosedByKey per route and client IP, as rateLimit() keys it. */
export function rateLimitClosed(
  request: Request,
  opts: { bucketKey: string; max: number; windowMs: number },
): Promise<ClosedLimitResult> {
  return rateLimitClosedByKey(`${opts.bucketKey}:${getClientIp(request)}`, opts);
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
    for (const [key, until] of closedRefused) {
      if (until < now) closedRefused.delete(key);
    }
  }, 5 * 60_000);
}
