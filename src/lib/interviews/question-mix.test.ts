/**
 * The AI Video Interview question mix (lib/interviews/question-mix.ts): the
 * table, its time budget, the fallback for an unknown length, and the
 * empty-CV rule. Pure; nothing leaves the machine. Every CV line is made up.
 *
 *   node --test src/lib/interviews/question-mix.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));

const {
  describeQuestionMix,
  MIN_CV_CHARS_FOR_CV_QUESTIONS,
  MINUTES_PER_FOLLOWED_UP_QUESTION,
  QUESTION_MIX_POLICY_VERSION,
  QUESTION_MIX_TABLE,
  questionMixFor,
  resolveQuestionMix,
  SESSION_FILL,
  SESSION_OVERHEAD_MINUTES,
} = await import("./question-mix.ts");
const { sanitizeCvForInterview } = await import("./cv-sanitize.ts");

const REAL_CV = sanitizeCvForInterview(
  [
    "Alex Example | alex.example@example.com | +92 300 0000000",
    "Backend Engineer at Northwind Logistics (2021 - Present).",
    "Led the move of the order service to Node.js and TypeScript, cut report generation",
    "time from 40 minutes to 4, and mentored two junior developers. Before that, built",
    "REST APIs on PostgreSQL and Redis at Contoso Retail (2019 - 2021).",
  ].join("\n"),
).text;

test("the table: each length gives its counts, half and half, an odd question to the job", () => {
  assert.equal(QUESTION_MIX_POLICY_VERSION, "question-mix-v1");
  const expected = {
    15: { job_questions: 2, cv_questions: 1, total: 3 },
    20: { job_questions: 3, cv_questions: 2, total: 5 },
    30: { job_questions: 4, cv_questions: 4, total: 8 },
  };
  for (const [minutes, counts] of Object.entries(expected)) {
    assert.deepEqual(questionMixFor(Number(minutes)), {
      policy_version: QUESTION_MIX_POLICY_VERSION,
      session_minutes: Number(minutes),
      ...counts,
    });
  }
  for (const row of QUESTION_MIX_TABLE) {
    assert.ok(row.job >= row.cv && row.job - row.cv <= 1, `${row.minutes}: half and half`);
  }
});

test("every row fits its session for a candidate drawing both follow-ups on every answer", () => {
  for (const row of QUESTION_MIX_TABLE) {
    const total = row.job + row.cv;
    const budget = Math.floor(
      (SESSION_FILL * row.minutes - SESSION_OVERHEAD_MINUTES) / MINUTES_PER_FOLLOWED_UP_QUESTION,
    );
    assert.equal(total, budget, `${row.minutes} min: the row is the budget`);
    assert.ok(
      total * MINUTES_PER_FOLLOWED_UP_QUESTION + SESSION_OVERHEAD_MINUTES <= row.minutes,
      `${row.minutes} min: never more questions than fit`,
    );
  }
});

test("the 30-minute row is the cap: no length gives more questions, and it is the live length", async () => {
  const { MAX_SESSION_SECONDS } = await import("./types.ts");
  assert.equal(MAX_SESSION_SECONDS, 1800);
  const cap = questionMixFor(MAX_SESSION_SECONDS / 60).total;
  assert.equal(cap, 8);
  for (const minutes of [0, 1, 14, 15, 16, 25, 30, 31, 45, 60, 240, 10_000]) {
    assert.ok(questionMixFor(minutes).total <= cap, `${minutes} min`);
  }
});

test("an unknown length falls back to the nearest lower row, and never throws", () => {
  assert.equal(questionMixFor(25).session_minutes, 20);
  assert.equal(questionMixFor(29.9).session_minutes, 20);
  assert.equal(questionMixFor(45).session_minutes, 30);
  assert.equal(questionMixFor(19).session_minutes, 15);
  // Below every row, or not a number: the shortest row.
  for (const odd of [10, 0, -5, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
    assert.equal(questionMixFor(odd).session_minutes, 15, String(odd));
  }
  assert.equal(questionMixFor(Number.POSITIVE_INFINITY).session_minutes, 15);
});

test("empty or too short a CV: every question becomes a job question, the total unchanged", () => {
  const mix = questionMixFor(30);
  const allJob = { ...mix, job_questions: 8, cv_questions: 0 };
  for (const cv of [
    null,
    undefined,
    "",
    "   ",
    "Alex Example",
    // Only contact details: once tagged there is nothing left to ask about.
    sanitizeCvForInterview(
      "Alex Example | alex.example@example.com | +92 300 0000000 | House 1, Street 1, Lahore",
    ).text,
    "x".repeat(MIN_CV_CHARS_FOR_CV_QUESTIONS - 1),
  ]) {
    assert.deepEqual(resolveQuestionMix(mix, cv), allJob, JSON.stringify(cv)?.slice(0, 40));
  }
  assert.deepEqual(resolveQuestionMix(mix, "x".repeat(MIN_CV_CHARS_FOR_CV_QUESTIONS)), mix);
  assert.deepEqual(resolveQuestionMix(mix, REAL_CV), mix, "a real CV keeps the mix");
});

test("resolving never changes the mix it was given", () => {
  const mix = questionMixFor(30);
  const before = JSON.stringify(mix);
  resolveQuestionMix(mix, "");
  assert.equal(JSON.stringify(mix), before);
  assert.notEqual(resolveQuestionMix(mix, REAL_CV), mix, "a copy, not the same object");
});

test("the CV minimum is the CV scorer's: a CV too short to score is too short to ask about", () => {
  const scorer = readFileSync(new URL("../ai/cv-scoring.ts", import.meta.url), "utf8");
  const scorerMin = Number(scorer.match(/export const MIN_CV_TEXT_CHARS = (\d+);/)[1]);
  assert.equal(MIN_CV_CHARS_FOR_CV_QUESTIONS, scorerMin);
});

test("the wizard's line", () => {
  assert.equal(
    describeQuestionMix(questionMixFor(30)),
    "30 min interview: 4 job questions + 4 CV-based questions, same for every candidate.",
  );
  assert.equal(
    describeQuestionMix(questionMixFor(15)),
    "15 min interview: 2 job questions + 1 CV-based question, same for every candidate.",
  );
});
