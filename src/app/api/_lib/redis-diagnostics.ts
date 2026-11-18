/**
 * What the rate limiters may say about Redis in the logs, and nothing else
 * (#48 / #57 diagnostics, logs only: no decision depends on anything here).
 *
 * The production Upstash database showed 0 commands for the month while the
 * site-wide limiter, which swallows every Redis error, reported nothing. These
 * lines make the next failure visible without ever writing a value:
 *
 *   [rate-limit] store=redis | store=memory |
 *     store=production-without-redis missing=<VAR NAMES>   once per cold start
 *   [rate-limit] redis-check=ok | redis-check=failed reason=<CODE>
 *                                                            once per cold start
 *   [rate-limit] redis-sync=failed reason=<CODE> [suppressed=<N>]
 *                                                            at most once a minute per instance
 *
 * <CODE> is one word from a fixed list, never derived text: an Upstash error
 * message carries the command it failed on, and a network error can carry the
 * host. Only the leading Redis reply word (NOPERM, WRONGPASS, ...) or a known
 * network code is ever emitted; anything else is UPSTASH_OTHER or UNKNOWN.
 */

export const LOG_PREFIX = "[rate-limit]";

const URL_VAR = "UPSTASH_REDIS_REST_URL";
const TOKEN_VAR = "UPSTASH_REDIS_REST_TOKEN";
const KV_URL_VAR = "KV_REST_API_URL";
const KV_TOKEN_VAR = "KV_REST_API_TOKEN";

/** Leading words of a Redis error reply that are safe and useful to log. */
const REDIS_WORDS = new Set([
  "NOPERM",
  "WRONGPASS",
  "NOAUTH",
  "ERR",
  "READONLY",
  "OOM",
  "LOADING",
  "BUSY",
  "NOSCRIPT",
]);

/** Network error codes, folded to the five the runbook names. */
const NETWORK_CODES: Record<string, string> = {
  ENOTFOUND: "ENOTFOUND",
  EAI_AGAIN: "ENOTFOUND",
  ECONNREFUSED: "ECONNREFUSED",
  ECONNRESET: "ECONNRESET",
  UND_ERR_SOCKET: "ECONNRESET",
  ETIMEDOUT: "ETIMEDOUT",
  UND_ERR_CONNECT_TIMEOUT: "ETIMEDOUT",
  UND_ERR_HEADERS_TIMEOUT: "ETIMEDOUT",
  UND_ERR_BODY_TIMEOUT: "ETIMEDOUT",
};

function codeOf(x: unknown): string | null {
  return x && typeof x === "object" && typeof (x as { code?: unknown }).code === "string"
    ? (x as { code: string }).code
    : null;
}

/** One word from a fixed vocabulary. Never the message, the URL or the token. */
export function redisReasonCode(err: unknown): string {
  if (!err || typeof err !== "object") return "UNKNOWN";
  const e = err as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "UrlError") return "BADURL";
  if (name === "NoSharedStoreError") return "NO_STORE";
  if (name === "AbortError" || name === "TimeoutError") return "ETIMEDOUT";
  const net = codeOf(e.cause) ?? codeOf(e);
  if (net && net in NETWORK_CODES) return NETWORK_CODES[net];
  const word = typeof e.message === "string" ? /^[A-Z]+/.exec(e.message.trim())?.[0] : undefined;
  if (word && REDIS_WORDS.has(word)) return word;
  if (name === "UpstashError") return "UPSTASH_OTHER";
  return "UNKNOWN";
}

export type StoreChoice =
  | { store: "redis"; source: "upstash" | "kv" }
  | { store: "memory" }
  | { store: "production-without-redis"; missing: string[] };

/** A complete credential pair, in preference order. Never one name from each. */
const PAIRS = [
  { name: "UPSTASH_REDIS_REST", url: URL_VAR, token: TOKEN_VAR },
  { name: "KV_REST_API", url: KV_URL_VAR, token: KV_TOKEN_VAR },
] as const;

export type RedisPair = { pair: "UPSTASH_REDIS_REST" | "KV_REST_API"; url: string; token: string };

/**
 * The Redis credentials to use: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * when BOTH are set; otherwise (only with `kvFallback`) KV_REST_API_URL +
 * KV_REST_API_TOKEN when BOTH are set; otherwise none. A URL from one pair is
 * never combined with the token of the other: a half-configured pair is a
 * misconfiguration to report, not something to repair by guessing.
 */
export function redisCredentialPair(
  env: Record<string, string | undefined>,
  opts: { kvFallback?: boolean } = {},
): RedisPair | null {
  for (const p of opts.kvFallback ? PAIRS : PAIRS.slice(0, 1)) {
    const url = env[p.url];
    const token = env[p.token];
    if (url && token) return { pair: p.name, url, token };
  }
  return null;
}

/**
 * Which store a limiter with these credentials uses, named for the log.
 * Without `kvFallback` this is exactly rate-limit.ts's own test (both UPSTASH
 * variables truthy). "production-without-redis" is a label; what each limiter
 * then does is its own (rate-limit.ts runs in memory, invite-password-limit.ts
 * refuses). `missing` lists, by name only, every variable absent from each
 * pair that was considered, so a mixed or partial setup names what would
 * complete either pair.
 */
export function storeChoice(
  env: Record<string, string | undefined>,
  opts: { kvFallback?: boolean } = {},
): StoreChoice {
  const pair = redisCredentialPair(env, opts);
  if (pair) return { store: "redis", source: pair.pair === "KV_REST_API" ? "kv" : "upstash" };
  if (env.VERCEL_ENV !== "production") return { store: "memory" };
  const missing = (opts.kvFallback ? PAIRS : PAIRS.slice(0, 1)).flatMap((p) =>
    [p.url, p.token].filter((n) => !env[n]),
  );
  return { store: "production-without-redis", missing };
}

/**
 * The store line. `withSource` adds which credential pair was used,
 * ` source=upstash|kv`, by pair name only (the invite limiter's line; the
 * site-wide `[rate-limit] store=redis` line is unchanged).
 */
export function storeChoiceLine(
  choice: StoreChoice,
  prefix: string = LOG_PREFIX,
  opts: { withSource?: boolean } = {},
): string {
  if (choice.store === "production-without-redis") {
    return `${prefix} store=production-without-redis missing=${choice.missing.join(",")}`;
  }
  if (choice.store === "redis" && opts.withSource) {
    return `${prefix} store=redis source=${choice.source}`;
  }
  return `${prefix} store=${choice.store}`;
}

/** EVAL "return 1" 0: proves the URL, the token and scripting in one call that touches no key. */
export async function redisCheckLine(redis: {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>;
}): Promise<string> {
  try {
    const reply = await redis.eval("return 1", [], []);
    return Number(reply) === 1
      ? `${LOG_PREFIX} redis-check=ok`
      : `${LOG_PREFIX} redis-check=failed reason=UNEXPECTED_REPLY`;
  } catch (err) {
    return `${LOG_PREFIX} redis-check=failed reason=${redisReasonCode(err)}`;
  }
}

/**
 * At most one line per `intervalMs`; the ones held back are counted and
 * reported on the next line that is written.
 */
export function throttledFailureLog(
  write: (line: string) => void,
  intervalMs = 60_000,
  now: () => number = Date.now,
): (err: unknown) => void {
  let last = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return (err) => {
    const t = now();
    if (t - last < intervalMs) {
      suppressed++;
      return;
    }
    last = t;
    const held = suppressed > 0 ? ` suppressed=${suppressed}` : "";
    suppressed = 0;
    write(`${LOG_PREFIX} redis-sync=failed reason=${redisReasonCode(err)}${held}`);
  };
}
