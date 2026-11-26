/**
 * #40: async interview scoring on GPT-6 Luna, through the whole scorecard
 * handler. With AI_INTERVIEW_SCORING_MODEL=gpt-6-luna every call goes to
 * OpenAI, and both score tables record that model and the current prompt
 * version, so a stored row proves which model scored it.
 *
 *   node --test src/lib/ai/interview-scoring-luna.test.ts
 *
 * handleAiScorecard is the shipped code. OpenAI is a fake fetch, Anthropic a
 * fake client that must never be called on Luna, and the database is
 * fake-postgrest. Nothing leaves the machine. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiScorecard, PROMPT_VERSION } = await import("./interview-scoring.ts");
const { EMPLOYMENT_GAP_IN_INTERVIEWS, EMPLOYMENT_GAP_RULE } = await import("./fairness.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const LUNA = "gpt-6-luna";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAID =
  "I traced a race in the ledger writer, reproduced it with two workers, and fixed the lock ordering so retries were safe.";
const ANSWER = {
  score: 72,
  confidence: "high",
  reasoning: "r",
  strengths: [],
  concerns: [],
  missing: [],
};
const ROLLUP = {
  verdict: "Solid on evidence.",
  summary: "One. Two.",
  confidence: "high",
  criteria: [],
};

const answer = (position) => ({
  id: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${position}`,
  position,
  question_text: `Question ${position}?`,
  transcript: SAID,
  transcript_status: "done",
  video_path: `v/${position}.webm`,
  recorded_at: "2026-11-26T00:00:00Z",
  duration_seconds: 60,
  transcript_duration_seconds: 60,
  transcript_segments: null,
});

const ENV = [
  "AI_INTERVIEW_SCORING_ENABLED",
  "AI_INTERVIEW_SCORING_MODEL",
  "AI_SCORING_MODEL",
  "OPENAI_API_KEY",
];

/** Run one ai_scorecard job for a two-answer session; answers what was sent and stored. */
async function scorecard(env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { AI_INTERVIEW_SCORING_ENABLED: "true", ...env });

  const service = fakeService((table, calls) => {
    if (calls.some((c) => ["upsert", "insert", "update", "delete"].includes(c[0]))) {
      return { data: null, error: null };
    }
    if (table === "interview_sessions") {
      return {
        data: {
          id: SESSION_ID,
          company_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          job_id: "job-1",
          kind: "async",
          status: "submitted",
          questions_snapshot: null,
          scoring_snapshot: null,
          delete_after: null,
        },
        error: null,
      };
    }
    if (table === "interview_answers") return { data: [answer(1), answer(2)], error: null };
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
  globalThis.__cvScoringEventsForTests = [];

  const anthropic = [];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params) => {
        anthropic.push(params);
        const text = JSON.stringify(
          JSON.stringify(params).includes("Overall score") ? ROLLUP : ANSWER,
        );
        return {
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  };
  const openai = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body);
    openai.push(body);
    const value = JSON.stringify(body).includes("Overall score") ? ROLLUP : ANSWER;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: body.model,
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      { status: 200 },
    );
  };

  try {
    await handleAiScorecard({ id: "bg-luna", payload: { sessionId: SESSION_ID } });
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.__cvScoringServiceForTests;
    delete globalThis.__cvScoringAnthropicForTests;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const upserts = (t) =>
    service.queries
      .filter((q) => q.table === t)
      .flatMap((q) => q.calls.filter((c) => c[0] === "upsert").map((c) => c[1]))
      .flat();
  return {
    session: upserts("interview_session_scores").at(-1),
    answers: upserts("interview_answer_scores"),
    openai,
    anthropic,
  };
}

test("the version this scores under", () => {
  assert.equal(PROMPT_VERSION, "interview-scoring-v11");
});

test("AI_INTERVIEW_SCORING_MODEL=gpt-6-luna: both tables store Luna and v11, status scored, every call to OpenAI", async () => {
  const r = await scorecard({ AI_INTERVIEW_SCORING_MODEL: LUNA, OPENAI_API_KEY: "sk-test-fake" });

  assert.equal(r.session.status, "scored");
  assert.equal(r.session.ai_model, LUNA);
  assert.equal(r.session.prompt_version, "interview-scoring-v11");
  assert.equal(r.session.overall_score, 72);
  assert.equal(r.session.verdict, "Solid on evidence.");
  assert.ok(r.session.summary?.startsWith("One. Two."));

  const scored = r.answers.filter((a) => a.status === "scored");
  assert.equal(scored.length, 2, "both answers scored");
  for (const a of scored) {
    assert.equal(a.ai_model, LUNA);
    assert.equal(a.prompt_version, "interview-scoring-v11");
    assert.equal(a.score, 72);
  }

  assert.equal(r.anthropic.length, 0, "Anthropic never called");
  assert.equal(r.openai.length, 3, "two answers and the summary");
  for (const body of r.openai) {
    assert.equal(body.model, LUNA);
    // The fields Luna receives: openai-chat.ts buildOpenAIChatBody.
    assert.equal(body.temperature, 0);
    assert.equal(body.seed, 1234);
    assert.equal(body.reasoning_effort, "none");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.store, false);
    assert.equal("max_tokens" in body, false, "OpenAI's name is max_completion_tokens");
    assert.equal("thinking" in body, false);
    // The rule reaches the model in both prompts.
    assert.ok(
      body.messages[0].content.includes(`${EMPLOYMENT_GAP_RULE} ${EMPLOYMENT_GAP_IN_INTERVIEWS}`),
    );
  }
  assert.deepEqual(
    r.openai.map((b) => b.max_completion_tokens).sort((a, b) => a - b),
    [700, 2000, 2000],
  );
});

// Negative control: the env var unset, the same job is not scored on Luna.
test("AI_INTERVIEW_SCORING_MODEL unset: the rows do not say gpt-6-luna, and OpenAI is never called", async () => {
  const r = await scorecard({ OPENAI_API_KEY: "sk-test-fake" });
  assert.equal(r.session.status, "scored");
  assert.notEqual(r.session.ai_model, LUNA);
  assert.equal(r.session.ai_model, "claude-haiku-5-5", "the CV setting's default");
  for (const a of r.answers.filter((x) => x.status === "scored")) {
    assert.notEqual(a.ai_model, LUNA);
  }
  assert.equal(r.openai.length, 0);
  assert.equal(r.anthropic.length, 3);
});
