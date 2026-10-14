/**
 * Per-model request fields and response reading (lib/ai/model-params.ts), and
 * the request the real scorers build with them. The scorers run against a
 * fake Anthropic client (cv-scoring-test-hook.mjs), so nothing leaves the
 * machine; the request each one sends is captured and compared.
 *
 *   node --test src/lib/ai/model-params.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const {
  acceptsTemperature,
  assertCompleteStop,
  extractText,
  IncompleteModelResponseError,
  NoTextBlockError,
  thinkingOffParams,
} = await import("./model-params.ts");
const { TerminalJobError } = await import("../queue/failure-class.ts");
const { scoreCv } = await import("./cv-scoring.ts");
const { scoreAnswer } = await import("./interview-scoring.ts");
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");

/* ── acceptsTemperature ─────────────────────────────────────────── */

test("temperature: accepted by the 4.x models that take it, refused by 5.x and anything unknown", () => {
  for (const model of [
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
  ]) {
    assert.equal(acceptsTemperature(model), true, model);
  }
  for (const model of [
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-sonnet-5",
    "claude-opus-5-5",
    "claude-fable-5-1",
    // 4.x by name, but the docs say both reject sampling parameters.
    "claude-opus-4-7",
    "claude-opus-4-8",
    "gpt-4o",
    "claude-4",
    "",
    "not-a-model",
  ]) {
    assert.equal(acceptsTemperature(model), false, model);
  }
});

/* ── thinkingOffParams ──────────────────────────────────────────── */

test("thinking off: disabled on Haiku 5.5, between_tools on Sonnet 5.5, nothing for the 4.x line or unknowns", () => {
  assert.deepEqual(thinkingOffParams("claude-haiku-5-5"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingOffParams("claude-sonnet-5-5"), {
    thinking: { type: "between_tools" },
  });
  for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5-20251001", "claude-opus-5-5", "x"]) {
    assert.deepEqual(thinkingOffParams(model), {}, model);
  }
});

/* ── extractText / assertCompleteStop ───────────────────────────── */

test("extractText: skips a leading thinking block and returns the first text block", () => {
  const response = {
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"a":1}' },
      { type: "text", text: "second" },
    ],
    stop_reason: "end_turn",
  };
  assert.equal(extractText(response), '{"a":1}');
  assert.equal(
    extractText({ content: [{ type: "text", text: "" }] }),
    "",
    "empty text is still text",
  );
});

test("extractText: no text block is a named, terminal error", () => {
  for (const content of [[], [{ type: "thinking", thinking: "", signature: "s" }]]) {
    assert.throws(
      () => extractText({ content }, "claude-haiku-5-5"),
      (err) =>
        err instanceof NoTextBlockError &&
        err instanceof TerminalJobError &&
        err.failureClass === "deterministic" &&
        err.name === "NoTextBlockError" &&
        /claude-haiku-5-5/.test(err.message),
    );
  }
});

test("assertCompleteStop: throws on max_tokens and refusal with the stop reason, passes otherwise", () => {
  const secret = "Candidate Jane Example, jane@example.com";
  for (const stop of ["max_tokens", "refusal"]) {
    assert.throws(
      () => assertCompleteStop({ content: [{ type: "text", text: secret }], stop_reason: stop }),
      (err) =>
        err instanceof IncompleteModelResponseError &&
        err instanceof TerminalJobError &&
        err.failureClass === "deterministic" &&
        err.stopReason === stop &&
        err.message.includes(stop) &&
        !err.message.includes("Jane") &&
        !err.message.includes("@"),
      stop,
    );
  }
  for (const stop of ["end_turn", "stop_sequence", null, undefined]) {
    assert.doesNotThrow(() => assertCompleteStop({ content: [], stop_reason: stop }), String(stop));
  }
});

/* ── the request the real scorers send ──────────────────────────── */

const CV_TEXT = `${"Senior engineer with eight years building payment systems in TypeScript. ".repeat(4)}`;

const SCORE_INPUT = {
  cvText: CV_TEXT,
  screeningAnswers: [],
  candidate: {
    yearsExperience: 8,
    city: null,
    country: null,
    noticePeriod: null,
    availability: null,
  },
  job: {
    title: "Backend Engineer",
    description: "Build payment services.",
    responsibilities: "Own the ledger.",
    requirements: "TypeScript",
    experienceLevel: "senior",
    category: "Engineering",
    screeningQuestions: [],
  },
};

const SCORECARD_JSON = JSON.stringify({
  verdict: "Good match.",
  overall_score: 74,
  dimension_scores: SCORE_DIMENSIONS.map((dimension) => ({
    dimension,
    score: 70,
    reasoning: "r",
    quote: "",
  })),
  strengths: [],
  missing_requirements: [],
  concerns: [],
  confidence: "high",
  summary: "s",
  must_haves: [],
});

const ANSWER_JSON = JSON.stringify({
  score: 70,
  confidence: "high",
  reasoning: "r",
  strengths: [],
  concerns: [],
  missing: [],
});

const textReply = (text, over = {}) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
  ...over,
});

/** Install a fake client that records each request and answers with `reply`. */
function fakeModel(reply) {
  const requests = [];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params) => {
        requests.push(params);
        return reply;
      },
    },
  };
  return requests;
}

/** Run `fn` with AI_SCORING_MODEL set to `model` (or unset), and console quiet. */
async function withModel(model, fn) {
  const before = process.env.AI_SCORING_MODEL;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  if (model === undefined) delete process.env.AI_SCORING_MODEL;
  else process.env.AI_SCORING_MODEL = model;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.AI_SCORING_MODEL;
    else process.env.AI_SCORING_MODEL = before;
    Object.assign(console, quiet);
  }
}

const ANSWER_INPUT = {
  questionText: "Tell me about a hard bug.",
  competency: null,
  rubric: null,
  transcript: "I traced a race in the ledger writer and fixed the lock ordering.",
};

test("production is unchanged: on the default Sonnet 4.5 both scorers send temperature 0 and no thinking field", async () => {
  await withModel(undefined, async () => {
    const cv = fakeModel(textReply(SCORECARD_JSON));
    await scoreCv(SCORE_INPUT);
    assert.equal(cv.length, 1);
    assert.equal(cv[0].model, "claude-sonnet-4-5");
    assert.deepEqual(Object.keys(cv[0]), [
      "model",
      "max_tokens",
      "temperature",
      "system",
      "messages",
    ]);
    assert.equal(cv[0].temperature, 0);
    assert.equal(cv[0].max_tokens, 3000);
    assert.equal("thinking" in cv[0], false);

    const answer = fakeModel(textReply(ANSWER_JSON));
    await scoreAnswer(ANSWER_INPUT);
    assert.deepEqual(Object.keys(answer[0]), [
      "model",
      "max_tokens",
      "temperature",
      "system",
      "messages",
    ]);
    assert.equal(answer[0].temperature, 0);
    assert.equal(answer[0].max_tokens, 2000);
    assert.equal("thinking" in answer[0], false);
  });
});

test("an explicit claude-sonnet-4-5 is the same request as the default", async () => {
  const unset = await withModel(undefined, async () => {
    const r = fakeModel(textReply(SCORECARD_JSON));
    await scoreCv(SCORE_INPUT);
    return r[0];
  });
  const set = await withModel("claude-sonnet-4-5", async () => {
    const r = fakeModel(textReply(SCORECARD_JSON));
    await scoreCv(SCORE_INPUT);
    return r[0];
  });
  assert.deepEqual(set, unset);
});

test("Sonnet 5.5: no temperature, thinking between_tools, and a leading thinking block is read past", async () => {
  await withModel("claude-sonnet-5-5", async () => {
    const thinkingFirst = {
      ...textReply(SCORECARD_JSON),
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: SCORECARD_JSON },
      ],
    };
    const cv = fakeModel(thinkingFirst);
    const card = await scoreCv(SCORE_INPUT);
    assert.equal(card.overall_score >= 0, true, "scored");
    assert.equal("temperature" in cv[0], false);
    assert.deepEqual(cv[0].thinking, { type: "between_tools" });
    assert.equal(cv[0].max_tokens, 3000, "max_tokens untouched");

    const answer = fakeModel({
      ...textReply(ANSWER_JSON),
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: ANSWER_JSON },
      ],
    });
    const scored = await scoreAnswer(ANSWER_INPUT);
    assert.equal(scored.score, 70);
    assert.equal("temperature" in answer[0], false);
    assert.deepEqual(answer[0].thinking, { type: "between_tools" });
  });
});

test("Haiku 5.5: no temperature, thinking disabled", async () => {
  await withModel("claude-haiku-5-5", async () => {
    const cv = fakeModel(textReply(SCORECARD_JSON));
    await scoreCv(SCORE_INPUT);
    assert.equal("temperature" in cv[0], false);
    assert.deepEqual(cv[0].thinking, { type: "disabled" });
    const answer = fakeModel(textReply(ANSWER_JSON));
    await scoreAnswer(ANSWER_INPUT);
    assert.equal("temperature" in answer[0], false);
    assert.deepEqual(answer[0].thinking, { type: "disabled" });
  });
});

test("a max_tokens or refusal stop leaves the scorer as a terminal error, not swallowed or parsed", async () => {
  for (const model of [undefined, "claude-sonnet-5-5"]) {
    for (const stop of ["max_tokens", "refusal"]) {
      await withModel(model, async () => {
        fakeModel(textReply(SCORECARD_JSON, { stop_reason: stop }));
        await assert.rejects(
          scoreCv(SCORE_INPUT),
          (err) => err instanceof IncompleteModelResponseError && err.stopReason === stop,
        );
        fakeModel(textReply(ANSWER_JSON, { stop_reason: stop }));
        await assert.rejects(
          scoreAnswer(ANSWER_INPUT),
          (err) => err instanceof IncompleteModelResponseError && err.stopReason === stop,
        );
      });
    }
  }
});

test("a reply with no text block is a terminal error from both scorers", async () => {
  await withModel("claude-haiku-5-5", async () => {
    const onlyThinking = {
      content: [{ type: "thinking", thinking: "", signature: "s" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    fakeModel(onlyThinking);
    await assert.rejects(scoreCv(SCORE_INPUT), (err) => err instanceof NoTextBlockError);
    fakeModel(onlyThinking);
    await assert.rejects(scoreAnswer(ANSWER_INPUT), (err) => err instanceof NoTextBlockError);
  });
});
