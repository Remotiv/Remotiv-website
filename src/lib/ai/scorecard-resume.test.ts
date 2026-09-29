/**
 * Retry-of-the-same-job versus a new deliberate re-score (Phase 5, P2;
 * migration 033).
 *
 *   node --test src/lib/ai/scorecard-resume.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerRunDecision, sessionAlreadyComplete } from "./scorecard-resume.ts";

const THIS_JOB = "job-1";
const OTHER_JOB = "job-2";

test("an answer scored by THIS job is reused; everything else is scored", () => {
  assert.equal(
    answerRunDecision({ answer_id: "a", status: "scored", scored_by_job_id: THIS_JOB }, THIS_JOB),
    "reuse",
  );
  assert.equal(
    answerRunDecision({ answer_id: "a", status: "scored", scored_by_job_id: OTHER_JOB }, THIS_JOB),
    "score",
  );
  assert.equal(
    answerRunDecision({ answer_id: "a", status: "scored", scored_by_job_id: null }, THIS_JOB),
    "score",
    "pre-033 row",
  );
  assert.equal(
    answerRunDecision({ answer_id: "a", status: "failed", scored_by_job_id: THIS_JOB }, THIS_JOB),
    "score",
  );
  assert.equal(
    answerRunDecision({ answer_id: "a", status: "skipped", scored_by_job_id: THIS_JOB }, THIS_JOB),
    "score",
  );
  assert.equal(answerRunDecision(undefined, THIS_JOB), "score");
  assert.equal(answerRunDecision(null, THIS_JOB), "score");
});

test("a deliberate re-score is a NEW job id, so every existing score is replaced", () => {
  const rows = [
    { answer_id: "a", status: "scored", scored_by_job_id: THIS_JOB },
    { answer_id: "b", status: "scored", scored_by_job_id: THIS_JOB },
    { answer_id: "c", status: "failed", scored_by_job_id: THIS_JOB },
  ];
  const fresh = "job-3";
  assert.deepEqual(
    rows.map((r) => answerRunDecision(r, fresh)),
    ["score", "score", "score"],
  );
  assert.equal(
    sessionAlreadyComplete({ status: "scored", scored_by_job_id: THIS_JOB }, fresh),
    false,
  );
});

test("a retry that finds its own scored rollup has nothing left to do", () => {
  assert.equal(
    sessionAlreadyComplete({ status: "scored", scored_by_job_id: THIS_JOB }, THIS_JOB),
    true,
  );
  assert.equal(
    sessionAlreadyComplete({ status: "skipped", scored_by_job_id: THIS_JOB }, THIS_JOB),
    false,
  );
  assert.equal(
    sessionAlreadyComplete({ status: "scored", scored_by_job_id: OTHER_JOB }, THIS_JOB),
    false,
  );
  assert.equal(sessionAlreadyComplete(null, THIS_JOB), false);
});

test("a resume after two of four answers pays for exactly the remaining two", () => {
  const rows = new Map([
    ["a", { answer_id: "a", status: "scored", scored_by_job_id: THIS_JOB }],
    ["b", { answer_id: "b", status: "scored", scored_by_job_id: THIS_JOB }],
  ]);
  const calls = ["a", "b", "c", "d"].filter(
    (id) => answerRunDecision(rows.get(id), THIS_JOB) === "score",
  );
  assert.deepEqual(calls, ["c", "d"]);
});
