/**
 * Reconciliation tests for the platform analytics roll-ups.
 *
 * Run with Node's built-in runner — no test framework, no new dependency:
 *
 *   node --test src/app/admin/analytics/rollup.test.ts
 *
 * ── Why these exist ──────────────────────────────────────────
 *
 * The handoff asks for the invariants to be asserted, and it is right to: the
 * page's argument is that its arithmetic is inspectable, so a figure that does
 * not reconcile with the table beneath it discredits every other figure on the
 * page. Two such defects were caught in review of the mock.
 *
 * The cases below are chosen to break the two ways real data differs from a
 * hand-made mock — NULL partition keys, and money that is not representable in
 * binary floating point — rather than to re-check that addition works.
 */

// @ts-nocheck — see the note above: the `./rollup.ts` specifier that Node
// requires is rejected by this repo's tsconfig, which does not set
// `allowImportingTsExtensions`. Turning that flag on is a repo-wide config
// change outside this task's scope, so the check is suppressed HERE, in the
// one file that needs it. Nothing ships from this file; `node --test` still
// type-strips and runs every assertion below.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barWidthPct,
  buildCalibration,
  buildCompanyRow,
  buildStats,
  byVersion,
  type CompanyInput,
  formatMicro,
  MICRO,
  maxAbsMean,
  reconcile,
  type ScoreRow,
  UNATTRIBUTED,
  UNCATEGORISED,
  UNKNOWN_VERSION,
  type UsageRow,
} from "./rollup.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function score(partial: Partial<ScoreRow> = {}): ScoreRow {
  return {
    kind: "cv",
    companyId: "co-1",
    category: "Engineering",
    promptVersion: "v10",
    overall: 60,
    adjusted: null,
    reviewer: null,
    ...partial,
  };
}

function company(partial: Partial<CompanyInput> = {}): CompanyInput {
  return {
    id: "co-1",
    name: "Acme",
    isInternal: false,
    lastActivityAt: NOW.toISOString(),
    jobs: 3,
    emails: 12,
    transcribedMinutes: 0,
    interviewsSubmitted: 0,
    failedScores: 0,
    fabricationRejections: 0,
    unscoredByChoice: 0,
    jobsWithScoringOff: 0,
    ...partial,
  };
}

/* ───────────────── partitions are total ───────────────── */

test("a null category is bucketed, never dropped", () => {
  const cal = buildCalibration([
    score({ category: "Engineering" }),
    score({ category: null }),
    score({ category: "   " }),
  ]);

  assert.equal(cal.scored, 3);
  assert.equal(
    cal.categories.reduce((a, c) => a + c.scored, 0),
    3,
    "categories must sum to the corpus even when the key is null",
  );
  assert.ok(cal.categories.some((c) => c.category === UNCATEGORISED));
});

test("a null prompt version is bucketed, never dropped", () => {
  const cal = buildCalibration([score({ promptVersion: "v10" }), score({ promptVersion: null })]);

  assert.equal(
    cal.versions.reduce((a, v) => a + v.scored, 0),
    cal.scored,
  );
  assert.ok(cal.versions.some((v) => v.version === UNKNOWN_VERSION));
});

test("an override with no named reviewer is attributed to UNATTRIBUTED", () => {
  const cal = buildCalibration([
    score({ adjusted: 70, reviewer: "Sara" }),
    score({ adjusted: 70, reviewer: null }),
  ]);

  assert.equal(cal.overrides, 2);
  assert.equal(
    cal.reviewers.reduce((a, r) => a + r.overrides, 0),
    2,
    "reviewer rows must sum to the override count, not to the named subset",
  );
  assert.ok(cal.reviewers.some((r) => r.name === UNATTRIBUTED));
});

/* ───────────────── the full reconciliation ───────────────── */

test("every invariant holds on a mixed, null-riddled corpus", () => {
  const rows: ScoreRow[] = [
    score({ category: "Engineering", adjusted: 68, reviewer: "Sara" }),
    score({ category: "Engineering", overall: 55 }),
    score({ category: "Marketing", overall: 70, adjusted: 52, reviewer: "Sara" }),
    score({ category: null, overall: 40, adjusted: 45, reviewer: null }),
    score({ kind: "interview", category: "Sales", promptVersion: null, overall: 80 }),
    score({ kind: "interview", category: "Sales", overall: 62, adjusted: 71, reviewer: "Bilal" }),
  ];

  const usage: UsageRow[] = [
    { companyId: "co-1", type: "cv_scored", quantity: 4 },
    { companyId: "co-1", type: "interview_scored", quantity: 2 },
    { companyId: "co-2", type: "cv_scored", quantity: 3 },
  ];

  const companies = [
    buildCompanyRow(company({ id: "co-1", transcribedMinutes: 7 }), usage, NOW),
    buildCompanyRow(company({ id: "co-2", name: "Northwind" }), usage, NOW),
    buildCompanyRow(company({ id: "co-3", name: "Dormant Ltd", lastActivityAt: null }), usage, NOW),
  ];

  const stats = buildStats(companies, 13);
  const violations = reconcile(buildCalibration(rows), companies, stats);

  assert.deepEqual(violations, [], "no invariant may be violated");
});

test("money lines sum to the company cost exactly, with no float drift", () => {
  // $0.021 and $0.006 are both unrepresentable in binary floating point.
  // Summing 1,000 of each in dollars drifts; in integer µ$ it cannot.
  const usage: UsageRow[] = [{ companyId: "co-1", type: "cv_scored", quantity: 1000 }];
  const row = buildCompanyRow(company({ transcribedMinutes: 1000 }), usage, NOW);

  assert.equal(
    row.money.reduce((a, m) => a + m.amountMicro, 0),
    row.costMicro,
  );
  assert.equal(row.costMicro, 1000 * 21_000 + 1000 * 6_000);
  assert.equal(Number.isInteger(row.costMicro), true, "money must never become a float");
  assert.equal(formatMicro(row.costMicro), "$27.00");
});

test("stat cards roll up from the table and nowhere else", () => {
  const usage: UsageRow[] = [
    { companyId: "a", type: "cv_scored", quantity: 128 },
    { companyId: "b", type: "cv_scored", quantity: 68 },
    { companyId: "a", type: "interview_scored", quantity: 14 },
    { companyId: "b", type: "interview_scored", quantity: 9 },
  ];
  const companies = [
    buildCompanyRow(
      company({ id: "a", transcribedMinutes: 41, interviewsSubmitted: 14 }),
      usage,
      NOW,
    ),
    buildCompanyRow(
      company({ id: "b", name: "Remotiv", transcribedMinutes: 29, interviewsSubmitted: 9 }),
      usage,
      NOW,
    ),
    buildCompanyRow(company({ id: "c", name: "Northwind" }), usage, NOW),
  ];
  const stats = buildStats(companies, 13);

  assert.equal(stats.cvsScored, 196);
  assert.equal(stats.interviews, 23);
  assert.equal(stats.transcribedMinutes, 70);
  assert.equal(stats.companies, 3);
  assert.deepEqual(reconcile(buildCalibration([]), companies, stats), []);

  // Cost per CV is the quotient of two figures that are themselves roll-ups.
  assert.equal(stats.costPerCvMicro, Math.round(stats.spendMicro / 196));
});

/* ───────────────── zero is not missing ───────────────── */

test("a company with no usage reports zero, and no fabricated money lines", () => {
  const row = buildCompanyRow(company({ id: "quiet" }), [], NOW);

  assert.equal(row.zeroUsage, true);
  assert.equal(row.costMicro, 0);
  assert.deepEqual(row.money, [], "a zero line would read as a rendering fault");
});

test("cost per CV is null, not Infinity or NaN, when nothing was scored", () => {
  const stats = buildStats([buildCompanyRow(company(), [], NOW)], 0);
  assert.equal(stats.costPerCvMicro, null);
});

/* ───────────────── calibration states ───────────────── */

test("under 100 overrides the section refuses to calibrate", () => {
  const rows = Array.from({ length: 300 }, (_, i) =>
    score({ adjusted: i < 40 ? 70 : null, reviewer: i < 40 ? "Sara" : null }),
  );
  assert.equal(buildCalibration(rows).state, "thin");
});

test("100+ overrides from one person is the single-reviewer state, not the full one", () => {
  const rows = Array.from({ length: 400 }, () => score({ adjusted: 70, reviewer: "Sara" }));
  const cal = buildCalibration(rows);

  assert.equal(cal.state, "solo");
  assert.equal(cal.reviewerCount, 1);
  assert.equal(cal.reviewers[0]?.tag, null, "a lone reviewer cannot be strict relative to herself");
});

test("two reviewers past the threshold reach the full state and get tagged", () => {
  const rows = [
    ...Array.from({ length: 120 }, () => score({ overall: 70, adjusted: 55, reviewer: "Sara" })),
    ...Array.from({ length: 60 }, () => score({ overall: 60, adjusted: 66, reviewer: "Bilal" })),
  ];
  const cal = buildCalibration(rows);

  assert.equal(cal.state, "full");
  assert.equal(cal.reviewers.find((r) => r.name === "Sara")?.tag, "strict");
  assert.equal(cal.reviewers.find((r) => r.name === "Bilal")?.tag, "generous");
});

/* ───────────────── the bars ───────────────── */

test("a diverging bar never crosses the centre line", () => {
  assert.equal(barWidthPct(8.1, 8.1), 50);
  assert.equal(barWidthPct(-8.1, 8.1), 50);
  assert.equal(barWidthPct(100, 8.1), 50, "an outlier is capped, not allowed to overflow");
  assert.equal(barWidthPct(4.05, 8.1), 25);
});

test("a category with no overrides has no bar and no zero", () => {
  const cal = buildCalibration([
    score({ category: "Operations" }),
    score({ category: "Sales", adjusted: 70, reviewer: "Sara" }),
  ]);
  const ops = cal.categories.find((c) => c.category === "Operations");

  assert.equal(ops?.mean, null, "null renders an em-dash; 0 would claim agreement");
  assert.equal(ops?.overrides, 0);
  assert.equal(maxAbsMean(cal.categories), 10);
});

/* ───────────────── formatting ───────────────── */

test("sub-cent rates keep the third decimal that distinguishes them", () => {
  assert.equal(formatMicro(21_000), "$0.021");
  assert.equal(formatMicro(25_000), "$0.025");
  assert.equal(formatMicro(0), "$0.00");
  assert.equal(formatMicro(4_970_000), "$4.97");
  assert.equal(formatMicro(MICRO), "$1.00");
});

/* ───────────── interviews: submitted is not scored ───────────── */

test("submitted interviews are counted even when none were scored", () => {
  // The exact shape that made the card read 0: sessions were submitted and
  // transcribed, but the `interview_scored` meter never fired.
  const row = buildCompanyRow(company({ interviewsSubmitted: 3, transcribedMinutes: 5 }), [], NOW);

  assert.equal(row.interviews, 3, "submitted is the volume figure");
  assert.equal(row.interviewsScored, 0, "and it is NOT the billable figure");
  assert.equal(row.transcribedMinutes, 5);

  const stats = buildStats([row], 1);
  assert.equal(stats.interviews, 3);
  assert.equal(stats.interviewsScored, 0);
  assert.deepEqual(reconcile(buildCalibration([]), [row], stats), []);
});

test("the interview money line prices the SCORED count, not the submitted one", () => {
  const usage: UsageRow[] = [{ companyId: "co-1", type: "interview_scored", quantity: 2 }];
  const row = buildCompanyRow(company({ interviewsSubmitted: 9 }), usage, NOW);

  assert.equal(row.interviews, 9);
  assert.equal(row.interviewsScored, 2);
  const line = row.money.find((m) => m.label === "Interview scoring");
  assert.equal(line?.workings, "2 × $0.012", "billing follows the meter, not the submissions");
  assert.equal(row.costMicro, 2 * 12_000);
});

/* ───────────── prompt versions: two scorers, two currents ───────────── */

test("version rank reads the trailing number of a real prompt version", () => {
  const rows: ScoreRow[] = [
    score({ kind: "cv", promptVersion: "cv-scoring-v3" }),
    score({ kind: "cv", promptVersion: "cv-scoring-v10" }),
    score({ kind: "cv", promptVersion: "cv-scoring-v9" }),
  ];
  // v10 must outrank v9 and v3. The old /^v(\d+)/ matched none of these, so
  // every row ranked equal and the sort degraded to insertion order.
  assert.deepEqual(
    byVersion(rows).map((v) => v.version),
    ["cv-scoring-v10", "cv-scoring-v9", "cv-scoring-v3"],
  );
});

test("each scorer keeps its own sequence, grouped not interleaved", () => {
  const rows: ScoreRow[] = [
    score({ kind: "cv", promptVersion: "cv-scoring-v3" }),
    score({ kind: "interview", promptVersion: "interview-scoring-v3" }),
    score({ kind: "cv", promptVersion: "cv-scoring-v10" }),
  ];
  const versions = byVersion(rows);

  assert.deepEqual(
    versions.map((v) => v.version),
    ["cv-scoring-v10", "cv-scoring-v3", "interview-scoring-v3"],
  );
  assert.deepEqual(
    versions.map((v) => v.kind),
    ["cv", "cv", "interview"],
  );

  // TWO rows are current at once — the whole point. A positional "row 0 is
  // live" rule can only ever mark one of them.
  const live = { cv: "cv-scoring-v10", interview: "interview-scoring-v3" };
  const marked = versions.filter((v) => v.version === live.cv || v.version === live.interview);
  assert.equal(marked.length, 2);
});

test("versions still sum to the corpus once grouped by scorer", () => {
  const rows: ScoreRow[] = [
    score({ kind: "cv", promptVersion: "cv-scoring-v10", adjusted: 70, reviewer: "Sara" }),
    score({ kind: "cv", promptVersion: null }),
    score({ kind: "interview", promptVersion: "interview-scoring-v3" }),
  ];
  const cal = buildCalibration(rows);

  assert.equal(
    cal.versions.reduce((a, v) => a + v.scored, 0),
    cal.scored,
  );
  assert.equal(
    cal.versions.reduce((a, v) => a + v.overrides, 0),
    cal.overrides,
  );
  assert.ok(cal.versions.some((v) => v.version === UNKNOWN_VERSION));
});
