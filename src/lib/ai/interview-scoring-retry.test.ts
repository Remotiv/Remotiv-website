/**
 * Interview scoring: the single retry of a reply that could not be parsed, and
 * the verdict cut (lib/ai/interview-scoring.ts). The model is a fake installed
 * by cv-scoring-test-hook.mjs; the database, where a test needs one, is
 * fake-postgrest. Nothing leaves the machine.
 *
 *   node --test src/lib/ai/interview-scoring-retry.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiScorecard, scoreAnswer, summariseSession } = await import("./interview-scoring.ts");
const { IncompleteModelResponseError } = await import("./model-params.ts");
const { TerminalJobError } = await import("../queue/failure-class.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const ANSWER_JSON = JSON.stringify({
  score: 64,
  confidence: "high",
  reasoning: "r",
  strengths: [],
  concerns: [],
  missing: [],
});
const ROLLUP_JSON = (verdict = "v") =>
  JSON.stringify({ verdict, summary: "One. Two.", confidence: "high", criteria: [] });
const NOT_JSON = "Sure! Here is the assessment: {score: 64";
const WRONG_SHAPE = JSON.stringify({ score: "high", confidence: "high", reasoning: "r" });

const reply = (text, stop = "end_turn", usage = { input_tokens: 100, output_tokens: 20 }) => ({
  content: [{ type: "text", text }],
  stop_reason: stop,
  usage,
});

/**
 * Install a fake model answering from `script` in call order: a reply object,
 * an Error to throw, or a function of the call index. `after` runs once a call
 * completes (used to shrink the time budget). Returns the recorded calls.
 */
function fakeModel(script, { after } = {}) {
  const calls = [];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params, options) => {
        const i = calls.length;
        calls.push({ params, options });
        const step = script[Math.min(i, script.length - 1)];
        const value = typeof step === "function" ? step(i) : step;
        after?.(i);
        if (value instanceof Error) throw value;
        return value;
      },
    },
  };
  return calls;
}

const ANSWER_INPUT = {
  questionText: "Tell me about a hard bug.",
  competency: null,
  rubric: null,
  transcript:
    "I traced a race in the ledger writer, reproduced it with two workers, and fixed the lock ordering so retries stopped double-posting.",
};

/** A job context with `remaining` ms left, which a test can change mid-run. */
function ctxWith(remaining) {
  const state = { remaining };
  return {
    state,
    ctx: {
      deadlineAt: Date.now() + remaining,
      signal: new AbortController().signal,
      remainingMs: () => state.remaining,
    },
  };
}

/* ── per-answer scoring ─────────────────────────────────────────── */

test("a reply that is not JSON is tried once more with the same request; both replies' tokens count", async () => {
  for (const broken of [NOT_JSON, WRONG_SHAPE]) {
    const calls = fakeModel([
      reply(broken, "end_turn", { input_tokens: 100, output_tokens: 7 }),
      reply(ANSWER_JSON, "end_turn", { input_tokens: 100, output_tokens: 20 }),
    ]);
    const result = await scoreAnswer(ANSWER_INPUT);
    assert.equal(calls.length, 2, "exactly one retry");
    assert.equal(calls[1].params, calls[0].params, "the very same request object");
    assert.equal(result.score, 64);
    assert.equal(result.inputTokens, 200, "input tokens of both attempts");
    assert.equal(result.outputTokens, 27, "output tokens of both attempts");
  }
});

test("broken twice: today's terminal error, after exactly two calls", async () => {
  const calls = fakeModel([reply(NOT_JSON), reply(WRONG_SHAPE)]);
  await assert.rejects(
    scoreAnswer(ANSWER_INPUT),
    (err) =>
      err instanceof TerminalJobError &&
      err.failureClass === "deterministic" &&
      /malformed answer JSON/.test(err.message),
  );
  assert.equal(calls.length, 2);
});

test("billing, configuration, refusal and max_tokens are never retried: one call, today's error", async () => {
  const cases = [
    [
      new TerminalJobError("billing", "credit balance is too low"),
      (e) => e.failureClass === "billing",
    ],
    [
      Object.assign(new Error("invalid x-api-key"), { status: 401 }),
      (e) => e instanceof TerminalJobError && e.failureClass === "configuration",
    ],
    [
      reply("", "refusal"),
      (e) => e instanceof IncompleteModelResponseError && e.stopReason === "refusal",
    ],
    [
      reply("{", "max_tokens"),
      (e) => e instanceof IncompleteModelResponseError && e.stopReason === "max_tokens",
    ],
  ];
  for (const [first, check] of cases) {
    const calls = fakeModel([first, reply(ANSWER_JSON)]);
    await assert.rejects(scoreAnswer(ANSWER_INPUT), check);
    assert.equal(calls.length, 1, `${first?.message ?? first.stop_reason}: no retry`);
  }
});

test("no time left for another call: no retry, the job fails as it always did", async () => {
  const { ctx, state } = ctxWith(25_000);
  const calls = fakeModel([reply(NOT_JSON), reply(ANSWER_JSON)], {
    after: () => {
      state.remaining = 10_000; // below MIN_PROVIDER_CALL_BUDGET_MS once the first call returns
    },
  });
  await assert.rejects(scoreAnswer(ANSWER_INPUT, ctx), /malformed answer JSON/);
  assert.equal(calls.length, 1);
  // With time left the same context does retry, with a fresh timeout inside the budget.
  const again = ctxWith(50_000);
  const calls2 = fakeModel([reply(NOT_JSON), reply(ANSWER_JSON)]);
  const r = await scoreAnswer(ANSWER_INPUT, again.ctx);
  assert.equal(r.score, 64);
  assert.equal(calls2.length, 2);
  assert.equal(calls2[1].options.timeout, 45_000);
  assert.equal(calls2[1].options.maxRetries, 0);
});

/* ── session summary ────────────────────────────────────────────── */

const ROLLUP_INPUT = {
  overall: 64,
  coverage: { questionsAsked: 1, answersRecorded: 1, answersScored: 1, unscored: [] },
  answers: [
    {
      position: 1,
      questionText: "Q",
      competency: null,
      score: 64,
      strengths: ["found the race"],
      concerns: [],
    },
  ],
};

test("rollup: a reply that is not a JSON object is tried once more; twice broken gives today's empty rollup", async () => {
  let calls = fakeModel([reply(NOT_JSON), reply(ROLLUP_JSON("Clear and specific."))]);
  let r = await summariseSession(ROLLUP_INPUT);
  assert.equal(calls.length, 2);
  assert.equal(r.verdict, "Clear and specific.");
  assert.equal(r.summary, "One. Two.");

  calls = fakeModel([reply("[1, 2, 3]"), reply(NOT_JSON), reply(ROLLUP_JSON())]);
  r = await summariseSession(ROLLUP_INPUT);
  assert.equal(calls.length, 2, "one retry, not two");
  assert.deepEqual(r, { verdict: null, summary: null, confidence: "low", criteria: [] });

  // No time: one call, today's empty rollup.
  const { ctx, state } = ctxWith(25_000);
  calls = fakeModel([reply(NOT_JSON), reply(ROLLUP_JSON())], {
    after: () => {
      state.remaining = 10_000;
    },
  });
  r = await summariseSession(ROLLUP_INPUT, ctx);
  assert.equal(calls.length, 1);
  assert.equal(r.summary, null);

  // A refusal is not retried.
  calls = fakeModel([reply("", "refusal"), reply(ROLLUP_JSON())]);
  r = await summariseSession(ROLLUP_INPUT);
  assert.equal(calls.length, 1);
  assert.equal(r.verdict, null);
});

const words = (n, edit = {}) =>
  Array.from({ length: n }, (_, i) => edit[i] ?? `w${i + 1}`).join(" ");

test("verdict: up to 16 words kept whole; longer cut to 16 with an ellipsis, trailing connective dropped", async () => {
  const cases = [
    [words(12), words(12)],
    [words(14), words(14)],
    [words(16), words(16)],
    [words(20), `${words(16)}…`],
    // 16th word is "and": dropped, then the ellipsis.
    [words(20, { 15: "and" }), `${words(15)}…`],
    // A trailing comma goes; the word before it stays.
    [words(20, { 14: "with", 15: "pace," }), `${words(14)} with pace…`],
    // A trailing connective with a comma: both go.
    [words(20, { 15: "with," }), `${words(15)}…`],
    ["  Strong fit  for the role.  ", "Strong fit for the role."],
  ];
  for (const [given, expected] of cases) {
    fakeModel([reply(ROLLUP_JSON(given))]);
    const r = await summariseSession(ROLLUP_INPUT);
    assert.equal(r.verdict, expected, `${given.split(/\s+/).length} words`);
  }
  fakeModel([
    reply(JSON.stringify({ verdict: 7, summary: "s", confidence: "high", criteria: [] })),
  ]);
  assert.equal(
    (await summariseSession(ROLLUP_INPUT)).verdict,
    null,
    "a non-string verdict is null",
  );
});

/* ── through the real handler: nothing partial is ever stored ───── */

const SESSION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  company_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  job_id: "job-1",
  status: "submitted",
  questions_snapshot: null,
  scoring_snapshot: null,
};
const ANSWER_ROW = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  position: 1,
  question_text: "Tell me about a hard bug.",
  transcript: ANSWER_INPUT.transcript,
  transcript_status: "done",
  video_path: "v/1.webm",
  recorded_at: "2026-10-01T00:00:00Z",
  duration_seconds: 60,
  transcript_duration_seconds: 60,
  transcript_segments: null,
};

async function runHandler(script) {
  const before = process.env.AI_INTERVIEW_SCORING_ENABLED;
  process.env.AI_INTERVIEW_SCORING_ENABLED = "true";
  globalThis.__cvScoringEventsForTests = [];
  const service = fakeService((table, calls) => {
    if (calls.some((c) => ["upsert", "insert", "update", "delete"].includes(c[0]))) {
      return { data: null, error: null };
    }
    if (table === "interview_sessions") return { data: SESSION, error: null };
    if (table === "interview_answers") return { data: [ANSWER_ROW], error: null };
    if (table === "jobs") return { data: { interview_criteria: [] }, error: null };
    if (table === "interview_questions") {
      return {
        data: [
          {
            id: "q1",
            position: 1,
            question: ANSWER_ROW.question_text,
            competency: null,
            rubric: null,
            weight: 1,
          },
        ],
        error: null,
      };
    }
    if (table === "interview_answer_scores") return { data: [], error: null };
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  const calls = fakeModel(script);
  let error = null;
  try {
    await handleAiScorecard({ id: "bg-1", payload: { sessionId: SESSION.id } });
  } catch (err) {
    error = err;
  } finally {
    if (before === undefined) delete process.env.AI_INTERVIEW_SCORING_ENABLED;
    else process.env.AI_INTERVIEW_SCORING_ENABLED = before;
  }
  const rows = (table) =>
    service.queries
      .filter((q) => q.table === table)
      .flatMap((q) => q.calls.filter((c) => c[0] === "upsert").map((c) => c[1]));
  return {
    calls,
    error,
    answerRows: rows("interview_answer_scores"),
    sessionRows: rows("interview_session_scores"),
  };
}

test("handler: broken then valid stores the score after two answer calls", async () => {
  const r = await runHandler([reply(NOT_JSON), reply(ANSWER_JSON), reply(ROLLUP_JSON("Fine."))]);
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 3, "two answer calls and the rollup");
  const scored = r.answerRows.filter((row) => row.status === "scored");
  assert.equal(scored.length, 1);
  assert.equal(scored[0].score, 64);
  assert.equal(scored[0].input_tokens, 200);
  assert.equal(r.answerRows.filter((row) => row.status === "failed").length, 0);
  assert.equal(r.sessionRows.at(-1)?.verdict, "Fine.");
});

test("handler: broken twice stores a failed row for the answer and nothing partial", async () => {
  const r = await runHandler([reply(NOT_JSON), reply(WRONG_SHAPE), reply(ROLLUP_JSON("Fine."))]);
  const failed = r.answerRows.filter((row) => row.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].score, undefined, "no number on a failed row");
  assert.equal(r.answerRows.filter((row) => row.status === "scored").length, 0);
  assert.ok(r.calls.length >= 2);
  assert.deepEqual(r.calls[1].params, r.calls[0].params, "the retry is the same request");
});
