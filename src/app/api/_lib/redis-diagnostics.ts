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
  if (name === "AbortError" || name === "TimeoutError") return "ETIMEDOUT";
  const net = codeOf(e.cause) ?? codeOf(e);
  if (net && net in NETWORK_CODES) return NETWORK_CODES[net];
  const word = typeof e.message === "string" ? /^[A-Z]+/.exec(e.message.trim())?.[0] : undefined;
  if (word && REDIS_WORDS.has(word)) return word;
  if (name === "UpstashError") return "UPSTASH_OTHER";
  return "UNKNOWN";
}

export type StoreChoice =
  | { store: "redis" }
  | { store: "memory" }
  | { store: "production-without-redis"; missing: string[] };

/**
 * The same test rate-limit.ts uses to build its client (both variables
 * truthy), named. "production-without-redis" is a label only: the limiter
 * still runs in memory, exactly as it does for "memory".
 */
export function storeChoice(env: Record<string, string | undefined>): StoreChoice {
  const missing = [URL_VAR, TOKEN_VAR].filter((n) => !env[n]);
  if (missing.length === 0) return { store: "redis" };
  if (env.VERCEL_ENV === "production") return { store: "production-without-redis", missing };
  return { store: "memory" };
}

export function storeChoiceLine(choice: StoreChoice): string {
  return choice.store === "production-without-redis"
    ? `${LOG_PREFIX} store=production-without-redis missing=${choice.missing.join(",")}`
    : `${LOG_PREFIX} store=${choice.store}`;
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
