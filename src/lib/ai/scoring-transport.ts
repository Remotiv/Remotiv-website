/**
 * The one place a scoring call leaves the process.
 *
 * The scorers (CV score, interview answer, session summary) build their
 * request exactly as before and hand it here. The model string picks the
 * provider: gpt-* goes to OpenAI Chat Completions (providers/openai-chat.ts);
 * everything else goes to Anthropic, with the request object and the options
 * passed through untouched, so an Anthropic call is the same request it always
 * was.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic } from "@/lib/anthropic";
import { createOpenAIChatMessage, isOpenAIModel } from "./providers/openai-chat";

export type ScoringRequest = Anthropic.MessageCreateParamsNonStreaming;
export type ScoringRequestOptions = { signal?: AbortSignal; timeout?: number; maxRetries?: number };

/** The parts of a reply the scorers read, whichever provider answered. */
export type ScoringMessage = {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null;
};

export async function createScoringMessage(
  request: ScoringRequest,
  options?: ScoringRequestOptions,
): Promise<ScoringMessage> {
  if (isOpenAIModel(request.model)) return createOpenAIChatMessage(request, options);
  return getAnthropic().messages.create(request, options);
}
