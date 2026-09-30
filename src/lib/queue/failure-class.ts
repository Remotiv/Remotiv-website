/**
 * What kind of failure a provider call produced, and whether the queue should
 * try again.
 *
 * ── Why this exists (Phase 5, P13) ───────────────────────────
 *
 * Every throw out of a handler used to take the same path: attempts + 1,
 * backoff, try again, dead on the third. That is right for a 429 or a 5xx and
 * wrong for everything else. A 400 from the provider, a missing API key, a
 * credit balance at zero, or a reply the parser rejects at temperature 0 will
 * fail identically on the second and third attempt - three paid calls for one
 * answer that was never going to arrive. Live evidence: one ai_cv_score job
 * dead after three attempts on a 400 invalid_request_error.
 *
 * Classes:
 *   retryable      429, 408, 409, 5xx, network, timeout, our own deadline abort
 *   deterministic  400 (not billing), 404, 413, 415, 422, malformed model output,
 *                  evidence gate refusal
 *   configuration  401, 403, missing API key
 *   billing        400/402 mentioning the credit balance, 429 insufficient_quota
 *
 * Only `retryable` goes back on the queue. The other three are wrapped in
 * TerminalJobError and failJob buries the job on the first attempt with the
 * class in last_error, where the admin dead-letter panel can replay it once
 * the underlying problem is fixed.
 *
 * Pure: no imports, so it runs under bare node:test and can be used by every
 * handler without an initialisation cycle through jobs-queue.
 */

export type FailureClass = "retryable" | "deterministic" | "configuration" | "billing";

export type Classification = {
  failureClass: FailureClass;
  retryable: boolean;
  /** HTTP status when the error carried one. */
  status: number | null;
  /** One line for last_error and the log. Never a provider body verbatim. */
  summary: string;
};

/**
 * A failure the queue must not retry. `failureClass` is one of the three
 * non-retryable classes; the message is what last_error will say.
 */
export class TerminalJobError extends Error {
  readonly failureClass: Exclude<FailureClass, "retryable">;
  constructor(
    failureClass: Exclude<FailureClass, "retryable">,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TerminalJobError";
    this.failureClass = failureClass;
  }
}

/**
 * The handler stopped on purpose because the worker's remaining budget could
 * not fit the next provider call. Not a failure: the worker releases the job
 * for the next tick with attempts untouched. Safe to leave uncounted because
 * the start gate (lib/queue/budgets.ts) guarantees the FIRST paid call always
 * fits, so a yield always follows real progress.
 */
export class JobYield extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobYield";
  }
}

/** A non-2xx from a provider reached through plain fetch (Whisper). */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  constructor(provider: string, status: number, detail: string) {
    super(`${provider} ${status}: ${detail}`);
    this.name = "ProviderHttpError";
    this.provider = provider;
    this.status = status;
  }
}

/** Anthropic reports an empty balance as a 400; OpenAI as a 429 insufficient_quota. */
const BILLING_RE = /credit balance|insufficient[_ ](quota|credits|funds)|payment required|billing/i;
/** Our own pre-call throws when a key is absent. */
const MISSING_KEY_RE = /API[_ ]KEY is not (set|configured)|API key is not (set|configured)/i;

function statusOf(err: unknown): number | null {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number" && Number.isFinite(s)) return s;
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

function make(failureClass: FailureClass, status: number | null, summary: string): Classification {
  return { failureClass, retryable: failureClass === "retryable", status, summary };
}

/** First line only, trimmed, so a stack or a JSON body never lands in last_error. */
function short(message: string, max = 300): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function classifyProviderError(err: unknown): Classification {
  if (err instanceof TerminalJobError) {
    return make(err.failureClass, statusOf(err.cause), short(err.message));
  }
  const status = statusOf(err);
  const message = messageOf(err);

  if (status !== null) {
    if (status === 400 || status === 402) {
      return BILLING_RE.test(message)
        ? make("billing", status, `provider ${status}: ${short(message)}`)
        : make("deterministic", status, `provider ${status}: ${short(message)}`);
    }
    if (status === 401 || status === 403) {
      return make("configuration", status, `provider ${status}: ${short(message)}`);
    }
    if (status === 429) {
      return BILLING_RE.test(message)
        ? make("billing", status, `provider 429: ${short(message)}`)
        : make("retryable", status, `provider 429: ${short(message)}`);
    }
    if (status === 408 || status === 409 || status >= 500) {
      return make("retryable", status, `provider ${status}: ${short(message)}`);
    }
    // 404 (model), 413, 415, 422 and any other 4xx: the same request fails the same way.
    return make("deterministic", status, `provider ${status}: ${short(message)}`);
  }

  if (MISSING_KEY_RE.test(message)) return make("configuration", null, short(message));

  // Aborts, timeouts, DNS, reset connections, and anything unrecognised: retry.
  // The queue's backoff and max_attempts bound the cost of being wrong here.
  return make("retryable", null, short(message) || "unknown error");
}

/**
 * The error a handler should rethrow: the original when it is retryable, or a
 * TerminalJobError carrying the class when it is not. Idempotent.
 */
export function toJobError(err: unknown): unknown {
  if (err instanceof TerminalJobError || err instanceof JobYield) return err;
  const c = classifyProviderError(err);
  if (c.retryable) return err;
  return new TerminalJobError(c.failureClass as Exclude<FailureClass, "retryable">, c.summary, {
    cause: err,
  });
}

/**
 * What a candidate-visible or reviewer-visible row may say. Fixed sentences
 * only: the provider's own text goes to the job's last_error, never to a
 * column a page renders.
 */
/**
 * Every sentence safeFailureSentence can produce, plus the fixed sentences
 * the transcribe handler writes itself. A recruiter-facing surface renders a
 * stored `error` only if it is one of these; anything else is a raw provider
 * or database message from before the write path was made safe, and gets the
 * surface's fixed fallback instead (Phase 6, A6-26).
 */
export function isSafeFailureSentence(text: string | null | undefined): boolean {
  if (!text) return false;
  if (SAFE_SENTENCES.has(text)) return true;
  return /^Recording is \d+MB, over the \d+MB transcription limit\.$/.test(text);
}

const SAFE_SENTENCES: ReadonlySet<string> = new Set([
  ...(["transcription", "scoring"] as const).flatMap((what) =>
    [
      { failureClass: "configuration", status: 401 },
      { failureClass: "configuration", status: null },
      { failureClass: "billing", status: null },
      { failureClass: "deterministic", status: null },
      { failureClass: "retryable", status: null },
    ].map((c) =>
      safeFailureSentence(
        { ...c, retryable: c.failureClass === "retryable", summary: "" } as Classification,
        what,
      ),
    ),
  ),
  "Transcription returned nothing.",
  "Answer has no video to transcribe.",
  "Transcription failed for this answer.",
  "Scoring didn't complete. The CV is unaffected.",
]);

export function safeFailureSentence(c: Classification, what: "transcription" | "scoring"): string {
  const noun = what === "transcription" ? "Transcription" : "Scoring";
  switch (c.failureClass) {
    case "configuration":
      return c.status === 401 || c.status === 403
        ? `The ${what} provider rejected our credentials.`
        : `${noun} is not configured on this deployment.`;
    case "billing":
      return `The ${what} provider declined the request for billing reasons.`;
    case "deterministic":
      return what === "transcription"
        ? "The transcription provider rejected this recording."
        : "The model returned a response that could not be used.";
    default:
      return `${noun} failed and will be retried.`;
  }
}
