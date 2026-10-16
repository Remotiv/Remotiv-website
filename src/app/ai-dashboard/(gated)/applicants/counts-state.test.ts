/**
 * The three ways a fetched count can state something the page cannot support,
 * executed rather than pinned.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/counts-state.test.ts"
 *
 * ── Why this module exists at all ────────────────────────────
 *
 * The Applicants page's population figures were `array.length`, so they could
 * not be stale and could not fail. Reading them from the database gives each
 * one a response that arrives at a moment unrelated to the one it was asked
 * for, and three new ways to lie:
 *
 *   1. A LATE response overwriting a newer one. Job A -> job B -> job A leaves
 *      two outstanding requests BOTH carrying key A, so matching the key is
 *      not sufficient and the first test here is the one that proves it.
 *
 *   2. The previous filter's figures presented as the current filter's. Kept
 *      on screen deliberately — blanking the hero on every filter change is
 *      worse — but only while the page says they are being refreshed.
 *
 *   3. A failed count rendered as 0. "0 applicants" over a company with two
 *      thousand of them is believed instantly, because nothing about it looks
 *      broken. Hence the discriminating pair: unknown draws an em dash, a true
 *      zero still draws 0.
 *
 * There is no DOM test runner in this repo, so a rendering assertion is not
 * available and a source pin would prove nothing about behaviour. Every
 * decision that can be wrong is therefore a pure function, and this file runs
 * them.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const {
  countLabel,
  countsKey,
  countsView,
  ledeCount,
  requestCounts,
  seedCounts,
  settleCounts,
  stagePercent,
} = await import("./counts-state.ts");

const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";

/**
 * A readable batch. `over` replaces whichever fields a test cares about, and
 * `over.stages` MERGES into the default stages rather than replacing them —
 * the per-number degradation test needs six readable stages and one null.
 */
const counts = (over = {}) => ({
  total: 7,
  newThisWeek: 3,
  openRoles: 2,
  ...over,
  stages: {
    applied: 4,
    screening: 1,
    shortlisted: 1,
    interview: 0,
    offer: 0,
    hired: 1,
    rejected: 0,
    ...(over.stages ?? {}),
  },
});

// ── 1. The out-of-order response ────────────────────────────

test("A -> B -> A: the older A response cannot overwrite the newer one", () => {
  // The whole reason a sequence number exists alongside the key. Both A
  // requests carry key A, so a key-only guard lets the first response — the
  // stale one — land on top of the second.
  let s = seedCounts(countsKey(null), counts());

  s = requestCounts(s, countsKey(JOB_A), 1);
  s = requestCounts(s, countsKey(JOB_B), 2);
  s = requestCounts(s, countsKey(JOB_A), 3);

  // The NEWEST A response arrives first.
  s = settleCounts(s, { key: countsKey(JOB_A), seq: 3, counts: counts({ total: 30 }) });
  assert.equal(countsView(s).total, 30);
  assert.equal(countsView(s).updating, false);

  // Now the FIRST A request answers, late, with a different number. Its key
  // matches what is displayed. It must still be discarded.
  s = settleCounts(s, { key: countsKey(JOB_A), seq: 1, counts: counts({ total: 11 }) });
  assert.equal(countsView(s).total, 30, "the stale A response overwrote the newer one");

  // And the B response, which is for a filter nobody is looking at.
  s = settleCounts(s, { key: countsKey(JOB_B), seq: 2, counts: counts({ total: 99 }) });
  assert.equal(countsView(s).total, 30);
});

test("a late FAILURE is discarded too, so it cannot blank a live number", () => {
  let s = seedCounts(countsKey(null), counts());
  s = requestCounts(s, countsKey(JOB_A), 1);
  s = requestCounts(s, countsKey(JOB_A), 2);

  s = settleCounts(s, { key: countsKey(JOB_A), seq: 2, counts: counts({ total: 5 }) });
  s = settleCounts(s, { key: countsKey(JOB_A), seq: 1, counts: null });

  const view = countsView(s);
  assert.equal(view.total, 5, "a stale failure dashed a figure that had been read fine");
  assert.equal(view.updating, false);
});

// ── 2. Stale figures must not pass as current ───────────────

test("the previous filter's figures stay on screen, but marked updating", () => {
  let s = seedCounts(countsKey(null), counts());
  assert.equal(countsView(s).updating, false);

  s = requestCounts(s, countsKey(JOB_A), 1);
  const mid = countsView(s);

  // Not blanked — a hero that collapses to dashes on every filter change is
  // worse than one showing figures it admits are being refreshed.
  assert.equal(mid.total, 7);
  assert.equal(mid.updating, true, "the old filter's numbers were presented as the new filter's");

  s = settleCounts(s, { key: countsKey(JOB_A), seq: 1, counts: counts({ total: 2 }) });
  assert.deepEqual(
    { total: countsView(s).total, updating: countsView(s).updating },
    { total: 2, updating: false },
  );
});

test("a settled response for a key the reader has since left stays updating", () => {
  let s = seedCounts(countsKey(null), counts());
  s = requestCounts(s, countsKey(JOB_A), 1);
  s = settleCounts(s, { key: countsKey(JOB_A), seq: 1, counts: counts({ total: 2 }) });

  // Reader moves to B. The A figures are what is on screen and they are not B's.
  s = requestCounts(s, countsKey(JOB_B), 2);
  assert.equal(countsView(s).total, 2);
  assert.equal(countsView(s).updating, true);
});

// ── 3. Unknown is not zero ──────────────────────────────────

test("a true zero renders 0 and an unknown renders an em dash", () => {
  // The discriminating pair. Without the first half, "unavailable on failure"
  // passes trivially by never showing a number at all.
  const zeros = seedCounts(
    countsKey(null),
    counts({
      stages: {
        applied: 0,
        screening: 0,
        shortlisted: 0,
        interview: 0,
        offer: 0,
        hired: 0,
        rejected: 0,
      },
      total: 0,
      newThisWeek: 0,
      openRoles: 0,
    }),
  );
  const zeroView = countsView(zeros);
  assert.equal(zeroView.total, 0);
  assert.equal(countLabel(zeroView.total), "0");
  assert.equal(countLabel(zeroView.stages.applied), "0");
  assert.equal(countLabel(zeroView.openRoles), "0");

  const failed = countsView(seedCounts(countsKey(null), null));
  assert.equal(failed.total, null);
  assert.equal(countLabel(failed.total), "—");
  assert.equal(countLabel(failed.stages.applied), "—");
  assert.equal(countLabel(failed.openRoles), "—");
});

test("a failed batch drops the last-known figures rather than relabelling them", () => {
  let s = seedCounts(countsKey(null), counts());
  s = requestCounts(s, countsKey(JOB_A), 1);
  s = settleCounts(s, { key: countsKey(JOB_A), seq: 1, counts: null });

  // Keeping the "all" figures here would present one filter's counts as
  // another's with nothing on screen saying the read had failed.
  const view = countsView(s);
  assert.equal(view.total, null);
  assert.equal(view.newThisWeek, null);
  assert.equal(view.stages.hired, null);
  assert.equal(view.updating, false, "a failure is settled, not still in flight");
});

test("a single unreadable count dashes that one figure and no other", () => {
  // Per-number degradation: the stage counts each have their own request, so
  // one timing out must not take the rest of the hero with it.
  const partial = counts({ stages: { shortlisted: null }, total: null });
  const view = countsView(seedCounts(countsKey(null), partial));

  assert.equal(view.stages.shortlisted, null);
  assert.equal(view.stages.applied, 4);
  assert.equal(view.newThisWeek, 3);
  assert.equal(view.openRoles, 2);
  // And the total goes with it — see the no-partial-sums test below.
  assert.equal(view.total, null);
});

test("seeding from a failed server batch is FAILED, not a blank first paint", () => {
  // The page is server-rendered, so there is no loading state to fall back to.
  // A null seed has to be the unreadable state or the hero would sit looking
  // like it was still fetching something nobody is fetching.
  const s = seedCounts(countsKey(null), null);
  assert.equal(countsView(s).total, null);
  assert.equal(countsView(s).updating, false);
});

// ── The derived total and its percentages ───────────────────

test("a percentage needs BOTH sides, and 0% never stands for unknown", () => {
  assert.equal(stagePercent(4, 8), 50);
  assert.equal(stagePercent(0, 8), 0, "a stage nobody is in is genuinely 0%");
  assert.equal(stagePercent(0, 0), 0, "an empty pipeline is 0%, not a division by zero");
  assert.equal(stagePercent(null, 8), null);
  assert.equal(stagePercent(4, null), null);
  assert.equal(stagePercent(null, null), null);
});

test("the lede makes no claim about a total it does not know", () => {
  assert.equal(ledeCount(0), "No one has applied yet. ");
  assert.equal(ledeCount(1), "1 person has applied across your open roles. ");
  assert.equal(ledeCount(2), "2 people have applied across your open roles. ");
  // The em dash cannot warn a reader inside prose, so the clause is dropped
  // entirely. "No one has applied yet" would be the exact lie the dashes exist
  // to prevent, stated where nothing marks it as unknown.
  assert.equal(ledeCount(null), "");
});

test("the filter key is the job, and nothing else", () => {
  assert.equal(countsKey(null), "all");
  assert.equal(countsKey(JOB_A), JOB_A);
  assert.notEqual(countsKey(JOB_A), countsKey(JOB_B));
});
