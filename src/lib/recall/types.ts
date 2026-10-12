/**
 * Recall.ai shapes used by Remotiv, and the one error the client throws.
 *
 * Only the fields this product reads are typed. Every field a response may
 * omit is optional, so a missing value is handled where it is read rather
 * than assumed. Pure: no imports, so tests and the fake can load it directly.
 */

export type RecallStatusChange = {
  code: string;
  sub_code?: string | null;
  created_at?: string | null;
};

export type RecallRecording = {
  id: string;
  status?: { code?: string | null } | null;
};

export type RecallBot = {
  id: string;
  join_at?: string | null;
  metadata?: Record<string, string> | null;
  status_changes?: RecallStatusChange[] | null;
  recordings?: RecallRecording[] | null;
};

/** The documented Create Bot body, limited to the fields Remotiv sets. */
export type CreateBotRequest = {
  meeting_url: string;
  bot_name: string;
  join_at: string;
  recording_config: {
    video_mixed_mp4: Record<string, never>;
    retention: { type: "timed"; hours: number };
  };
  automatic_leave: {
    waiting_room_timeout: number;
    noone_joined_timeout: number;
    everyone_left_timeout: { timeout: number };
    in_call_recording_timeout: number;
  };
  metadata: Record<string, string>;
};

export type CallOptions = {
  /** Aborts the request, typically the worker's deadline signal. */
  signal?: AbortSignal;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
};

/** DELETE /bot/{id}/: 204, 404, or 405 once the bot has been dispatched. */
export type DeleteScheduledOutcome = "deleted" | "already_gone" | "not_allowed";

/** POST /bot/{id}/leave_call/: 200 with the bot, 400 when there is no call to leave, 404. */
export type LeaveCallOutcome =
  | { outcome: "left"; bot: RecallBot }
  | { outcome: "not_in_call" }
  | { outcome: "already_gone" };

/** DELETE /recording/{id}/: 204, or 404 when it is already gone. */
export type DeleteRecordingOutcome = "deleted" | "already_gone";

export type ListBotsQuery = {
  /** Sent as metadata__<key>=<value>; Recall matches every pair. */
  metadata?: Record<string, string>;
  /** YYYY-MM-DD. */
  joinAtAfter?: string;
  /** Pages to follow before stopping. Each page is one request. */
  maxPages?: number;
};

export type ListBotsResult = {
  bots: RecallBot[];
  /** True when a further page existed and was not read. */
  truncated: boolean;
};

export interface RecallClient {
  createBot(
    request: CreateBotRequest,
    options: CallOptions & { idempotencyKey: string },
  ): Promise<RecallBot>;
  /** Null on 404. */
  retrieveBot(botId: string, options?: CallOptions): Promise<RecallBot | null>;
  listBots(query: ListBotsQuery, options?: CallOptions): Promise<ListBotsResult>;
  deleteScheduledBot(botId: string, options?: CallOptions): Promise<DeleteScheduledOutcome>;
  leaveCall(botId: string, options?: CallOptions): Promise<LeaveCallOutcome>;
  deleteRecording(recordingId: string, options?: CallOptions): Promise<DeleteRecordingOutcome>;
}

/**
 * The failure part of a RecallApiError message. 402 is Recall refusing for
 * billing (out of credit); lib/queue/failure-class.ts reads a 402 as billing
 * only when the message says so, and Recall's body is never copied in, so the
 * wording is fixed here.
 */
function failureText(status: number | null, reason: string | undefined): string {
  if (status === null) return reason ?? "network error";
  if (status === 402) return "HTTP 402 payment required";
  return `HTTP ${status}`;
}

/**
 * A Recall call that did not succeed.
 *
 * Carries the HTTP status and Recall's error code when it sent one, never the
 * response body, the request body, the URL's query or the key. `status` is
 * what lib/queue/failure-class.ts classifies on: 429, 409 and 5xx retry, 401
 * and 403 are configuration, 402 is billing, other 4xx are deterministic. A
 * network failure or timeout has no status and retries.
 */
export class RecallApiError extends Error {
  readonly operation: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(args: {
    operation: string;
    status: number | null;
    code?: string | null;
    retryable: boolean;
    retryAfterSeconds?: number | null;
    reason?: string;
  }) {
    const what = failureText(args.status, args.reason);
    super(`Recall ${args.operation} failed: ${what}${args.code ? ` (${args.code})` : ""}`);
    this.name = "RecallApiError";
    this.operation = args.operation;
    this.status = args.status;
    this.code = args.code ?? null;
    this.retryable = args.retryable;
    this.retryAfterSeconds = args.retryAfterSeconds ?? null;
  }
}

/** 408, 409, 429, 507 and every 5xx are worth another try. */
export function isRetryableRecallStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 507 || status >= 500;
}
