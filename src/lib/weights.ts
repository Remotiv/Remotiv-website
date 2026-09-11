/**
 * The weighting vocabulary: the four stops, and every rule for reading them.
 *
 * ── Why this is its own module, with no imports ──────────────
 *
 * It used to live in app/ai-dashboard/lib/job-types.ts. It moved here for the
 * reason src/lib/jd/parse.ts and src/lib/job-location.ts live where they do:
 * a module with runtime imports cannot be loaded by `node --test`, and this is
 * safety-critical arithmetic that decides how candidates rank. Nothing here
 * imports anything, so weights.test.ts can load it with a relative specifier.
 *
 * That is not a hypothetical. Three separate defects lived in this vocabulary
 * for as long as it had no test:
 *
 *   · The save path clamped to the range 1-5 against stops of {1,2,4,6}, so
 *     "Most" was stored as 5, redisplayed as Normal, and weighted at 5 by the
 *     rollup — three different values for one click.
 *   · The default was 1 in four places, which on these stops is LESS. Every
 *     interview question started at half weight while the screen called Normal
 *     the baseline.
 *   · The CV scorer assumed 3 for an unset dimension, under a comment claiming
 *     it mirrored the default of 2. 3 is not even a stop.
 *
 * All three are the same failure: the stops were defined in one file and their
 * legal range and default were restated, differently, in four others. This
 * module is the single definition. Import it; do not restate it.
 *
 * job-types.ts re-exports everything here, so existing importers are unchanged.
 */

/**
 * The four stops of the weighting control: Less · Normal · More · Most.
 *
 * ── Multipliers are fractional; the columns are int ──────────
 *
 * The design specifies 0.5 / 1 / 2 / 3 against Normal. `cv_weight_*` and
 * `interview_questions.weight` are integer columns, so the stored value is the
 * multiplier DOUBLED: 1 / 2 / 4 / 6.
 *
 * Doubling rather than, say, storing the ordinal 1–4 keeps the stored number a
 * real multiplier. Every consumer divides by the total — applyCvWeights and the
 * interview rollup both do — so scaling all weights by a constant factor is
 * mathematically invisible: a set of {1,2,4,6} produces exactly the shares
 * {0.5,1,2,3} would. An ordinal would NOT, because 1..4 are not proportional to
 * 0.5..3, and the existing rollup would silently start weighting differently.
 *
 * It round-trips exactly because the map is a bijection over the four stops:
 * 0.5↔1, 1↔2, 2↔4, 3↔6. A job saved as Less reopens as Less.
 */
export const WEIGHT_STOPS = [
  { label: "Less", multiplier: 0.5, stored: 1 },
  { label: "Normal", multiplier: 1, stored: 2 },
  { label: "More", multiplier: 2, stored: 4 },
  { label: "Most", multiplier: 3, stored: 6 },
] as const;

export type WeightStop = (typeof WEIGHT_STOPS)[number];

/**
 * Normal. What every dimension and question sits on until someone moves it.
 *
 * THE definition. It was previously restated as a bare `1` in
 * EMPTY_QUESTION_INPUT, in sanitizeQuestions' fallback, in the edit-page
 * mapper and in the interview rollup, and as a bare `3` in the CV scorer — five
 * copies, three values, none of them agreeing with the two the UI used.
 *
 * 1 is not a neutral default on these stops. It is LESS, a half weight. Uniform
 * weights hid it, because every consumer divides by the total and a constant
 * factor cancels; it surfaced only for recruiters who moved one, where against
 * a baseline of Less a promotion to More lands at FOUR times its neighbours
 * instead of twice.
 */
export const CV_WEIGHT_DEFAULT = 2;

/**
 * Bounds for the stored int, kept for the `cv_weight_*` column clamp.
 *
 * NOT a substitute for snapWeight. A range admits 3 and 5, which are not stops
 * and which no control can produce — that gap is exactly how "Most" was lost.
 * Anything being written to a weight column should go through snapWeight.
 */
export const CV_WEIGHT_MIN = 1;
export const CV_WEIGHT_MAX = 6;

/**
 * Stored int → the stop it represents.
 *
 * Falls back to Normal for anything unrecognised rather than throwing: a row
 * carrying a legacy value (the column allowed 1–5 briefly) must still open the
 * wizard, and Normal is the neutral reading.
 */
export function stopForStored(stored: number | null | undefined): WeightStop {
  const found = WEIGHT_STOPS.find((s) => s.stored === stored);
  return found ?? WEIGHT_STOPS[1];
}

/** The multiplier a stored int represents, for display and the share bar. */
export function multiplierForStored(stored: number | null | undefined): number {
  return stopForStored(stored).multiplier;
}

/**
 * A weight from anywhere, snapped to a legal stop before it is stored.
 *
 * ── Snap, never clamp ────────────────────────────────────────
 *
 * This replaced `clampInt(weight, 1, 5, 1)` in sanitizeQuestions, which is
 * how "Most" was lost: the stops are {1,2,4,6} and the clamp's range was 1–5,
 * so 6 was quietly stored as 5. `stopForStored(5)` matches nothing and falls
 * back to Normal, so the recruiter chose Most, the row held 5, the screen said
 * Normal and the rollup weighted it at 5 — three values for one click, and
 * nothing asserted otherwise.
 *
 * A RANGE is the wrong shape for this. It admits 3 and 5, which are not
 * choices anyone can make, so the range and the stops can drift apart again
 * the next time a stop moves. Snapping cannot drift: WEIGHT_STOPS is the only
 * definition of a legal weight, and anything else becomes Normal.
 *
 * The honest consequence: a legacy row at 3 that is opened and saved untouched
 * becomes 2. That is a real change to a job's scoring, and it is the right one
 * — the screen has been rendering that row as Normal all along, so the snap
 * makes the stored number agree with what the recruiter was already told.
 */
export function snapWeight(raw: number | string | null | undefined): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return CV_WEIGHT_DEFAULT;
  return stopForStored(n).stored;
}

/**
 * Share of the total score each dimension carries, as whole percentages.
 *
 * This is what the step-8 stacked bar renders and what its status line reads
 * from. Computed from the MULTIPLIERS rather than the stored ints — identical
 * ratios either way, but the multipliers are what the copy talks about.
 *
 * Percentages are rounded so they add to exactly 100: the largest share absorbs
 * the rounding drift, because a bar whose key reads 33/33/33 under a full-width
 * bar is the kind of detail that makes a reader distrust the whole number.
 */
export function weightShares(stored: (number | null | undefined)[]): number[] {
  const multipliers = stored.map(multiplierForStored);
  const total = multipliers.reduce((sum, m) => sum + m, 0);
  if (total <= 0) return stored.map(() => 0);

  const raw = multipliers.map((m) => (m / total) * 100);
  const rounded = raw.map((v) => Math.round(v));
  const drift = 100 - rounded.reduce((sum, v) => sum + v, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] > raw[biggest]) biggest = i;
    }
    rounded[biggest] += drift;
  }
  return rounded;
}

/** True when every weight is the same stop — the "nothing to reset" state. */
export function weightsAreEqual(stored: (number | null | undefined)[]): boolean {
  if (stored.length === 0) return true;
  const first = stopForStored(stored[0]).stored;
  return stored.every((s) => stopForStored(s).stored === first);
}
