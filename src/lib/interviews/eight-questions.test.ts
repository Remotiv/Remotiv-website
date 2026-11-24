/**
 * 24 Nov: a job may have up to 8 interview questions (MAX_QUESTIONS), for the
 * async interview and the AI Video Interview alike. An async interview with 8
 * is sent with all 8 frozen, shows the candidate the right "About N minutes",
 * and is marked with every question's own weight.
 *
 *   node --test src/lib/interviews/eight-questions.test.ts
 *
 * The send action, the candidate page's resolver and the scorer's question
 * metadata are the shipped code; the company context, email, queue and
 * database are the fakes of interview-invite-test-hook.mjs and
 * fake-live-db.mjs. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/interview-invite-test-hook.mjs", import.meta.url));

const { sendInterviewInvite } = await import(
  "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts"
);
const { resolveSessionByToken } = await import("./session.ts");
const { mintSessionToken } = await import("./tokens.ts");
const { MAX_QUESTIONS } = await import("./types.ts");
const { readScoringSnapshot, resolveQuestionMeta } = await import("./question-meta.ts");
const { weightShares } = await import("../weights.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000008";
const APP = "a0000000-0000-4000-8000-000000000008";
const JOB = "b0000000-0000-4000-8000-000000000008";
/** Stops 1, 2, 4, 6 (Less, Normal, More, Most): a mix, so a wrong sum shows. */
const WEIGHTS = [2, 2, 4, 1, 6, 2, 4, 2];

function world(n) {
  const w = fakeLiveDb({
    interview_sessions: [],
    interview_answers: [],
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: "candidate@example.test",
        job_id: JOB,
        job_title_snapshot: "Test role",
      },
    ],
    jobs: [
      {
        id: JOB,
        company_id: CO,
        title: "Test role",
        allow_rerecord: true,
        async_interview_enabled: true,
      },
    ],
    interview_questions: Array.from({ length: n }, (_, i) => ({
      id: `q${i + 1}`,
      job_id: JOB,
      company_id: CO,
      position: i + 1,
      question: `Synthetic question ${i + 1}?`,
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
      competency: "Ownership",
      rubric: `Rubric ${i + 1}.`,
      weight: WEIGHTS[i % WEIGHTS.length],
    })),
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.service.rpc = async (name) =>
    name === "consume_allowance"
      ? {
          data: [{ allowed: true, unlimited: true, reason: "unlimited", usage_id: "usage-1" }],
          error: null,
        }
      : { data: true, error: null };
  w.emails = [];
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = () => ({ ok: true });
  return w;
}

async function quiet(fn) {
  const saved = {};
  for (const m of ["error", "warn", "log"]) {
    saved[m] = console[m];
    console[m] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

test("the cap is 8, shared by the async interview and the AI Video Interview", () => {
  assert.equal(MAX_QUESTIONS, 8);
});

test("async with 7 and 8 questions: sent, every question frozen in order", async () => {
  for (const n of [7, 8]) {
    const w = world(n);
    const r = await quiet(() => sendInterviewInvite(APP));
    assert.equal(r.success, true, r.error);
    const s = w.tables.interview_sessions[0];
    assert.equal(s.kind, "async");
    assert.deepEqual(
      s.questions_snapshot.map((q) => [q.position, q.question]),
      Array.from({ length: n }, (_, i) => [i + 1, `Synthetic question ${i + 1}?`]),
    );
    assert.equal(s.scoring_snapshot.length, n);
    assert.deepEqual(w.emails, ["interview"]);
  }
});

test("the candidate is told the right time for 8 questions", async () => {
  const w = world(8);
  assert.equal((await quiet(() => sendInterviewInvite(APP))).success, true);
  const { rawToken, tokenHash } = mintSessionToken();
  w.tables.interview_sessions[0].token_hash = tokenHash;
  const resolved = await quiet(() => resolveSessionByToken(rawToken));
  assert.equal(resolved.session.questions.length, 8);
  // 8 answers of 120 s = 16 minutes, plus a minute a question to read and prepare.
  assert.equal(resolved.session.estimatedMinutes, 16 + 8);
});

test("8 questions are marked with their own weights, and the session weights add up", async () => {
  const w = world(8);
  assert.equal((await quiet(() => sendInterviewInvite(APP))).success, true);
  const s = w.tables.interview_sessions[0];
  const scoring = readScoringSnapshot(s.scoring_snapshot);
  assert.equal(scoring.length, 8);
  const metas = s.questions_snapshot.map((q) =>
    resolveQuestionMeta(
      { position: q.position, question_text: q.question },
      s.questions_snapshot,
      scoring,
      [],
    ),
  );
  assert.deepEqual(
    metas.map((m) => [m.questionText, m.rubric, m.weight, m.source]),
    WEIGHTS.map((wt, i) => [
      `Synthetic question ${i + 1}?`,
      `Rubric ${i + 1}.`,
      wt,
      "scoring_snapshot",
    ]),
  );
  // The session rollup in interview-scoring.ts: sum(score x weight) / sum(weight).
  const scores = [80, 60, 90, 40, 70, 50, 100, 30];
  const totalWeight = metas.reduce((sum, m) => sum + m.weight, 0);
  assert.equal(
    totalWeight,
    WEIGHTS.reduce((a, b) => a + b, 0),
  );
  const overall = Math.round(
    metas.reduce((sum, m, i) => sum + scores[i] * m.weight, 0) / totalWeight,
  );
  assert.equal(overall, Math.round((160 + 120 + 360 + 40 + 420 + 100 + 400 + 60) / 23));
  // The wizard's share bar for 8 questions: whole percentages that add to 100.
  const shares = weightShares(WEIGHTS);
  assert.equal(shares.length, 8);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    100,
  );
});
