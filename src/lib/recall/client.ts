import "server-only";
import {
  type CallOptions,
  type CreateBotRequest,
  type DeleteRecordingOutcome,
  type DeleteScheduledOutcome,
  isRetryableRecallStatus,
  type LeaveCallOutcome,
  type ListBotsQuery,
  type ListBotsResult,
  type MediaRangeResult,
  RecallApiError,
  type RecallBot,
  type RecallClient,
  type RecallRecordingInfo,
} from "./types";

export type { RecallBot, RecallClient, RecallRecordingInfo } from "./types";
export { RecallApiError } from "./types";

/**
 * The Recall.ai REST client. Every Recall request in this product goes
 * through here, and only background jobs call it.
 *
 * ── Configuration ────────────────────────────────────────────
 *
 * RECALL_API_KEY and RECALL_API_BASE_URL, read when a client is built, never
 * at import. The base URL names the region (Tokyo for Remotiv) and must be an
 * https URL on recall.ai; anything else is refused rather than sent the key.
 * A missing or refused value produces a client whose every call throws a
 * configuration error, which the queue buries on the first attempt.
 *
 * ── What is never logged or thrown ───────────────────────────
 *
 * The key, request bodies (they carry the meeting URL), response bodies, and
 * download URLs. Errors carry the operation, the HTTP status and Recall's
 * error code, nothing else.
 *
 * ── Outcomes rather than throws ──────────────────────────────
 *
 * The statuses a caller must act on are returned, not thrown: 404 on a
 * delete is "already gone", 405 on a scheduled-bot delete is "not allowed"
 * (the bot was dispatched, and the caller must look again), 400 on leave_call
 * is "no call to leave". Everything else that is not a success throws.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_CODE_RE = /^[a-z0-9_]{1,64}$/;
const METADATA_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

export function isRecallId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** https, on recall.ai, no query or fragment; trailing slashes removed. Null otherwise. */
export function normaliseRecallBaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "recall.ai" && !url.hostname.endsWith(".recall.ai")) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RecallClientConfig = {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  defaultTimeoutMs?: number;
};

function retryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function safeCode(body: unknown): string | null {
  if (body && typeof body === "object") {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE_RE.test(code)) return code;
  }
  return null;
}

function asBot(value: unknown): RecallBot | null {
  if (!value || typeof value !== "object") return null;
  const bot = value as RecallBot;
  return typeof bot.id === "string" && bot.id ? bot : null;
}

const asCode = (value: unknown): string | null =>
  typeof value === "string" && SAFE_CODE_RE.test(value) ? value : null;

function asRecordingInfo(value: unknown): RecallRecordingInfo | null {
  if (!value || typeof value !== "object") return null;
  const r = value as {
    id?: unknown;
    bot?: { id?: unknown } | null;
    status?: { code?: unknown } | null;
    media_shortcuts?: {
      video_mixed?: {
        status?: { code?: unknown } | null;
        data?: { download_url?: unknown };
      } | null;
    } | null;
  };
  if (!isRecallId(r.id)) return null;
  const video = r.media_shortcuts?.video_mixed;
  const url = video?.data?.download_url;
  return {
    id: r.id,
    botId: isRecallId(r.bot?.id) ? r.bot.id : null,
    statusCode: asCode(r.status?.code),
    videoStatusCode: asCode(video?.status?.code),
    downloadUrl: typeof url === "string" && url ? url : null,
  };
}

/**
 * Whether a media URL may be fetched: https, a named host, no credentials.
 * The URL comes from Recall, but it is checked before a byte is requested.
 */
export function isSafeDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname;
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
    return host.includes(".");
  } catch {
    return false;
  }
}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/**
 * Exactly `expected` bytes into one buffer of that size, or a throw. Memory
 * is bounded by the range the caller asked for, never by what is sent.
 */
async function readExactly(res: Response, expected: number, operation: string) {
  const out = new Uint8Array(expected);
  let offset = 0;
  const fail = (reason: string) =>
    new RecallApiError({ operation, status: null, retryable: true, reason });
  const reader = res.body?.getReader();
  if (!reader) throw fail("no body");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected) {
        await reader.cancel().catch(() => {});
        throw fail("body longer than its range");
      }
      out.set(value, offset);
      offset += value.byteLength;
    }
  } catch (err) {
    if (err instanceof RecallApiError) throw err;
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw fail(timedOut ? "timed out" : "network error");
  }
  if (offset !== expected) throw fail("body shorter than its range");
  return out;
}

export function createRecallClient(config: RecallClientConfig): RecallClient {
  const base = normaliseRecallBaseUrl(config.baseUrl);
  const apiKey = config.apiKey?.trim();
  const doFetch: FetchLike = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  function refuseConfig(operation: string): never {
    // Matches failure-class MISSING_KEY_RE, so the queue buries it as configuration.
    throw new RecallApiError({
      operation,
      status: null,
      retryable: false,
      reason: !apiKey ? "RECALL_API_KEY is not set" : "RECALL_API_BASE_URL is not configured",
    });
  }

  async function request(
    operation: string,
    method: string,
    url: string,
    options: CallOptions & { body?: unknown; headers?: Record<string, string> },
    passStatuses: readonly number[] = [],
  ): Promise<{ status: number; body: unknown }> {
    if (!apiKey || !base) refuseConfig(operation);
    const signals = [AbortSignal.timeout(options.timeoutMs ?? defaultTimeout)];
    if (options.signal) signals.push(options.signal);

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          authorization: `Token ${apiKey}`,
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.any(signals),
        cache: "no-store",
      });
    } catch (err) {
      const timedOut =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new RecallApiError({
        operation,
        status: null,
        retryable: true,
        reason: timedOut ? "timed out" : "network error",
      });
    }

    const text = await res.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (res.ok || passStatuses.includes(res.status)) return { status: res.status, body };
    throw new RecallApiError({
      operation,
      status: res.status,
      code: safeCode(body),
      retryable: isRetryableRecallStatus(res.status),
      retryAfterSeconds: retryAfter(res),
    });
  }

  function botPath(operation: string, botId: string, suffix = ""): string {
    if (!isRecallId(botId)) {
      throw new RecallApiError({
        operation,
        status: null,
        retryable: false,
        reason: "invalid bot id",
      });
    }
    return `${base}/bot/${botId}/${suffix}`;
  }

  return {
    async createBot(body: CreateBotRequest, options): Promise<RecallBot> {
      const { body: json } = await request("create bot", "POST", `${base}/bot/`, {
        ...options,
        body,
        // Recall replays the original response for one hour on the same key,
        // so a retried create after a lost response returns the same bot.
        headers: { "idempotency-key": options.idempotencyKey },
      });
      const bot = asBot(json);
      if (!bot) {
        // A 2xx without a bot id: the bot may exist, so this is NOT terminal.
        throw new RecallApiError({
          operation: "create bot",
          status: null,
          retryable: true,
          reason: "response had no bot id",
        });
      }
      return bot;
    },

    async retrieveBot(botId, options = {}): Promise<RecallBot | null> {
      const { status, body } = await request(
        "retrieve bot",
        "GET",
        botPath("retrieve bot", botId),
        options,
        [404],
      );
      if (status === 404) return null;
      const bot = asBot(body);
      if (!bot) {
        throw new RecallApiError({
          operation: "retrieve bot",
          status: null,
          retryable: true,
          reason: "response had no bot id",
        });
      }
      return bot;
    },

    async listBots(query: ListBotsQuery, options = {}): Promise<ListBotsResult> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query.metadata ?? {})) {
        if (!METADATA_KEY_RE.test(key)) {
          throw new RecallApiError({
            operation: "list bots",
            status: null,
            retryable: false,
            reason: "invalid metadata key",
          });
        }
        params.set(`metadata__${key}`, value);
      }
      if (query.joinAtAfter) params.set("join_at_after", query.joinAtAfter);

      const bots: RecallBot[] = [];
      const maxPages = Math.max(1, query.maxPages ?? DEFAULT_MAX_PAGES);
      const qs = params.toString();
      let url: string | null = `${base}/bot/${qs ? `?${qs}` : ""}`;
      let pages = 0;
      let refusedNext = false;
      while (url && pages < maxPages) {
        const { body } = await request("list bots", "GET", url, options);
        pages += 1;
        const page = body as { results?: unknown; next?: unknown } | null;
        for (const item of Array.isArray(page?.results) ? page.results : []) {
          const bot = asBot(item);
          if (bot) bots.push(bot);
        }
        const next = typeof page?.next === "string" ? page.next : null;
        // Follow Recall's own next link only on Recall's own bot listing: the
        // key goes with the request, so it must never leave this base URL. A
        // refused link still means the listing is incomplete.
        const safe = next !== null && base !== null && next.startsWith(`${base}/bot/`);
        refusedNext = next !== null && !safe;
        url = safe ? next : null;
      }
      return { bots, truncated: url !== null || refusedNext };
    },

    async deleteScheduledBot(botId, options = {}): Promise<DeleteScheduledOutcome> {
      const { status } = await request(
        "delete scheduled bot",
        "DELETE",
        botPath("delete scheduled bot", botId),
        options,
        [404, 405],
      );
      if (status === 404) return "already_gone";
      if (status === 405) return "not_allowed";
      return "deleted";
    },

    async leaveCall(botId, options = {}): Promise<LeaveCallOutcome> {
      const { status, body } = await request(
        "leave call",
        "POST",
        botPath("leave call", botId, "leave_call/"),
        options,
        [400, 404],
      );
      if (status === 404) return { outcome: "already_gone" };
      // Recall answers 400 for a bot that has finished or not started.
      if (status === 400) return { outcome: "not_in_call" };
      const bot = asBot(body);
      return bot ? { outcome: "left", bot } : { outcome: "not_in_call" };
    },

    async deleteRecording(recordingId, options = {}): Promise<DeleteRecordingOutcome> {
      if (!isRecallId(recordingId)) {
        throw new RecallApiError({
          operation: "delete recording",
          status: null,
          retryable: false,
          reason: "invalid recording id",
        });
      }
      const { status } = await request(
        "delete recording",
        "DELETE",
        `${base}/recording/${recordingId}/`,
        options,
        [404],
      );
      return status === 404 ? "already_gone" : "deleted";
    },

    async retrieveRecording(recordingId, options = {}): Promise<RecallRecordingInfo | null> {
      if (!isRecallId(recordingId)) {
        throw new RecallApiError({
          operation: "retrieve recording",
          status: null,
          retryable: false,
          reason: "invalid recording id",
        });
      }
      const { status, body } = await request(
        "retrieve recording",
        "GET",
        `${base}/recording/${recordingId}/`,
        options,
        [404],
      );
      if (status === 404) return null;
      const info = asRecordingInfo(body);
      if (!info) {
        throw new RecallApiError({
          operation: "retrieve recording",
          status: null,
          retryable: true,
          reason: "response had no recording id",
        });
      }
      return info;
    },

    async downloadRange(url, start, end, options = {}): Promise<MediaRangeResult> {
      const operation = "download recording";
      const refuse = (reason: string): never => {
        throw new RecallApiError({ operation, status: null, retryable: false, reason });
      };
      if (!isSafeDownloadUrl(url)) refuse("download url refused");
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        refuse("invalid range");
      }
      const signals = [AbortSignal.timeout(options.timeoutMs ?? defaultTimeout)];
      if (options.signal) signals.push(options.signal);

      let res: Response;
      try {
        // A signed URL: no authorization header, the key never leaves Recall's API.
        res = await doFetch(url, {
          method: "GET",
          headers: { range: `bytes=${start}-${end}` },
          signal: AbortSignal.any(signals),
          cache: "no-store",
        });
      } catch (err) {
        const timedOut =
          err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new RecallApiError({
          operation,
          status: null,
          retryable: true,
          reason: timedOut ? "timed out" : "network error",
        });
      }
      const discard = () => res.body?.cancel().catch(() => {});
      if (res.status === 403 || res.status === 404) {
        await discard();
        return { outcome: "refused" };
      }
      if (res.status !== 206) {
        // A 200 is the whole file: never read it.
        await discard();
        throw new RecallApiError({
          operation,
          status: res.status,
          retryable: res.status === 200 || isRetryableRecallStatus(res.status),
        });
      }
      const m = CONTENT_RANGE_RE.exec(res.headers.get("content-range") ?? "");
      if (!m || Number(m[1]) !== start || Number(m[2]) !== end) {
        await discard();
        throw new RecallApiError({
          operation,
          status: null,
          retryable: true,
          reason: "content-range does not match the request",
        });
      }
      const bytes = await readExactly(res, end - start + 1, operation);
      return { outcome: "ok", bytes, total: Number(m[3]) };
    },
  };
}

/** The client for this deployment, from RECALL_API_KEY and RECALL_API_BASE_URL. */
export function getRecallClient(): RecallClient {
  return createRecallClient({
    apiKey: process.env.RECALL_API_KEY ?? "",
    baseUrl: process.env.RECALL_API_BASE_URL ?? "",
  });
}
