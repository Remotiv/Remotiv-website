/**
 * The scorers' request, sent to OpenAI Chat Completions instead of Anthropic.
 *
 * Takes the SAME request the scorers build for Anthropic (system blocks, user
 * message, max_tokens) and returns the reply in the shape they already read:
 * text content blocks, a stop_reason assertCompleteStop understands, and
 * usage. Prompts, parsing and quote verification are not touched: they run on
 * this reply exactly as they run on Anthropic's.
 *
 * Plain fetch, like lib/interviews/transcribe.ts: no SDK, so no hidden
 * retries. The queue is the only retry controller, and the caller's abort
 * signal and timeout are honoured.
 *
 * Settings are the benchmarked ones (/tmp/scorer-bench, rounds 5-6):
 * reasoning_effort "none" (the only effort at which OpenAI accepts
 * temperature), temperature 0, a fixed seed, JSON mode, store false.
 *
 * Never logs the request, the reply, the CV or the key. A provider error
 * message is kept short and any key fragment in it is redacted.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { TerminalJobError } from "@/lib/queue/failure-class";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
/** Best effort only: OpenAI documents seed as not guaranteeing determinism. */
export const OPENAI_SCORING_SEED = 1234;

/** gpt-* models are OpenAI's; everything else stays with Anthropic. */
export function isOpenAIModel(model: string): boolean {
  return /^gpt-/.test(model.trim());
}

export type OpenAIChatOptions = { signal?: AbortSignal; timeout?: number; maxRetries?: number };

/** The reply, in the parts the scorers read. */
export type OpenAIScoringReply = {
  id: string | null;
  model: string;
  content: { type: "text"; text: string }[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
};

/** OpenAI's quota and credit errors: retrying won't restore access (their error-codes guide). */
const BILLING_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
]);

/** finish_reason -> the stop_reason assertCompleteStop already handles. */
const STOP_REASON: Readonly<Record<string, string>> = {
  stop: "end_turn",
  length: "max_tokens",
  content_filter: "refusal",
};

/** An OpenAI HTTP error, carrying the status classifyProviderError reads. */
export class OpenAIHttpError extends Error {
  readonly status: number;
  readonly type: string | null;
  readonly code: string | null;
  constructor(status: number, type: string | null, code: string | null, message: string) {
    super(message);
    this.name = "OpenAIHttpError";
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

/** Any key-shaped fragment (OpenAI's 401 message quotes part of the key) becomes [redacted]. */
export function redactKeys(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_*.-]+/g, "[redacted]");
}

type TextBlockLike = { type: string; text?: string };

function joinText(content: string | readonly TextBlockLike[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** The Chat Completions body for one scoring request. Exported for tests. */
export function buildOpenAIChatBody(request: Anthropic.MessageCreateParamsNonStreaming) {
  const system = joinText(request.system as string | readonly TextBlockLike[] | undefined);
  return {
    model: request.model,
    messages: [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...request.messages.map((m) => ({
        role: m.role,
        content: joinText(m.content as string | readonly TextBlockLike[]),
      })),
    ],
    reasoning_effort: "none" as const,
    temperature: 0,
    seed: OPENAI_SCORING_SEED,
    store: false,
    response_format: { type: "json_object" as const },
    max_completion_tokens: request.max_tokens,
  };
}

function abortSignal(options: OpenAIChatOptions): AbortSignal | undefined {
  const signals = [
    options.signal,
    typeof options.timeout === "number" ? AbortSignal.timeout(options.timeout) : undefined,
  ].filter((s): s is AbortSignal => Boolean(s));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Send one scoring request to OpenAI and return the reply in the Anthropic-shaped parts the scorers read. */
export async function createOpenAIChatMessage(
  request: Anthropic.MessageCreateParamsNonStreaming,
  options: OpenAIChatOptions = {},
): Promise<OpenAIScoringReply> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new TerminalJobError("configuration", "OPENAI_API_KEY is not configured");
  }

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildOpenAIChatBody(request)),
    signal: abortSignal(options),
  });

  const body = (await res.json().catch(() => null)) as {
    id?: string;
    model?: string;
    choices?: {
      finish_reason?: string | null;
      message?: { content?: string | null; refusal?: string | null };
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string; type?: string; code?: string | null };
  } | null;

  if (!res.ok) {
    const type = body?.error?.type ?? null;
    const code = body?.error?.code ?? null;
    const detail = redactKeys(String(body?.error?.message ?? "")).slice(0, 200);
    const err = new OpenAIHttpError(
      res.status,
      type,
      code,
      `openai ${res.status}${type || code ? ` ${[type, code].filter(Boolean).join("/")}` : ""}: ${detail}`,
    );
    // Quota and credit exhaustion: billing, explicitly, whatever the status.
    if ((code && BILLING_CODES.has(code)) || (type && BILLING_CODES.has(type))) {
      throw new TerminalJobError("billing", err.message, { cause: err });
    }
    throw err;
  }

  const choice = body?.choices?.[0];
  if (!body || !choice) {
    throw new OpenAIHttpError(res.status, null, null, "openai: reply had no choices");
  }
  const refused = typeof choice.message?.refusal === "string" && choice.message.refusal.length > 0;
  const finish = choice.finish_reason ?? "stop";
  const prompt = body.usage?.prompt_tokens ?? 0;
  const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    id: body.id ?? null,
    model: body.model ?? request.model,
    content: [{ type: "text", text: refused ? "" : (choice.message?.content ?? "") }],
    stop_reason: refused ? "refusal" : (STOP_REASON[finish] ?? finish),
    usage: {
      // prompt_tokens already includes the cached ones; split them so the
      // scorer's input + cache-read sum is the full prompt, as with Anthropic.
      input_tokens: Math.max(0, prompt - cached),
      output_tokens: body.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
    },
  };
}
