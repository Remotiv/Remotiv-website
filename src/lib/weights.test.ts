/**
 * The weight round trip.
 *
 *   node --test src/lib/weights.test.ts
 *
 * ── What this exists to catch ────────────────────────────────
 *
 * Three defects lived in the weighting vocabulary for as long as nothing
 * asserted anything about it, and all three were invisible on screen:
 *
 *   1. The save path clamped to the range 1-5 against stops of {1,2,4,6}, so a
 *      question set to "Most" was stored as 5, reopened as Normal, and weighted
 *      at 5 by the rollup. Three values for one click.
 *   2. The default was a bare 1 in four modules. On these stops 1 is LESS, so
 *      every interview question started at half weight while the UI called
 *      Normal the baseline.
 *   3. The CV scorer assumed 3 for an unset dimension under a comment claiming
 *      it mirrored the default of 2. 3 is not a stop at all.
 *
 * The property that would have caught all three is the round trip: a weight a
 * recruiter picks must survive being saved and reloaded, and must mean the same
 * thing to the scorer as it does on screen. That is what the first test asserts,
 * and it asserts it for every stop rather than for a sample — the bug was in
 * exactly one of the four.
 */

// @ts-nocheck — same reason as src/lib/jd/parse.test.ts: the `./weights.ts`
// specifier Node requires is rejected by this repo's tsconfig, which does not
// set `allowImportingTsExtensions`. `node --test` still type-strips and runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CV_WEIGHT_DEFAULT,
  CV_WEIGHT_MAX,
  CV_WEIGHT_MIN,
  multiplierForStored,
  snapWeight,
  stopForStored,
  WEIGHT_STOPS,
  weightShares,
  weightsAreEqual,
} from "./weights.ts";

/**
 * The save path, transcribed.
 *
 * `sanitizeQuestions` writes `snapWeight(q.weight)` and the wizard holds the
 * weight as a STRING, so the round trip must survive the string boundary too —
 * the old clampInt took a string and this is where a silent NaN would land.
 */
const save = (picked) => snapWeight(String(picked));
const reload = (stored) => String(snapWeight(stored));

test("every stop survives save and reload", () => {
  for (const stop of WEIGHT_STOPS) {
    const stored = save(stop.stored);
    assert.equal(stored, stop.stored, `${stop.label} did not survive the save`);

    const reopened = stopForStored(Number(reload(stored)));
    assert.equal(reopened.stored, stop.stored, `${stop.label} reopened as ${reopened.label}`);
    assert.equal(
      reopened.multiplier,
      stop.multiplier,
      `${stop.label} reopened with the wrong multiplier`,
    );
  }
});

test("the screen and the scorer agree on every stop", () => {
  // The exact failure of the Most bug: the stored int the rollup multiplies by
  // must be the one the highlighted button represents.
  for (const stop of WEIGHT_STOPS) {
    const stored = save(stop.stored);
    assert.equal(multiplierForStored(stored), stop.multiplier, `${stop.label} scores differently`);
  }
});

test("Most is not silently downgraded", () => {
  // The regression itself, named, because a range check would pass every test
  // above except this one if the stops were ever widened again.
  const most = WEIGHT_STOPS.at(-1);
  assert.equal(most.label, "Most");
  assert.equal(save(most.stored), most.stored);
  assert.equal(stopForStored(save(most.stored)).label, "Most");
});

test("the default is Normal, not Less", () => {
  const normal = WEIGHT_STOPS.find((s) => s.label === "Normal");
  assert.equal(CV_WEIGHT_DEFAULT, normal.stored);
  assert.equal(multiplierForStored(CV_WEIGHT_DEFAULT), 1);
  // 1 is a real stop and a plausible-looking default, which is why it survived
  // in four modules. It is Less.
  assert.equal(stopForStored(1).label, "Less");
});

test("snapWeight never returns a value that is not a stop", () => {
  const legal = new Set(WEIGHT_STOPS.map((s) => s.stored));
  const hostile = [
    0,
    3,
    5,
    7,
    99,
    -1,
    -6,
    1.4,
    2.6,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    "",
    " ",
    "4",
    "6",
    "most",
    "2.9",
    {},
    [],
  ];
  for (const raw of hostile) {
    const snapped = snapWeight(raw);
    assert.ok(legal.has(snapped), `snapWeight(${JSON.stringify(raw)}) returned ${snapped}`);
  }
});

test("the values a range check would have let through become Normal", () => {
  // 3 and 5 sit inside CV_WEIGHT_MIN..MAX but are not stops. They are exactly
  // what the old clamp admitted, and what legacy rows still hold.
  for (const orphan of [3, 5]) {
    assert.ok(orphan >= CV_WEIGHT_MIN && orphan <= CV_WEIGHT_MAX, "orphan is inside the range");
    assert.equal(snapWeight(orphan), CV_WEIGHT_DEFAULT);
    assert.equal(stopForStored(orphan).label, "Normal");
  }
});

test("the stops are the four the UI draws, in order", () => {
  assert.deepEqual(
    WEIGHT_STOPS.map((s) => [s.label, s.multiplier, s.stored]),
    [
      ["Less", 0.5, 1],
      ["Normal", 1, 2],
      ["More", 2, 4],
      ["Most", 3, 6],
    ],
  );
  // Stored ints are the multipliers doubled, which is what lets every consumer
  // divide by the total and get the multiplier's ratios back.
  for (const s of WEIGHT_STOPS) assert.equal(s.stored, s.multiplier * 2);
});

test("shares are proportional to the multipliers and total 100", () => {
  assert.deepEqual(weightShares([2, 2, 2, 2]), [25, 25, 25, 25]);
  // Raising every dimension equally is a scale factor, not a decision.
  assert.deepEqual(weightShares([4, 4, 4, 4]), weightShares([2, 2, 2, 2]));
  /*
   * Most against three Normals is 3/6 and 1/6 each — 50 and 16.67, which round
   * to 50 + 17 + 17 + 17 = 101. The largest share absorbs the drift, so the
   * leader reads 49 rather than the bar totalling 101. Asserted rather than
   * fixed: a key that does not add up to 100 under a full-width bar is what
   * makes a reader distrust the whole number.
   */
  assert.deepEqual(weightShares([6, 2, 2, 2]), [49, 17, 17, 17]);

  for (const set of [
    [1, 2, 4, 6],
    [6, 1, 1, 1],
    [1, 1, 1, 1],
    [2, 4, 6, 4],
  ]) {
    assert.equal(
      weightShares(set).reduce((a, b) => a + b, 0),
      100,
      `shares for ${set} did not total 100`,
    );
  }
});

test("a stop that is not stored equally is not 'equal'", () => {
  assert.ok(weightsAreEqual([2, 2, 2, 2]));
  assert.ok(weightsAreEqual([]));
  assert.ok(!weightsAreEqual([2, 2, 2, 6]));
  // Null means unset, which reads as Normal — so this set IS equal.
  assert.ok(weightsAreEqual([2, null, undefined, 2]));
});
