/**
 * The [provider-call] log line names the provider that actually answered: a
 * gpt-* model logs "openai", a claude-* model "anthropic", on the success and
 * the error path of all three scoring call sites (CV score, interview answer,
 * session summary). Anthropic and fetch are both faked (cv-scoring-test-hook.mjs
 * stubs @/lib/anthropic); nothing leaves the machine.
 *
 *   node --test src/lib/ai/provider-label.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { scoringProvider } = await import("./scoring-transport.ts");
const { scoreCv } = await import("./cv-scoring.ts");
const { scoreAnswer, summariseSession } = await import("./interview-scoring.ts");
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");

const SCORECARD = JSON.stringify({
  verdict: "v",
  overall_score: 70,
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
const ANSWER = JSON.stringify({
  score: 64,
  confidence: "high",
  reasoning: "r",
  strengths: [],
  concerns: [],
  missing: [],
});
const ROLLUP = JSON.stringify({ verdict: "v", summary: "s", confidence: "high", criteria: [] });

const CV_INPUT = {
  cvText: "Senior engineer with eight years building payment systems in TypeScript. ".repeat(4),
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
    description: "Build payments.",
    responsibilities: "Own the ledger.",
    requirements: "TypeScript",
    experienceLevel: "Expert",
    category: "Engineering",
    screeningQuestions: [],
  },
};
const ANSWER_INPUT = {
  questionText: "Tell me about a hard bug.",
  competency: null,
  rubric: null,
  transcript:
    "I traced a race in the ledger writer and fixed the lock ordering so retries stopped.",
};
const ROLLUP_INPUT = {
  overall: 64,
  coverage: { questionsAsked: 1, answersRecorded: 1, answersScored: 1, unscored: [] },
  answers: [
    { position: 1, questionText: "Q", competency: null, score: 64, strengths: [], concerns: [] },
  ],
};

const ENV = ["AI_SCORING_MODEL", "AI_INTERVIEW_SCORING_MODEL", "OPENAI_API_KEY"];

/**
 * Run `fn` with the model set, both providers faked (succeeding with `text`,
 * or failing when `fail` is true), and every console line captured. Returns
 * the parsed [provider-call] entries.
 */
async function providerLines(model, text, fn, { fail = false } = {}) {
  const before = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.AI_SCORING_MODEL = model;
  process.env.OPENAI_API_KEY = "sk-test-fake";
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.map(String).join(" "));
  console.warn = console.error = () => {};
  const reply = {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async () => {
        if (fail) throw Object.assign(new Error("overloaded"), { status: 529 });
        return reply;
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    fail
      ? { ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error" } }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ finish_reason: "stop", message: { content: text } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        };
  try {
    await fn().catch(() => {});
  } finally {
    Object.assign(console, orig);
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
  return lines
    .filter((l) => l.startsWith("[provider-call] "))
    .map((l) => JSON.parse(l.slice("[provider-call] ".length)));
}

const SITES = [
  ["cv", SCORECARD, () => scoreCv(CV_INPUT)],
  ["answer", ANSWER, () => scoreAnswer(ANSWER_INPUT)],
  ["rollup", ROLLUP, () => summariseSession(ROLLUP_INPUT)],
];
const MODELS = [
  ["gpt-6-luna", "openai"],
  ["claude-haiku-5-5", "anthropic"],
  ["claude-sonnet-4-5", "anthropic"],
];

test("scoringProvider: gpt-* is openai, everything else anthropic", () => {
  assert.equal(scoringProvider("gpt-6-luna"), "openai");
  assert.equal(scoringProvider("gpt-5"), "openai");
  for (const m of ["claude-haiku-5-5", "claude-sonnet-4-5", "claude-opus-4-8", ""]) {
    assert.equal(scoringProvider(m), "anthropic", m);
  }
});

for (const [model, provider] of MODELS) {
  test(`${model}: every site logs provider "${provider}" on success`, async () => {
    for (const [site, text, run] of SITES) {
      const entries = await providerLines(model, text, run);
      assert.equal(entries.length, 1, `${site}: one provider-call line`);
      assert.equal(entries[0].provider, provider, site);
      assert.equal(entries[0].model, model, site);
      assert.equal(entries[0].outcome, "ok", site);
    }
  });

  test(`${model}: every site logs provider "${provider}" on a provider error`, async () => {
    for (const [site, text, run] of SITES) {
      const entries = await providerLines(model, text, run, { fail: true });
      assert.equal(entries.length, 1, `${site}: one provider-call line`);
      assert.equal(entries[0].provider, provider, site);
      assert.equal(entries[0].outcome, "error", site);
      assert.equal(entries[0].failureClass, "retryable", site);
    }
  });
}

test("transcription keeps its own label", async () => {
  const { readFileSync } = await import("node:fs");
  const transcribe = readFileSync(new URL("../interviews/transcribe.ts", import.meta.url), "utf8");
  assert.equal((transcribe.match(/provider: "openai-whisper"/g) ?? []).length, 3);
});
