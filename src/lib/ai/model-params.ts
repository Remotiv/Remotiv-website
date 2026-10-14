/**
 * Per-model request fields and response reading for the scorers.
 *
 * The scoring model is chosen only by AI_SCORING_MODEL, and the families it
 * can point at disagree on the request surface. Everything model-dependent is
 * decided here, so the scorers send one request shape and read one response
 * shape whatever the model. Pure: no I/O, no SDK client.
 *
 * Sources, from the Claude API reference (claude-api skill, model-migration
 * guide), not from memory:
 *
 *   temperature    accepted on the Claude 4.x line up to Opus 4.6, Sonnet 4.6
 *                  and Haiku 4.5. Rejected with a 400 on Opus 4.7 and Opus 4.8
 *                  ("Migrating to Opus 4.7": "no longer accepted"), on Sonnet 5
 *                  ("non-default value returns a 400"), on Claude Sonnet 5.5
 *                  (built on Sonnet 5's surface) and on Claude Haiku 5.5
 *                  ("Breaking change 2: non-default sampling parameters return
 *                  a 400"). Anything not recognised gets no temperature.
 *   thinking off   Claude Haiku 5.5: `{type: "disabled"}`, accepted at effort
 *                  low, medium and high (its default is medium). Claude Sonnet
 *                  5.5: `{type: "between_tools"}` ("disabled" is a 400 there),
 *                  accepted at effort high or below (its default is high). The
 *                  4.x models think only when asked, so they get nothing.
 *   stop_reason    "max_tokens" (the cap was hit, and thinking counts toward
 *                  it) and "refusal" (a safety classifier declined) are the two
 *                  that leave no usable answer.
 */

import type { ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages";
import { TerminalJobError } from "@/lib/queue/failure-class";

/** The parts of a Messages API response these helpers read. */
export type ModelResponseLike = {
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  stop_reason?: string | null;
};

/**
 * Opus 4.7 and 4.8 share the 4.x prefix but reject sampling parameters, so
 * they are excluded by name rather than caught by the family match.
 */
const SAMPLING_REJECTED_4X = /^claude-opus-4-[78](?:-|$)/;
const CLAUDE_4X = /^claude-(?:sonnet|haiku|opus)-4(?:-|$)/;

/** Whether a request to this model may carry `temperature`. Unknown models: no. */
export function acceptsTemperature(model: string): boolean {
  const id = model.trim();
  return CLAUDE_4X.test(id) && !SAMPLING_REJECTED_4X.test(id);
}

export type ThinkingOffParams = { thinking?: ThinkingConfigParam };

/**
 * The pinned SDK's types (0.97) predate `between_tools`; the API documents it
 * for Claude Sonnet 5.5 and the SDK sends the field as given.
 */
const BETWEEN_TOOLS = { type: "between_tools" } as unknown as ThinkingConfigParam;

/**
 * The request fields that turn extended thinking off, or {} where the model
 * does not think unless asked (the 4.x line) or where no off switch is
 * documented for it.
 */
export function thinkingOffParams(model: string): ThinkingOffParams {
  const id = model.trim();
  if (id === "claude-haiku-5-5") return { thinking: { type: "disabled" } };
  if (id === "claude-sonnet-5-5") return { thinking: BETWEEN_TOOLS };
  // TODO: no other 5.x model is a scoring target yet. Claude Opus 5.5 and the
  // Fable models cannot turn thinking off at all (the docs say any explicit
  // off setting is a 400), and Sonnet 5 / Opus 5 have their own rules. Each
  // one needs its own docs-confirmed entry here before AI_SCORING_MODEL points
  // at it; until then they run with default thinking, which extractText and
  // assertCompleteStop already cope with.
  return {};
}

const modelNote = (model?: string) => (model ? ` (model ${model})` : "");

/**
 * A response that stopped before finishing its answer. Terminal, like the
 * malformed JSON a truncated reply always produced before: the same request
 * stops the same way. The message names the stop reason and the model only.
 */
export class IncompleteModelResponseError extends TerminalJobError {
  readonly stopReason: string;
  constructor(stopReason: string, model?: string) {
    super(
      "deterministic",
      `Model response incomplete: stop_reason ${stopReason}${modelNote(model)}.`,
    );
    this.name = "IncompleteModelResponseError";
    this.stopReason = stopReason;
  }
}

/** A finished response with no text block to read. Terminal, as an empty reply always was. */
export class NoTextBlockError extends TerminalJobError {
  constructor(model?: string) {
    super("deterministic", `Model response had no text block${modelNote(model)}.`);
    this.name = "NoTextBlockError";
  }
}

const INCOMPLETE_STOPS: ReadonlySet<string> = new Set(["max_tokens", "refusal"]);

/** Throws when the response stopped on max_tokens or a refusal. */
export function assertCompleteStop(response: ModelResponseLike, model?: string): void {
  const stop = response.stop_reason;
  if (typeof stop === "string" && INCOMPLETE_STOPS.has(stop)) {
    throw new IncompleteModelResponseError(stop, model);
  }
}

/**
 * The text of the first `text` block. Thinking blocks (which newer models put
 * first, often with empty text) and any other block type are skipped.
 */
export function extractText(response: ModelResponseLike, model?: string): string {
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  throw new NoTextBlockError(model);
}
