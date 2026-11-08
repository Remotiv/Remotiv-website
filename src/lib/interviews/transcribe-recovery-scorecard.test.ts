/**
 * When the recovery sweep settles a session's last pending answer, it asks for
 * the scorecard, as the transcribe handler does when a transcript lands. It does
 * not ask while another answer is pending, or a second time for the same settled
 * state. A session with no transcript at all is asked for too: the real scorer then
 * writes a skipped record, with no number and no provider call.
 *
 *   node --test src/lib/interviews/transcribe-recovery-scorecard.test.ts
 *
 * runTranscribeRecovery, requestScorecard and handleAiScorecard are the shipped
 * code. The database is fake-live-db.mjs; the queue's insert is stubbed with the
 * same statement enqueue() runs. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const QUEUE = [
  "export async function enqueue(input) {",
  "  const row = { type: input.type, payload: input.payload ?? {}, company_id: input.companyId ?? null, status: 'queued' };",
  "  if (input.id) row.id = input.id;",
  "  const { data, error } = await globalThis.__service.from('background_jobs').insert(row).select('id').single();",
  "  if (error) return { ok: false, error: error.message, code: error.code };",
  "  return { ok: true, id: data.id };",
  "}",
].join("\\n");
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__service;",
  "@/lib/jobs-queue": QUEUE,
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { runTranscribeRecovery } = await import("./transcribe-recovery.ts");
const { handleAiScorecard } = await import("../ai/interview-scoring.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "d0000000-0000-4000-8000-0000000000e7";
const COMPANY = "c0000000-0000-4000-8000-0000000000e7";
const RECORDED_AT = "2026-11-01T10:00:00.000+00:00";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const A1 = "e0000000-0000-4000-8000-000000000001";
const A2 = "e0000000-0000-4000-8000-000000000002";
const A3 = "e0000000-0000-4000-8000-000000000003";

let lines = [];
let saved = null;
let jobCount = 0;

const answer = (id, position, transcript_status) => ({
  id,
  session_id: SESSION,
  position,
  video_path: `${SESSION}/q${position}.webm`,
  transcript: transcript_status === "done" ? "Something real was said here." : null,
  transcript_status,
  transcript_error: null,
  recorded_at: RECORDED_AT,
});

const deadJob = (answerId) => ({
  id: `f0000000-0000-4000-8000-${String(++jobCount).padStart(12, "0")}`,
  type: "transcribe",
  status: "dead",
  payload: { answerId, recordedAt: RECORDED_AT },
  created_at: "2026-11-01T10:00:01.000Z",
});

function world({ answers, jobs, status = "submitted", scores = [] }) {
  const db = fakeLiveDb({
    interview_sessions: [{ id: SESSION, company_id: COMPANY, kind: "async", status }],
    interview_answers: answers,
    background_jobs: jobs,
    interview_session_scores: scores,
  });
  globalThis.__service = db.service;
  return db;
}

const sweep = (db) => runTranscribeRecovery(db.service, { now: () => NOW });
const scorecards = (db) => db.tables.background_jobs.filter((j) => j.type === "ai_scorecard");
const statusOf = (db, id) => db.tables.interview_answers.find((a) => a.id === id).transcript_status;

beforeEach(() => {
  lines = [];
  saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
});

afterEach(() => {
  Object.assign(console, saved);
});

test("the last pending answer settled, the others done: exactly one scorecard is asked for", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  const summary = await sweep(db);
  assert.equal(statusOf(db, A2), "failed");
  assert.equal(summary.scorecardsRequested, 1);
  assert.equal(scorecards(db).length, 1);
  assert.deepEqual(scorecards(db)[0].payload, { sessionId: SESSION });
  assert.equal(scorecards(db)[0].status, "queued");
});

test("another answer still pending with a live job: nothing is asked for", async () => {
  const live = deadJob(A2);
  live.status = "running";
  const db = world({
    answers: [answer(A1, 1, "pending"), answer(A2, 2, "pending"), answer(A3, 3, "done")],
    jobs: [deadJob(A1), live],
  });
  const summary = await sweep(db);
  assert.equal(statusOf(db, A1), "failed");
  assert.equal(statusOf(db, A2), "pending");
  assert.equal(summary.scorecardsRequested, 0);
  assert.equal(scorecards(db).length, 0);
});

test("an answer awaiting its one re-queue counts as pending; the last to settle asks", async () => {
  const succeeded = deadJob(A2);
  succeeded.status = "succeeded";
  const db = world({
    answers: [answer(A1, 1, "pending"), answer(A2, 2, "pending"), answer(A3, 3, "done")],
    jobs: [deadJob(A1), succeeded],
  });
  const first = await sweep(db);
  assert.equal(first.requeued, 1);
  assert.equal(statusOf(db, A1), "failed");
  assert.equal(scorecards(db).length, 0, "the re-queue is still to run");

  const requeue = db.tables.background_jobs.find(
    (j) => j.status === "queued" && j.payload.answerId === A2,
  );
  requeue.status = "dead";
  const second = await sweep(db);
  assert.equal(statusOf(db, A2), "failed");
  assert.equal(second.scorecardsRequested, 1);
  assert.equal(scorecards(db).length, 1);
});

test("two answers settled in one sweep: one scorecard, asked for by the last", async () => {
  const db = world({
    answers: [answer(A1, 1, "pending"), answer(A2, 2, "pending"), answer(A3, 3, "done")],
    jobs: [deadJob(A1), deadJob(A2)],
  });
  const summary = await sweep(db);
  assert.equal(summary.failed, 2);
  assert.equal(summary.scorecardsRequested, 1);
  assert.equal(scorecards(db).length, 1);
});

test("every answer failed: one scorecard job, and the real scorer writes a skipped record with no number", async () => {
  const db = world({
    answers: [answer(A1, 1, "failed"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  const summary = await sweep(db);
  assert.equal(statusOf(db, A2), "failed");
  assert.equal(summary.scorecardsRequested, 1);
  assert.equal(scorecards(db).length, 1);

  const realFetch = globalThis.fetch;
  const realEnabled = process.env.AI_INTERVIEW_SCORING_ENABLED;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("no provider call is expected");
  };
  process.env.AI_INTERVIEW_SCORING_ENABLED = "true";
  try {
    await handleAiScorecard(scorecards(db)[0]);
  } finally {
    globalThis.fetch = realFetch;
    if (realEnabled === undefined) delete process.env.AI_INTERVIEW_SCORING_ENABLED;
    else process.env.AI_INTERVIEW_SCORING_ENABLED = realEnabled;
  }

  assert.equal(providerCalls, 0);
  const [card] = db.tables.interview_session_scores;
  assert.equal(card.status, "skipped");
  assert.equal(
    card.error,
    "No answer in this interview could be scored. See the individual answers for why.",
  );
  assert.doesNotMatch(card.error, /[\u2013\u2014]/, "hyphens only");
  assert.equal(card.overall_score ?? null, null, "no number");
  assert.equal(card.verdict ?? null, null);
  assert.deepEqual(
    db.tables.interview_answer_scores.map((r) => r.status),
    ["skipped", "skipped"],
  );
});

test("a second sweep asks for nothing more, even after the first scorecard job has finished", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  await sweep(db);
  assert.equal(scorecards(db).length, 1);
  scorecards(db)[0].status = "succeeded";
  const second = await sweep(db);
  assert.equal(second.scanned, 0);
  assert.equal(second.scorecardsRequested, 0);
  assert.equal(scorecards(db).length, 1);
});

test("a scorecard job already live is not doubled", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [
      deadJob(A2),
      {
        id: "f0000000-0000-4000-8000-0000000000aa",
        type: "ai_scorecard",
        status: "queued",
        payload: { sessionId: SESSION },
        created_at: "2026-11-02T11:00:00.000Z",
      },
    ],
  });
  const summary = await sweep(db);
  assert.equal(summary.scorecardsRequested, 0);
  assert.equal(scorecards(db).length, 1);
});

test("the row changed under the sweep: no write, so no ask", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  const from = db.service.from.bind(db.service);
  db.service.from = (table) => {
    if (table === "background_jobs") {
      db.tables.interview_answers[1].recorded_at = "2026-11-01T10:05:00.000+00:00";
    }
    return from(table);
  };
  const summary = await sweep(db);
  assert.equal(summary.skipped, 1);
  assert.equal(scorecards(db).length, 0);
});

test("not submitted yet: nothing is queued, and submit remains the one to ask", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
    status: "started",
  });
  const summary = await sweep(db);
  assert.equal(statusOf(db, A2), "failed");
  assert.equal(summary.scorecardsRequested, 0);
  assert.equal(scorecards(db).length, 0);
});

test("a stored scorecard follows the existing rule: requestScorecard queues a new one", async () => {
  const db = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
    scores: [{ session_id: SESSION, company_id: COMPANY, status: "scored", overall_score: 70 }],
  });
  await sweep(db);
  assert.equal(scorecards(db).length, 1);
});

test("a failed ask never undoes the settling, stops the sweep or logs raw text", async () => {
  const queueDown = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  queueDown.failNext("background_jobs", "insert");
  const first = await sweep(queueDown);
  assert.equal(statusOf(queueDown, A2), "failed");
  assert.equal(first.errors, 1);
  assert.ok(lines.includes(`[transcribe-recovery] session ${SESSION}: scorecard not queued`));

  lines = [];
  const unreadable = world({
    answers: [answer(A1, 1, "done"), answer(A2, 2, "pending")],
    jobs: [deadJob(A2)],
  });
  const from = unreadable.service.from.bind(unreadable.service);
  let answerQueries = 0;
  unreadable.service.from = (table) => {
    // The scan, then the write; the third is the read of the session's answers.
    if (table === "interview_answers" && ++answerQueries === 3) {
      unreadable.failNext("interview_answers", "select");
    }
    return from(table);
  };
  const second = await sweep(unreadable);
  assert.equal(statusOf(unreadable, A2), "failed");
  assert.equal(second.errors, 1);
  assert.equal(scorecards(unreadable).length, 0, "an unread session is not asked for");
  assert.ok(
    lines.includes(
      `[transcribe-recovery] session ${SESSION}: answers not read; scorecard not asked`,
    ),
  );
  assert.doesNotMatch(lines.join(" "), /fault/);
});
