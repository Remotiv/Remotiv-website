/**
 * #2.6 — what `application_scores.effective_score` holds, and that the page
 * RANKS by exactly the number it SHOWS.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/effective-score-gate.test.ts"
 *
 * ── THESE TESTS ARE RED UNTIL THE WIDENING IS APPLIED ────────────
 *
 * Two migrations, not one. The first (applied 17 Oct) gated the column on
 * status. The second widens that gate, and this file is written against the
 * widened form — so it describes a column state that is not live until the
 * `SET EXPRESSION AS` in the #2.6 report has run. Nothing here deploys before
 * it does. See `effectiveScoreFromLiveSchema`.
 *
 * ── The original defect, and the one the fix for it created ──────
 *
 * Best Match orders in the database by `application_scores.effective_score` and
 * DISPLAYS `toScore().overall`. Those two are one rule expressed twice, and any
 * row where they disagree is a row the page ranks by a number it does not show.
 *
 * Ungated, `effective_score` was `coalesce(human_adjusted_score, overall_score)`
 * with no reference to status, so a scorecard holding a number at any status
 * sorted on it and rendered blank — a recruiter was shown, in first position, an
 * applicant the same page called unscored.
 *
 * Gating it on `status = 'scored'` closed that and opened the inverse. Decision
 * (B) says a recruiter must be able to score a CV the AI skipped — 100 of 148
 * score records are 'skipped', and two of the six conditions that write 'skipped'
 * (scoring switched off, allowance exhausted) are TRANSIENT, so that path is the
 * normal state of a workspace that ran out of allowance mid-batch, not a corner.
 * Under (B) `toScore` reports such a row as scored and shows the human's number
 * — while `status` stays 'skipped', so a status-only column answers NULL and the
 * list ranks that candidate LAST. Same divergence, inverted.
 *
 * So the column and `toScore` are both:
 *
 *     status = 'scored' OR human_adjusted_score IS NOT NULL
 *       ? coalesce(human_adjusted_score, overall_score)
 *       : null
 *
 * The first disjunct keeps a FAILED re-score from ranking on the stale
 * overall_score it still carries. The second makes a human's correction rank
 * where it displays. Both are load-bearing and the tests below separate them:
 * every case is run in an adjusted and an unadjusted variant, because an
 * expression that dropped either disjunct passes half of them.
 *
 * ── Why the fixture computes the column instead of being handed it ──
 *
 * fake-list-db.mjs is a PostgREST emulator: it sorts and pages what the query
 * asks for, and takes every column value from the fixture. It does not model a
 * generated column, so a test that simply set `effective_score` by hand would be
 * asserting against a database of its own invention — which is the one thing it
 * must not do.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fakeListDb } = await import("../../../../test-support/fake-list-db.mjs");
const { fetchCompanyApplicants, fetchTopScoredApplicants } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const J1 = "a0000000-0000-0000-0000-00000000000a";

/**
 * Every status the live CHECK constraint permits, and no others.
 *
 *   CONSTRAINT application_scores_status_check
 *     CHECK (status = ANY (ARRAY['pending','scored','failed','skipped']))
 *
 * Four, not the six an earlier draft of this file swept. 'queued' and 'running'
 * are states the queue has but this column cannot hold, and including them
 * spent two cases of the mixed-population test on rows the database would
 * reject on insert — coverage that reads as thorough and asserts nothing.
 */
const STATUSES = ["pending", "scored", "failed", "skipped"];

/**
 * `application_scores.effective_score`, as the database computes it.
 *
 * ── Applying a #2.6 migration means editing this function ───────
 *
 * It is not a test helper. It is a copy of a schema expression, and it is the
 * only place in the suite that decides what the ordering column holds. The
 * migration and this body change in the SAME commit:
 *
 *   -  if (row.status !== "scored") return null;
 *   +  if (row.status !== "scored" && row.human_adjusted_score === null) return null;
 *      return row.human_adjusted_score ?? row.overall_score ?? null;
 *
 * Deliberately NOT a flag. A boolean would let someone turn these tests green
 * without the database changing, which is precisely the failure this file is
 * here to make impossible: the test and the column must be unable to disagree
 * without someone editing a function whose comment says what it is a copy of.
 *
 * `=== null` and not a truthiness test, in both this and `toScore`: an
 * adjustment of 0 is a real judgement — "I looked, and no" — and has to rank at
 * the bottom rather than read as an absence and rank nowhere. Test 9 is the one
 * that fails if this is written as `!row.human_adjusted_score`.
 *
 * `?? null` rather than falling out as undefined: PostgREST sends JSON null and
 * the fake orders on null placement, so undefined would sort as its own third
 * state and the nulls-last assertions would stop meaning anything.
 */
function effectiveScoreFromLiveSchema(row) {
  if (row.status !== "scored" && row.human_adjusted_score === null) return null;
  return row.human_adjusted_score ?? row.overall_score ?? null;
}

/**
 * A scorecard, with `effective_score` derived rather than supplied.
 *
 * The field list matches SCORE_EMBED_FIELDS in actions.ts, because the embed
 * selects named columns and a row missing one would read as null for reasons
 * that have nothing to do with the gate.
 *
 * `confidence` follows the MODEL's number, not the effective one: a CV the
 * scorer never read has no model confidence to report, and handing one to a
 * human-adjusted skipped row would let the card's confidence branch cover for a
 * missing lede. Same for `error`, which only a failed run writes.
 */
function scoreRow({ id, status, overall = null, adjusted = null }) {
  const row = {
    application_id: id,
    status,
    overall_score: overall,
    human_adjusted_score: adjusted,
    confidence: status === "scored" && overall !== null ? "high" : null,
    error: status === "failed" ? "model timeout" : null,
  };
  return { ...row, effective_score: effectiveScoreFromLiveSchema(row) };
}

/** Descending created_at so the fixture's own order is unambiguous. */
function appRow(n) {
  const id = `app-${String(n).padStart(5, "0")}`;
  return {
    id,
    company_id_snapshot: CO,
    job_id: J1,
    first_name: "Cand",
    last_name: id,
    email: `${id}@t.test`,
    created_at: `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    pipeline_stage: "applied",
    is_flagged: false,
    deleted_at: null,
  };
}

const ctx = {
  companyId: CO,
  role: "owner",
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
};

async function run(action, query = {}, world) {
  const service = fakeService(fakeListDb(world));
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctx;
  const quiet = console.error;
  console.error = () => {};
  try {
    return await action(query);
  } finally {
    console.error = quiet;
  }
}

const jobs = [{ id: J1, company_id: CO, title: "Engineer", deleted_at: null, status: "open" }];

/** Three genuinely scored candidates, spanning the range a stale row would beat. */
const SCORED = [
  { n: 1, overall: 90 },
  { n: 2, overall: 70 },
  { n: 3, overall: 50 },
];

/**
 * A world of the three scored candidates plus one row under test.
 * `under` is the scorecard whose status and adjustment are the variables.
 */
function worldWith(under) {
  const apps = [...SCORED.map((s) => appRow(s.n)), appRow(under.n)];
  const scores = [
    ...SCORED.map((s) => scoreRow({ id: appRow(s.n).id, status: "scored", overall: s.overall })),
    scoreRow({ ...under, id: appRow(under.n).id }),
  ];
  return { apps, scores, jobs, team: [] };
}

/** Where a row lands in the page the action returned. */
function rankOf(rows, id) {
  return rows.findIndex((r) => r.id === id);
}

/**
 * THE invariant: the order the database returned is the order of the numbers
 * the page displays, descending, with the unscored last.
 *
 * Stated over the RETURNED rows, so it holds the database's ORDER BY and the
 * TypeScript display rule against each other directly. No expected sequence is
 * written down — which is the point: the test cannot be satisfied by agreeing
 * with itself, and it catches a route nobody enumerated.
 *
 * Strictly stronger than the "no unscored row outranks a scored one" check this
 * replaces. That one passes on a page ordered 90, 50, 70 — all three scored,
 * none above an unscored row, and the ranking simply wrong. Under (B) that is
 * the live failure mode: a human-adjusted row displays a number AND sorts on
 * NULL, so it lands among the scored rows in the wrong place rather than behind
 * a visible boundary.
 */
function assertRankMatchesDisplay(rows, note) {
  const shown = rows.map((r) => r.score.overall);
  const firstNull = shown.indexOf(null);
  if (firstNull !== -1) {
    const strays = rows.slice(firstNull).filter((r) => r.score.overall !== null);
    assert.deepEqual(
      strays.map((r) => `${r.id}=${r.score.overall}`),
      [],
      `${note}: ${strays[0]?.id} shows ${strays[0]?.score.overall} but sorts below ` +
        `${rows[firstNull].id}, which the page shows no score for (status ` +
        `${rows[firstNull].score.status}) — ranked by a number the page does not display`,
    );
  }
  const scored = shown.filter((s) => s !== null);
  assert.deepEqual(
    scored,
    [...scored].sort((a, b) => b - a),
    `${note}: the displayed scores are not in the order the page returned them ` +
      `(${shown.map((s) => s ?? "—").join(", ")}) — the sort column and the ` +
      "displayed number disagree",
  );
}

// ── 1. Route A: a re-score that failed after succeeding ─────
// The first disjunct. Unchanged by (B), and must stay so.

test("a FAILED re-score that kept its old number neither ranks nor displays", async () => {
  // status='failed', overall_score=85 retained, NO adjustment. The drawer shows
  // 85 as history; the list must show nothing. Ungated, effective_score is 85
  // and the row sorts second of four.
  const under = { n: 9, status: "failed", overall: 85 };
  const read = await run(fetchCompanyApplicants, { sort: "best" }, worldWith(under));
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  const stale = rows.find((r) => r.id === appRow(9).id);
  assert.equal(stale.score.overall, null, "the page should show no score for a failed card");

  assertRankMatchesDisplay(rows, "route A");
  assert.equal(
    rankOf(rows, appRow(9).id),
    3,
    "a failed scorecard holding 85 ranked among the scored candidates",
  );
});

// ── 2. The same row once a human corrects it ────────────────
// The second disjunct, and the case (B) exists for.

test("a FAILED card a human then scored ranks AND displays the human's number", async () => {
  /*
   * The pair to test 1, differing in one field. The model's attempt failed and
   * left 85 behind; a reviewer looked at the CV and said 65. 65 is the number
   * the page shows and the number it must sort on — the human's judgement
   * outlives the status, and it is not the stale 85 either.
   *
   * An expression gated on status alone shows 65 and sorts this row LAST.
   */
  const under = { n: 9, status: "failed", overall: 85, adjusted: 65 };
  const read = await run(fetchCompanyApplicants, { sort: "best" }, worldWith(under));
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  const fixed = rows.find((r) => r.id === appRow(9).id);
  assert.equal(fixed.score.overall, 65, "the human's correction is the number to show");
  assert.equal(fixed.score.status, "scored", "a human-scored row reads as scored");
  assert.equal(fixed.score.ai_overall, null, "a FAILED run's leftover 85 is not an AI score");
  assert.equal(fixed.score.adjusted, true);

  // 90, 70, 65, 50 — between the 70 and the 50, where 65 belongs.
  assert.equal(rankOf(rows, appRow(9).id), 2, "the correction did not rank where it displays");
  assertRankMatchesDisplay(rows, "failed + adjusted");
});

// ── 3. The 100 skipped rows, both ways ──────────────────────

test("a SKIPPED card retaining a number neither ranks nor displays", async () => {
  // Not hypothetical: 100 of 148 scorecards sit at 'skipped' in production, and
  // two of the six conditions that write it are transient.
  const under = { n: 9, status: "skipped", overall: 88 };
  const read = await run(fetchCompanyApplicants, { sort: "best" }, worldWith(under));
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  assert.equal(rows.find((r) => r.id === appRow(9).id).score.overall, null);
  assertRankMatchesDisplay(rows, "skipped, unadjusted");
});

test("a SKIPPED CV the recruiter scored by hand ranks AND displays", async () => {
  /*
   * Decision (B) itself: the model never produced a number for this CV — there
   * is no overall_score at all — and a recruiter read it and said 95. That is
   * the best candidate on the page and must sort first.
   *
   * This is the row a status-only column gets most wrong: it displays 95 and
   * sorts on NULL, so the strongest candidate in the workspace lands at the
   * very bottom of Best Match.
   */
  const under = { n: 9, status: "skipped", adjusted: 95 };
  const read = await run(fetchCompanyApplicants, { sort: "best" }, worldWith(under));
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  assert.equal(rows[0].id, appRow(9).id, "the recruiter's 95 did not take first place");
  assert.equal(rows[0].score.overall, 95);
  assert.equal(rows[0].score.ai_overall, null, "there is no AI number to compare against");
  assertRankMatchesDisplay(rows, "skipped + adjusted");
});

// ── 4. An adjustment mid-flight ─────────────────────────────

test("an adjustment on a PENDING card ranks AND displays", async () => {
  // A correction typed while the scorer is still queued. Under (B) this is not
  // an anomaly to suppress — it is a human judgement, and the queue finishing
  // later will not overwrite it (writeScoreRow leaves the override columns).
  const under = { n: 9, status: "pending", adjusted: 95 };
  const read = await run(fetchCompanyApplicants, { sort: "best" }, worldWith(under));
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  assert.equal(rows[0].id, appRow(9).id);
  assert.equal(rows[0].score.overall, 95);
  assertRankMatchesDisplay(rows, "pending + adjusted");
});

// ── 5. The invariant over the whole status domain ───────────

test("across every permitted status, adjusted and not, rank and display agree", async () => {
  /*
   * The generalisation of tests 1 to 4, over the four statuses the CHECK
   * constraint permits. Each appears three times — holding only an AI number,
   * holding only a human override, and holding both and disagreeing — spread
   * through the same range as three genuine scores so a mis-ranked row has
   * something to be wrongly above AND below.
   *
   * No expected order is written down. The assertion is that the sequence of
   * displayed numbers is the sequence the database returned, which is the whole
   * of what #2.6 establishes.
   */
  const apps = [];
  const scores = [];
  let n = 0;
  const held = [
    (k) => ({ overall: 95 - k }),
    (k) => ({ adjusted: 94 - k }),
    (k) => ({ overall: 30 + k, adjusted: 93 - k }),
  ];
  for (const status of STATUSES) {
    for (const shape of held) {
      n += 1;
      const a = appRow(n);
      apps.push(a);
      scores.push(scoreRow({ id: a.id, status, ...shape(n) }));
    }
  }
  for (const overall of [99, 60, 20]) {
    n += 1;
    const a = appRow(n);
    apps.push(a);
    scores.push(scoreRow({ id: a.id, status: "scored", overall }));
  }

  const read = await run(
    fetchCompanyApplicants,
    { sort: "best" },
    { apps, scores, jobs, team: [] },
  );
  assert.equal(read.ok, true);
  assert.equal(read.value.rows.length, apps.length, "the fixture should fit on one page");
  assertRankMatchesDisplay(read.value.rows, "mixed statuses");

  // And the population splits the way the expression says it must, so this test
  // cannot pass by showing nothing at all.
  const shown = read.value.rows.filter((r) => r.score.overall !== null).length;
  assert.equal(
    shown,
    // 3 genuine + all 3 'scored' shapes + the 2 adjusted shapes of each of the
    // other three statuses.
    3 + 3 + 3 * 2,
    "the number of rows carrying a score is not what the widened expression implies",
  );
});

// ── 6. The positive control: the gate must not damage scores ─

test("the gate leaves every genuinely scored row exactly where it was", async () => {
  /*
   * The counterweight, and the check that matters most on the day the migration
   * runs. An expression that over-gates — anything that drops a 'scored' row's
   * number — would make the tests above pass while silently unscoring the whole
   * population, and the list would then be ordered by nothing at all.
   *
   * The test-suite form of the live verification: after the migration,
   * `count(*) where effective_score is not null` must be 48 or more, never
   * fewer. If it falls, the change damaged real scores and is rolled back.
   */
  const apps = [];
  const scores = [];
  const expect = [];
  // Both shapes a 'scored' row comes in: the model's number, and a human
  // override that must keep winning over it.
  for (const [i, s] of [
    { overall: 91 },
    { overall: 40, adjusted: 88 },
    { overall: 77 },
    { overall: 99, adjusted: 12 },
  ].entries()) {
    const a = appRow(i + 1);
    apps.push(a);
    scores.push(scoreRow({ id: a.id, status: "scored", overall: s.overall, adjusted: s.adjusted }));
    expect.push(s.adjusted ?? s.overall);
  }

  const read = await run(
    fetchCompanyApplicants,
    { sort: "best" },
    { apps, scores, jobs, team: [] },
  );
  assert.equal(read.ok, true);
  const rows = read.value.rows;

  assert.equal(
    rows.every((r) => r.score.overall !== null),
    true,
    "the gate unscored a genuinely scored row",
  );
  // Ordered by the number the page displays, descending — the override
  // included, because the override IS the score once a human has set one.
  assert.deepEqual(
    rows.map((r) => r.score.overall),
    [...expect].sort((a, b) => b - a),
    "the ranking of genuinely scored rows changed",
  );
});

// ── 7. A 'scored' row that holds no number ──────────────────

test("a 'scored' card with no number is unscored, not a zero", async () => {
  // Status alone is not enough in either direction: `effective_score IS NOT
  // NULL` is the top-scored read's gate because this row exists, and a column
  // written as `status='scored' THEN coalesce(...)` must not turn it into a 0
  // that sorts above a genuine 50.
  const apps = [appRow(1), appRow(2)];
  const scores = [
    scoreRow({ id: appRow(1).id, status: "scored" }),
    scoreRow({ id: appRow(2).id, status: "scored", overall: 50 }),
  ];
  const read = await run(
    fetchCompanyApplicants,
    { sort: "best" },
    { apps, scores, jobs, team: [] },
  );
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  assert.equal(rows[0].id, appRow(2).id, "a scored card with no number outranked a real 50");
  assert.equal(rows[1].score.overall, null, "an absent score rendered as a number");
  assertRankMatchesDisplay(rows, "scored-but-empty");
});

// ── 8. The two reads agree, in both directions ──────────────

test("the top-scored read admits exactly the rows the list shows a score for", async () => {
  /*
   * One expression, not two filters to keep in step. fetchTopScoredApplicants
   * gates on `effective_score IS NOT NULL` and nothing else, so the chips and
   * the list are answering the same question by construction.
   *
   * Both directions, because each was live at a different point in this work:
   *
   *   - A pending card holding only an AI number must be refused. Before #2.6
   *     the LIST ranked it first while the chips refused it — on the same page,
   *     in the same paint.
   *   - A skipped CV a recruiter scored must be ADMITTED. A second
   *     `.eq("status","scored")` on this read would refuse it while the list
   *     showed its score, which is the same divergence moved to the chips. That
   *     filter is why this test has a second half.
   */
  const refused = await run(
    fetchTopScoredApplicants,
    {},
    worldWith({ n: 9, status: "pending", overall: 95 }),
  );
  assert.equal(refused.ok, true);
  assert.equal(
    refused.value.some((r) => r.id === appRow(9).id),
    false,
    "the top-scored read admitted a row with no number to show",
  );
  assert.deepEqual(
    refused.value.map((r) => r.score.overall),
    [90, 70, 50],
  );

  const admitted = await run(
    fetchTopScoredApplicants,
    {},
    worldWith({ n: 9, status: "skipped", adjusted: 95 }),
  );
  assert.equal(admitted.ok, true);
  assert.deepEqual(
    admitted.value.map((r) => r.score.overall),
    [95, 90, 70, 50],
    "the top-scored read refused a candidate the list ranks first and shows a score for",
  );
});

// ── 9. Zero is a judgement, not an absence ──────────────────

test("an adjustment of 0 ranks below the scores but ABOVE the unscored", async () => {
  /*
   * The case that fails if either the column or `toScore` is written with a
   * truthiness test instead of a null check. "I read this CV and it is a 0" is
   * a finding, and it has to appear at the bottom of the RANKING with a visible
   * 0 — not vanish into the unscored tail where it is indistinguishable from a
   * CV nobody has looked at.
   *
   * ── This test needed a second attempt ──
   *
   * The first version ran against worldWith(), which is three scored rows plus
   * the row under test, and asserted the 0 landed at index 3. With four rows
   * "last among the scored" and "first in the nulls tail" are the SAME index,
   * so it passed under a truthiness bug — the mutation that writes
   * `!row.human_adjusted_score` was invisible to it. It was a test that could
   * not fail.
   *
   * So the world carries a genuinely unscored row too, and with a LATER
   * created_at than the 0 — the Best Match tiebreaker is created_at descending,
   * so under the bug the 0 falls behind it in the nulls tail and
   * assertRankMatchesDisplay sees a row showing 0 sorted below a row showing
   * nothing. The 0 must now beat something to pass.
   */
  const zeroApp = appRow(9);
  const neverLooked = appRow(20);
  const world = worldWith({ n: 9, status: "skipped", adjusted: 0 });
  world.apps.push(neverLooked);
  world.scores.push(scoreRow({ id: neverLooked.id, status: "skipped" }));

  const read = await run(fetchCompanyApplicants, { sort: "best" }, world);
  assert.equal(read.ok, true);

  const rows = read.value.rows;
  const zero = rows.find((r) => r.id === zeroApp.id);
  assert.equal(zero.score.overall, 0, "an adjustment of 0 read as no score");
  assert.equal(zero.score.status, "scored");
  assert.equal(rows.find((r) => r.id === neverLooked.id).score.overall, null);

  assert.equal(rankOf(rows, zeroApp.id), 3, "the 0 did not sort below the genuine scores");
  assert.equal(
    rankOf(rows, neverLooked.id),
    4,
    "a CV nobody scored outranked a CV a reviewer scored 0",
  );
  assertRankMatchesDisplay(rows, "adjusted to 0");
});

// ── 10. Clearing a correction returns the row to where it was ─

test("clearing an adjustment returns a skipped row to unscored", async () => {
  /*
   * The round trip, and why clearScoreAdjustment nulls all five columns and is
   * gated on nothing but the row existing. Under (B) the adjustment is the only
   * thing making a skipped row rank and display; removing it must put the row
   * back exactly where it started, not strand it holding a number.
   *
   * Asserted as two worlds rather than by calling the action, because the fake
   * is a read emulator — what matters here is that the SAME row with and
   * without `human_adjusted_score` reads as scored and then unscored.
   */
  const withAdj = await run(
    fetchCompanyApplicants,
    { sort: "best" },
    worldWith({ n: 9, status: "skipped", adjusted: 72 }),
  );
  const cleared = await run(
    fetchCompanyApplicants,
    { sort: "best" },
    worldWith({ n: 9, status: "skipped" }),
  );
  assert.equal(withAdj.ok, true);
  assert.equal(cleared.ok, true);

  assert.equal(withAdj.value.rows.find((r) => r.id === appRow(9).id).score.overall, 72);
  assert.equal(cleared.value.rows.find((r) => r.id === appRow(9).id).score.overall, null);
  assert.equal(rankOf(cleared.value.rows, appRow(9).id), 3, "a cleared row kept its ranking");
  assertRankMatchesDisplay(cleared.value.rows, "cleared");
});
