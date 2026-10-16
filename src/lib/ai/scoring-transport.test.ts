/**
 * The scoring transport: claude-* requests reach Anthropic untouched, gpt-*
 * requests reach OpenAI, and the three call sites (CV score, interview answer,
 * session summary) work through it. Anthropic and fetch are both faked
 * (cv-scoring-test-hook.mjs stubs @/lib/anthropic); nothing leaves the machine.
 *
 *   node --test src/lib/ai/scoring-transport.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { createScoringMessage } = await import("./scoring-transport.ts");
const { scoreCv } = await import("./cv-scoring.ts");
const { scoreAnswer, summariseSession, resolveInterviewScoringModel } = await import(
  "./interview-scoring.ts"
);
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");

const ENV = [
  "AI_SCORING_MODEL",
  "AI_INTERVIEW_SCORING_MODEL",
  "OPENAI_API_KEY",
  "AI_SCORING_THINKING",
];
async function withEnv(values, fn) {
  const before = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    for (const k of ENV) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    Object.assign(console, quiet);
  }
}

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

/** Fake both providers; record who was called with what. */
function fakes(text) {
  const anthropic = [];
  const openai = [];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (request, options) => {
        anthropic.push({ request, options });
        return {
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    openai.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: "stop", message: { content: text } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    };
  };
  return { anthropic, openai, restore: () => (globalThis.fetch = original) };
}

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
  transcript: "I traced a race in the ledger writer and fixed the lock ordering.",
};
const ROLLUP_INPUT = {
  overall: 70,
  coverage: { questionsAsked: 1, answersRecorded: 1, answersScored: 1, unscored: [] },
  answers: [
    { position: 1, questionText: "Q", competency: null, score: 70, strengths: [], concerns: [] },
  ],
};

test("claude-* goes to Anthropic with the very same request and options objects; OpenAI is never called", async () => {
  const f = fakes(SCORECARD);
  try {
    const request = {
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      temperature: 0,
      system: "s",
      messages: [{ role: "user", content: "u" }],
    };
    const options = { timeout: 1000, maxRetries: 0 };
    await createScoringMessage(request, options);
    assert.equal(f.anthropic.length, 1);
    assert.equal(f.anthropic[0].request, request, "same object, not a copy");
    assert.equal(f.anthropic[0].options, options);
    assert.equal(f.openai.length, 0);
  } finally {
    f.restore();
  }
});

test("gpt-* goes to OpenAI; Anthropic is never called", async () => {
  const f = fakes(SCORECARD);
  try {
    await withEnv({ OPENAI_API_KEY: "sk-test-fake" }, () =>
      createScoringMessage({
        model: "gpt-6-luna",
        max_tokens: 3000,
        system: "s",
        messages: [{ role: "user", content: "u" }],
      }),
    );
    assert.equal(f.openai.length, 1);
    assert.equal(f.anthropic.length, 0);
  } finally {
    f.restore();
  }
});

test("all three call sites, model unset: Anthropic, claude-sonnet-4-5, today's fields", async () => {
  const sites = [
    ["cv", SCORECARD, () => scoreCv(CV_INPUT), 3000],
    ["answer", ANSWER, () => scoreAnswer(ANSWER_INPUT), 2000],
    ["rollup", ROLLUP, () => summariseSession(ROLLUP_INPUT), 700],
  ];
  for (const [site, text, run, max] of sites) {
    const f = fakes(text);
    try {
      await withEnv({}, run);
      assert.equal(f.openai.length, 0, site);
      assert.equal(f.anthropic.length, 1, site);
      const { request } = f.anthropic[0];
      assert.deepEqual(
        Object.keys(request),
        ["model", "max_tokens", "temperature", "system", "messages"],
        site,
      );
      assert.equal(request.model, "claude-sonnet-4-5");
      assert.equal(request.max_tokens, max);
      assert.equal(request.temperature, 0);
    } finally {
      f.restore();
    }
  }
});

test("all three call sites on gpt-6-luna: OpenAI, the reply parsed and verified as usual", async () => {
  const env = { AI_SCORING_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-fake" };
  let f = fakes(SCORECARD);
  try {
    const card = await withEnv(env, () => scoreCv(CV_INPUT));
    assert.equal(card.overall_score, 70);
    assert.equal(card.ai_model, "gpt-6-luna");
    assert.equal(f.anthropic.length, 0);
    assert.equal(f.openai[0].body.model, "gpt-6-luna");
    assert.equal(f.openai[0].body.store, false);
    assert.equal(f.openai[0].body.max_completion_tokens, 3000);
  } finally {
    f.restore();
  }
  f = fakes(ANSWER);
  try {
    const a = await withEnv(env, () => scoreAnswer(ANSWER_INPUT));
    assert.equal(a.score, 64);
    assert.equal(f.openai.length, 1);
    assert.equal(f.anthropic.length, 0);
  } finally {
    f.restore();
  }
  f = fakes(ROLLUP);
  try {
    const r = await withEnv(env, () => summariseSession(ROLLUP_INPUT));
    assert.equal(r.summary, "s");
    assert.equal(f.openai.length, 1);
    assert.equal(f.openai[0].body.max_completion_tokens, 700);
  } finally {
    f.restore();
  }
});

test("interview model: unset falls back to AI_SCORING_MODEL; set, it is its own", async () => {
  assert.equal(await withEnv({}, () => resolveInterviewScoringModel()), "claude-sonnet-4-5");
  assert.equal(
    await withEnv({ AI_SCORING_MODEL: "claude-haiku-5-5" }, () => resolveInterviewScoringModel()),
    "claude-haiku-5-5",
  );
  assert.equal(
    await withEnv(
      { AI_SCORING_MODEL: "claude-haiku-5-5", AI_INTERVIEW_SCORING_MODEL: "gpt-6-luna" },
      () => resolveInterviewScoringModel(),
    ),
    "gpt-6-luna",
  );
  assert.equal(
    await withEnv({ AI_INTERVIEW_SCORING_MODEL: "  " }, () => resolveInterviewScoringModel()),
    "claude-sonnet-4-5",
    "blank = unset",
  );

  // Interview on OpenAI while CV scoring stays on Anthropic.
  const env = { AI_INTERVIEW_SCORING_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-fake" };
  let f = fakes(ANSWER);
  try {
    await withEnv(env, () => scoreAnswer(ANSWER_INPUT));
    await withEnv(env, () => summariseSession(ROLLUP_INPUT));
    assert.equal(f.openai.length, 2, "answer and summary on OpenAI");
    assert.equal(f.anthropic.length, 0);
  } finally {
    f.restore();
  }
  f = fakes(SCORECARD);
  try {
    await withEnv(env, () => scoreCv(CV_INPUT));
    assert.equal(f.anthropic.length, 1, "CV scoring unchanged");
    assert.equal(f.anthropic[0].request.model, "claude-sonnet-4-5");
    assert.equal(f.openai.length, 0);
  } finally {
    f.restore();
  }
});
