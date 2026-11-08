/**
 * The scorecard's confidence is never left at the model's own value when a
 * question went unscored. Scoring that failed already set it low; a transcript
 * that failed, an answer too thin to assess and a question never answered now
 * do the same. Every question scored leaves the model's value alone.
 *
 *   node --test src/lib/ai/interview-scoring-confidence.test.ts
 *
 * handleAiScorecard is the shipped code; the model is the fake installed by
 * cv-scoring-test-hook.mjs and the database is fake-postgrest. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiScorecard } = await import("./interview-scoring.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const SAID =
  "I traced a race in the ledger writer, reproduced it with two workers, and fixed the lock ordering so retries were safe.";
const reply = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 20 },
});
const ANSWER = reply({
  score: 70,
  confidence: "high",
  reasoning: "r",
  strengths: [],
  concerns: [],
  missing: [],
});
const ROLLUP = (confidence) =>
  reply({ verdict: "Fine.", summary: "One. Two.", confidence, criteria: [] });

const answer = (position, over = {}) => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${position}`,
  position,
  question_text: `Question ${position}?`,
  transcript: SAID,
  transcript_status: "done",
  video_path: `v/${position}.webm`,
  recorded_at: "2026-10-01T00:00:00Z",
  duration_seconds: 60,
  transcript_duration_seconds: 60,
  transcript_segments: null,
  ...over,
});

async function scorecard({ answers, snapshot = null, rollup = "high", modelFails = false }) {
  const before = process.env.AI_INTERVIEW_SCORING_ENABLED;
  process.env.AI_INTERVIEW_SCORING_ENABLED = "true";
  globalThis.__cvScoringEventsForTests = [];
  const service = fakeService((table, calls) => {
    if (calls.some((c) => ["upsert", "insert", "update", "delete"].includes(c[0]))) {
      return { data: null, error: null };
    }
    if (table === "interview_sessions") {
      return {
        data: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          company_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          job_id: "job-1",
          status: "submitted",
          questions_snapshot: snapshot,
          scoring_snapshot: null,
        },
        error: null,
      };
    }
    if (table === "interview_answers") return { data: answers, error: null };
    if (table === "jobs") return { data: { interview_criteria: [] }, error: null };
    if (table === "interview_questions") {
      return {
        data: [1, 2].map((p) => ({
          id: `q${p}`,
          position: p,
          question: `Question ${p}?`,
          competency: null,
          rubric: null,
          weight: 1,
        })),
        error: null,
      };
    }
    if (table === "interview_answer_scores") return { data: [], error: null };
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  const calls = [];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params) => {
        calls.push(params);
        const isRollup = JSON.stringify(params).includes("Overall score");
        if (isRollup) return ROLLUP(rollup);
        if (modelFails && calls.length === 2) {
          const err = new Error("bad request");
          err.status = 400;
          throw err;
        }
        return ANSWER;
      },
    },
  };
  try {
    await handleAiScorecard({
      id: "bg-1",
      payload: { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
  } catch {
    // A deterministic model failure ends the job; the rows written before it still count.
  } finally {
    if (before === undefined) delete process.env.AI_INTERVIEW_SCORING_ENABLED;
    else process.env.AI_INTERVIEW_SCORING_ENABLED = before;
  }
  const upserts = (t) =>
    service.queries
      .filter((q) => q.table === t)
      .flatMap((q) => q.calls.filter((c) => c[0] === "upsert").map((c) => c[1]));
  return {
    session: upserts("interview_session_scores").at(-1),
    answers: upserts("interview_answer_scores"),
  };
}

test("every question scored: the model's own confidence is kept", async () => {
  for (const rollup of ["high", "medium", "low"]) {
    const r = await scorecard({ answers: [answer(1), answer(2)], rollup });
    assert.equal(r.session.status, "scored");
    assert.equal(r.session.confidence, rollup, rollup);
  }
});

test("one transcript failed, the other done: confidence low", async () => {
  const r = await scorecard({
    answers: [answer(1), answer(2, { transcript: null, transcript_status: "failed" })],
  });
  assert.equal(r.session.status, "scored");
  assert.equal(r.session.confidence, "low");
  assert.ok(r.answers.some((a) => a.status === "skipped"));
});

test("one answer too thin to assess: confidence low", async () => {
  const r = await scorecard({ answers: [answer(1), answer(2, { transcript: "um yes" })] });
  assert.equal(r.session.status, "scored");
  assert.equal(r.session.confidence, "low");
});

test("a question never answered: confidence low", async () => {
  const r = await scorecard({
    answers: [answer(1)],
    snapshot: [
      { id: "q1", position: 1, question: "Question 1?" },
      { id: "q2", position: 2, question: "Question 2?" },
    ],
  });
  assert.equal(r.session.status, "scored");
  assert.equal(r.session.confidence, "low");
});
