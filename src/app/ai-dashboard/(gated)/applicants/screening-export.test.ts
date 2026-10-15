/**
 * The two decisions that moving screening_answers off the list row created,
 * executed rather than pinned.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/screening-export.test.ts"
 *
 * ── Why these two modules exist at all ───────────────────────
 *
 * `screening_answers` used to ride on every list row, so the drawer and the CSV
 * both read it synchronously and neither could be wrong about WHOSE answers it
 * had. It is now fetched separately, which introduces two ways to lie:
 *
 *   1. The drawer steps between applicants while a read is in flight. A late
 *      response would paint one candidate's screening answers under another
 *      candidate's name, and once rendered the two are indistinguishable.
 *
 *   2. The export has to fetch before it can write a file. A failed or partial
 *      read would otherwise produce a spreadsheet whose Screening column is
 *      blank — which a recruiter reads as "answered nothing", then filters on.
 *
 * There is no DOM test runner in this repo, so a rendering assertion is not
 * available and a source pin would prove nothing about behaviour. Both
 * decisions therefore live in pure modules, and this file runs them.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { screeningCard, screeningCount, selectScreening } = await import("./screening-state.ts");
const { CSV_EXPORT_MAX, buildApplicantsCsv } = await import("./csv-export.ts");

const ANN = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

/** One answered question. `scored` absent means scored — the pre-flag shape. */
const q = (id, { matched = true, scored = undefined } = {}) => ({
  question_id: id,
  question: `Q${id}`,
  type: "numeric",
  essential: false,
  ideal: 5,
  answer: 7,
  matched,
  ...(scored === undefined ? {} : { scored }),
});

const score = (over = {}) => ({
  status: "scored",
  overall: 88,
  ai_overall: 88,
  adjusted: false,
  confidence: "high",
  error: null,
  ...over,
});

const applicant = (id, over = {}) => ({
  id,
  name: "Ann Example",
  email: "ann@example.test",
  job_title: "Backend Engineer",
  stage: "applied",
  score: score(),
  created_at: "2026-03-04T09:30:00.000Z",
  ...over,
});

// ── selectScreening: whose answers are these? ────────────────

test("answers recorded for another applicant never render as this one's", () => {
  const annsAnswers = { id: ANN, answers: [q("a1")] };

  // The drawer is showing Bob; the response in hand was read for Ann.
  const forBob = selectScreening(annsAnswers, BOB);
  assert.deepEqual(forBob, { status: "loading" });

  // Not merely "not ready" — there is no path by which Ann's array is
  // reachable through a Bob-shaped read.
  assert.equal(screeningCard(forBob), "loading");
  assert.equal(screeningCount(forBob), null);

  // And the same state read for the applicant it belongs to IS ready, so the
  // guard above is a mismatch check rather than a blanket refusal.
  assert.deepEqual(selectScreening(annsAnswers, ANN), {
    status: "ready",
    answers: [q("a1")],
  });
});

test("a FAILURE is keyed too, so it cannot be reported against the next applicant", () => {
  const annFailed = { id: ANN, answers: null };

  assert.deepEqual(selectScreening(annFailed, ANN), { status: "failed" });
  // Bob's drawer must not show "couldn't be loaded" because Ann's read failed.
  assert.deepEqual(selectScreening(annFailed, BOB), { status: "loading" });
});

test("no state, and no open applicant, are both loading", () => {
  assert.deepEqual(selectScreening(null, ANN), { status: "loading" });
  assert.deepEqual(selectScreening({ id: ANN, answers: [] }, null), { status: "loading" });
  assert.deepEqual(selectScreening(null, null), { status: "loading" });
});

test("empty is a claim about the JOB, and only ready can make it", () => {
  // The whole point of the four-way card: an unreadable answer set must not
  // render as "this job asked nothing".
  assert.equal(screeningCard({ status: "ready", answers: [] }), "empty");
  assert.equal(screeningCard({ status: "ready", answers: [q("a1")] }), "list");
  assert.equal(screeningCard({ status: "loading" }), "loading");
  assert.equal(screeningCard({ status: "failed" }), "failed");
});

test("the summary's answer count is absent until known, never 0", () => {
  // summarySource(0) says "Generated from the CV", which is a false statement
  // about the scorer's inputs while the answers are still arriving.
  assert.equal(screeningCount({ status: "loading" }), null);
  assert.equal(screeningCount({ status: "failed" }), null);
  assert.equal(screeningCount({ status: "ready", answers: [] }), 0);
  assert.equal(screeningCount({ status: "ready", answers: [q("a1"), q("a2")] }), 2);
});

// ── buildApplicantsCsv: completeness before formatting ───────

test("a missing applicant refuses the whole export", () => {
  const rows = [applicant(ANN), applicant(BOB, { name: "Bob Other" })];

  // Ann's answers arrived, Bob's did not. The old code would have written a
  // file with Bob's Screening cell reading "No questions".
  const built = buildApplicantsCsv(rows, { [ANN]: [q("a1")] });

  assert.equal(built.ok, false);
  assert.deepEqual(built.missing, [BOB]);
  assert.equal(built.csv, undefined, "no csv is produced on an incomplete read");
});

test("an EMPTY answer set is an answer, not a gap", () => {
  // The distinction test 9 above turns on: `[]` means the job asked nothing
  // and must export; an ABSENT key means we do not know and must not.
  const built = buildApplicantsCsv([applicant(ANN)], { [ANN]: [] });
  assert.equal(built.ok, true);
  assert.match(built.csv, /"No questions"/);
});

test("a map that is empty, or missing every id, refuses rather than exporting blanks", () => {
  const rows = [applicant(ANN), applicant(BOB)];
  const none = buildApplicantsCsv(rows, {});
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, [ANN, BOB]);

  // A non-array under the right key is not an answer set either — this is the
  // shape a jsonb column holds when it is null rather than '[]'.
  const bad = buildApplicantsCsv([applicant(ANN)], { [ANN]: null });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, [ANN]);
});

test("thresholds are counted over TESTED questions on both sides", () => {
  const cell = (answers) => {
    const built = buildApplicantsCsv([applicant(ANN)], { [ANN]: answers });
    assert.equal(built.ok, true);
    return built.csv.split("\r\n")[1].split(",")[7];
  };

  // Two thresholds, both met, plus one question asked with no threshold set.
  // The denominator is 2 — reporting 2/3 would mark a passing candidate short.
  assert.equal(
    cell([q("a1"), q("a2"), q("a3", { matched: false, scored: false })]),
    '"2/2 thresholds met"',
  );

  // `scored` ABSENT means scored: every snapshot written before the flag
  // existed must read exactly as it always did.
  assert.equal(cell([q("a1"), q("a2", { matched: false })]), '"1/2 thresholds met"');

  // Questions asked, but none of them with a threshold. Not "0/0 met", and
  // not "No questions" either — both are wrong in different directions.
  assert.equal(cell([q("a1", { matched: false, scored: false })]), '"No thresholds set"');
});

test("the golden row: columns, order, escaping and the BOM", () => {
  const built = buildApplicantsCsv(
    [
      applicant(ANN, {
        // A comma AND a quote in one field: unescaped, either one shifts every
        // later column in the reader's spreadsheet.
        name: 'Ann "Annie", Example',
        stage: "shortlisted",
        score: score({ overall: 91, adjusted: true, confidence: "medium" }),
      }),
    ],
    { [ANN]: [q("a1"), q("a2", { matched: false })] },
  );

  assert.equal(built.ok, true);
  const lines = built.csv.split("\r\n");
  assert.equal(lines.length, 2);

  assert.equal(
    lines[0],
    '﻿"Candidate","Email","Job","Stage","AI score","Score status","Confidence","Screening","Applied"',
  );
  assert.equal(
    lines[1],
    '"Ann ""Annie"", Example","ann@example.test","Backend Engineer","Shortlisted","91","Adjusted","medium","1/2 thresholds met","2026-03-04"',
  );
});

test("an unscored applicant exports empty score cells, not zeros", () => {
  const built = buildApplicantsCsv(
    [
      applicant(ANN, {
        score: {
          status: "pending",
          overall: null,
          ai_overall: null,
          adjusted: false,
          confidence: null,
          error: null,
        },
      }),
    ],
    { [ANN]: [] },
  );
  assert.equal(built.ok, true);
  const cells = built.csv.split("\r\n")[1].split(",");
  assert.equal(cells[4], '""', "AI score is blank, not 0");
  assert.equal(cells[5], '"pending"');
  assert.equal(cells[6], '""');
});

test("the export cap is the page size the button exports", () => {
  // Not an arbitrary number: _applicants-client.tsx defines
  // `const PAGE_SIZE = CSV_EXPORT_MAX`, and the server read refuses more than
  // this many ids. The value is asserted here so a change to it is deliberate.
  assert.equal(CSV_EXPORT_MAX, 20);
});
