/**
 * F3: the async scorer never stores the candidate's words past the session's
 * delete_after (lib/interviews/async-score-purge.ts), through the real
 * handler: a job asked after the date scores nothing, a job that started
 * before it and finishes after it stores the numbers only, and a purge that
 * lands between the scorer's check and its write is undone at once. The model
 * is the fake from cv-scoring-test-hook.mjs; the clock is Date.now, moved by
 * the test. Every candidate here is synthetic.
 *
 *   node --test src/lib/ai/interview-scoring-retention.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiScorecard, RETENTION_SKIP_REASON } = await import("./interview-scoring.ts");
const { purgeAsyncScoreWords } = await import("../interviews/async-score-purge.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const T0 = Date.parse("2027-02-01T09:00:00.000Z");
const realNow = Date.now;
let clock = T0;

const TRANSCRIPT =
  "I traced a race in the ledger writer, reproduced it with two workers, and fixed the lock ordering so retries stopped double-posting.";
const ANSWER_JSON = JSON.stringify({
  score: 64,
  confidence: "high",
  reasoning: "Traced and fixed a concurrency bug.",
  strengths: [{ claim: "Reproduced the race", quote: "reproduced it with two workers" }],
  concerns: [{ claim: "No test mentioned", quote: "fixed the lock ordering" }],
  missing: ["How the fix was verified"],
});
const ROLLUP_JSON = JSON.stringify({
  verdict: "Solid debugging, verification unclear.",
  summary: "Question 1 showed a clear fix. Verification was not covered.",
  confidence: "high",
  criteria: [{ item: "Owns outcomes", status: "evidenced", quote: "fixed the lock ordering" }],
});
const reply = (text) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 20 },
});

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANSWER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * The handler against a small stateful store for the two score tables.
 * `beforeUpsert(table, payload, store)` runs as each upsert lands, before it
 * is applied: where a test makes the purge land.
 */
async function run({ deleteAfter, scores = [], session = null, beforeUpsert, onModel } = {}) {
  const env = process.env.AI_INTERVIEW_SCORING_ENABLED;
  process.env.AI_INTERVIEW_SCORING_ENABLED = "true";
  const store = {
    interview_answer_scores: structuredClone(scores),
    interview_session_scores: session ? [structuredClone(session)] : [],
  };
  const upserts = [];
  const KEY = { interview_answer_scores: "answer_id", interview_session_scores: "session_id" };
  const service = fakeService((table, calls) => {
    const eq = (row) => calls.filter((c) => c[0] === "eq").every((c) => row[c[1]] === c[2]);
    const inn = (row) => calls.filter((c) => c[0] === "in").every((c) => c[2].includes(row[c[1]]));
    if (table in store) {
      const rows = store[table];
      const up = calls.find((c) => c[0] === "upsert");
      if (up) {
        beforeUpsert?.(table, up[1], store);
        upserts.push({ table, row: structuredClone(up[1]) });
        const existing = rows.find((r) => r[KEY[table]] === up[1][KEY[table]]);
        if (existing) Object.assign(existing, structuredClone(up[1]));
        else rows.push(structuredClone(up[1]));
        return { data: null, error: null };
      }
      const update = calls.find((c) => c[0] === "update");
      if (update) {
        for (const r of rows.filter(eq)) Object.assign(r, structuredClone(update[1]));
        return { data: null, error: null };
      }
      const hit = rows.filter((r) => eq(r) && inn(r)).map((r) => structuredClone(r));
      if (calls.some((c) => c[0] === "maybeSingle")) return { data: hit[0] ?? null, error: null };
      return { data: hit, error: null };
    }
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
          delete_after: deleteAfter,
        },
        error: null,
      };
    }
    if (table === "interview_answers") {
      return {
        data: [
          {
            id: ANSWER_ID,
            position: 1,
            question_text: "Tell me about a hard bug.",
            transcript: TRANSCRIPT,
            transcript_status: "done",
            video_path: "v/1.webm",
            recorded_at: "2026-08-01T00:00:00Z",
            duration_seconds: 60,
            transcript_duration_seconds: 60,
            transcript_segments: null,
          },
        ],
        error: null,
      };
    }
    if (table === "jobs") return { data: { interview_criteria: ["Owns outcomes"] }, error: null };
    if (table === "interview_questions") {
      return {
        data: [
          {
            id: "q1",
            position: 1,
            question: "Tell me about a hard bug.",
            competency: null,
            rubric: null,
            weight: 1,
          },
        ],
        error: null,
      };
    }
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  globalThis.__cvScoringEventsForTests = [];
  const calls = [];
  const script = [reply(ANSWER_JSON), reply(ROLLUP_JSON)];
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params) => {
        const i = calls.length;
        calls.push(params);
        onModel?.(i);
        return script[Math.min(i, script.length - 1)];
      },
    },
  };
  clock = T0;
  Date.now = () => clock;
  let error = null;
  try {
    await handleAiScorecard({ id: "bg-1", payload: { sessionId: SESSION_ID } });
  } catch (err) {
    error = err;
  } finally {
    Date.now = realNow;
    if (env === undefined) delete process.env.AI_INTERVIEW_SCORING_ENABLED;
    else process.env.AI_INTERVIEW_SCORING_ENABLED = env;
  }
  return { error, calls, store, upserts, service };
}

const WORD_COLUMNS = ["reasoning", "evidence", "strengths", "concerns", "missing"];
const answerWords = (row) =>
  WORD_COLUMNS.filter((c) =>
    Array.isArray(row[c]) ? row[c].length > 0 : row[c] != null && row[c] !== "",
  );
const sessionWords = (row) =>
  [
    row.summary ? "summary" : null,
    Array.isArray(row.criteria) && row.criteria.some((c) => c.quote) ? "criteria quote" : null,
  ].filter(Boolean);
const iso = (ms) => new Date(ms).toISOString();

test("control: before the date the scorer stores the explanations and quotes", async () => {
  const r = await run({ deleteAfter: iso(T0 + 30 * 86_400_000) });
  assert.equal(r.error, null);
  const [a] = r.store.interview_answer_scores;
  assert.deepEqual(
    answerWords(a),
    WORD_COLUMNS,
    "every word column is filled, so the tests below discriminate",
  );
  assert.deepEqual(sessionWords(r.store.interview_session_scores[0]), [
    "summary",
    "criteria quote",
  ]);
});

test("a job asked after the date, with a scorecard stored: no model call, nothing written", async () => {
  const purged = {
    answer_id: ANSWER_ID,
    session_id: SESSION_ID,
    status: "scored",
    score: 64,
    reasoning: null,
    evidence: [],
    strengths: [],
    concerns: [],
    missing: [],
    human_feedback: "Kept.",
  };
  const session = {
    session_id: SESSION_ID,
    status: "scored",
    overall_score: 64,
    verdict: "Solid.",
    summary: null,
    criteria: [{ item: "Owns outcomes", status: "evidenced", quote: "" }],
  };
  const r = await run({ deleteAfter: iso(T0 - 1), scores: [purged], session });
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 0, "no model call");
  assert.equal(r.upserts.length, 0, "nothing written");
  assert.deepEqual(
    r.store.interview_answer_scores,
    [purged],
    "re-scoring cannot restore the deleted text",
  );
  assert.deepEqual(r.store.interview_session_scores, [session]);
});

test("a job asked after the date for a session never scored: a skipped row that says why, no words", async () => {
  const r = await run({ deleteAfter: iso(T0 - 1) });
  assert.equal(r.calls.length, 0);
  assert.deepEqual(
    r.upserts.map((u) => [u.table, u.row.status, u.row.error]),
    [["interview_session_scores", "skipped", RETENTION_SKIP_REASON]],
  );
  assert.equal(r.store.interview_answer_scores.length, 0);
});

test("in flight: started before the date, writes after it: numbers only, no word ever written", async () => {
  const deadline = T0 + 1000;
  const r = await run({
    deleteAfter: iso(deadline),
    // The model answers after the date.
    onModel: () => {
      clock = deadline + 5000;
    },
  });
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 2, "it was scored");
  const [a] = r.store.interview_answer_scores;
  assert.deepEqual([a.status, a.score, answerWords(a)], ["scored", 64, []]);
  const [s] = r.store.interview_session_scores;
  assert.deepEqual(
    [s.status, s.overall_score, s.verdict, sessionWords(s)],
    ["scored", 64, "Solid debugging, verification unclear.", []],
  );
  assert.deepEqual(
    s.criteria.map((c) => [c.item, c.status, c.quote]),
    [["Owns outcomes", "evidenced", ""]],
  );
  for (const u of r.upserts) {
    const words = u.table === "interview_answer_scores" ? answerWords(u.row) : sessionWords(u.row);
    assert.deepEqual(words, [], `${u.table} was sent words`);
  }
});

test("a write checked before the date that lands after it (the purge may have run in between) is cleared at once", async () => {
  const deadline = T0 + 1000;
  let raced = false;
  const r = await run({
    deleteAfter: iso(deadline),
    beforeUpsert: (table, payload) => {
      if (table !== "interview_answer_scores" || raced) return;
      // Checked before the date; the date passes and the purge runs before this write lands.
      raced = true;
      clock = deadline + 1;
      assert.ok(answerWords(payload).length > 0, "this write carries words (the race is real)");
    },
  });
  assert.equal(r.error, null);
  assert.ok(raced);
  const [a] = r.store.interview_answer_scores;
  assert.deepEqual([a.score, answerWords(a)], [64, []], "cleared right after the write");
  assert.deepEqual(sessionWords(r.store.interview_session_scores[0]), []);
});

test("the post-write clear is the shared purge: it leaves no words for the session", async () => {
  const r = await run({ deleteAfter: iso(T0 + 30 * 86_400_000) });
  await purgeAsyncScoreWords(r.service, [SESSION_ID]);
  assert.deepEqual(answerWords(r.store.interview_answer_scores[0]), []);
  assert.deepEqual(sessionWords(r.store.interview_session_scores[0]), []);
  assert.equal(
    r.store.interview_session_scores[0].verdict,
    "Solid debugging, verification unclear.",
  );
});
