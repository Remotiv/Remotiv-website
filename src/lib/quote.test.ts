/**
 * The Quote Builder's arithmetic: cost, floor price, profit, margin, verdict,
 * and that an unknown is never quoted as a zero.
 *
 *   node --test src/lib/quote.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeQuote, VERDICT_LABEL } from "./quote.ts";

/** The suggested starting values from the brief. */
const RATES = {
  cvScoreCost: 0.033,
  asyncInterviewCost: 0.09,
  liveMinuteCost: null,
  whatsappMessageCost: 0.015,
  fixedMonthlyCost: 45,
  clientsSharingFixedCost: 10,
  pkrPerUsd: 277,
  minimumPrice: 99,
  minimumMarginPct: 60,
};

const NORMAL = { applicants: 300, asyncInterviews: 30, whatsappMessages: 100 };
const HEAVY = { applicants: 1000, asyncInterviews: 100, whatsappMessages: 300 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/* ── cost and floor ─────────────────────────────────────────────── */

test("cost is each volume times its rate, plus the fixed cost divided across clients", () => {
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: null });
  close(q.lines.cv, 9.9); // 300 x 0.033
  close(q.lines.asyncInterviews, 2.7); // 30 x 0.09
  close(q.lines.whatsapp, 1.5); // 100 x 0.015
  close(q.lines.fixedShare, 4.5); // 45 / 10
  close(q.costUsd, 18.6);
  assert.deepEqual(q.blockedBy, []);
});

test("the floor is the minimum price when cost / (1 - margin) is lower", () => {
  // 18.60 / 0.40 = 46.50, below the 99 minimum.
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: null });
  assert.equal(q.floorUsd, 99);
});

test("the floor is cost / (1 - margin) when that is higher than the minimum price", () => {
  // 33 + 9 + 4.5 + 4.5 = 51; 51 / 0.40 = 127.50, above the 99 minimum.
  const q = computeQuote(RATES, { ...HEAVY, quotedPrice: null });
  close(q.costUsd, 51);
  close(q.floorUsd, 127.5);
});

/* ── profit, margin, verdict ────────────────────────────────────── */

test("profit is price minus cost, and margin is profit as a share of price", () => {
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: 120 });
  close(q.profitUsd, 101.4); // 120 - 18.60
  close(q.marginPct, 84.5); // 101.40 / 120
  assert.equal(q.verdict, "healthy");
  assert.equal(VERDICT_LABEL[q.verdict], "Healthy");
});

test("a price under the floor is Below floor, even when it still makes a profit", () => {
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: 90 });
  assert.ok(q.profitUsd > 0, "profitable");
  assert.equal(q.verdict, "below_floor");
  assert.equal(VERDICT_LABEL[q.verdict], "Below floor");
});

test("a price equal to the floor is Healthy, a cent under is Below floor", () => {
  assert.equal(computeQuote(RATES, { ...HEAVY, quotedPrice: 127.5 }).verdict, "healthy");
  assert.equal(computeQuote(RATES, { ...HEAVY, quotedPrice: 127.49 }).verdict, "below_floor");
});

test("the verdict compares at cent precision, so floating-point dust cannot fail a fair price", () => {
  // 0.1 + 0.2 = 0.30000000000000004, and / 0.4 = 0.7500000000000001. A raw
  // comparison would call 0.75 below that floor; at cents it equals it.
  const dusty = {
    ...RATES,
    cvScoreCost: 0.1,
    whatsappMessageCost: 0.2,
    fixedMonthlyCost: 0,
    clientsSharingFixedCost: 1,
    minimumPrice: 0,
  };
  const volumes = { applicants: 1, asyncInterviews: 0, whatsappMessages: 1 };
  const q = computeQuote(dusty, { ...volumes, quotedPrice: 0.75 });
  assert.ok(0.75 < q.floorUsd, "the raw floor really is above 0.75, or this test proves nothing");
  assert.equal(q.verdict, "healthy");
  assert.equal(computeQuote(dusty, { ...volumes, quotedPrice: 0.74 }).verdict, "below_floor");
});

test("a loss-making price has negative profit and margin", () => {
  const q = computeQuote(RATES, { ...HEAVY, quotedPrice: 40 });
  close(q.profitUsd, -11);
  close(q.marginPct, -27.5);
  assert.equal(q.verdict, "below_floor");
});

test("no quoted price leaves profit, margin and verdict empty, not zero", () => {
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: null });
  assert.equal(q.profitUsd, null);
  assert.equal(q.marginPct, null);
  assert.equal(q.verdict, null);
});

test("a quoted price of zero has no margin, and is below any floor", () => {
  const q = computeQuote(RATES, { ...NORMAL, quotedPrice: 0 });
  assert.equal(q.marginPct, null);
  assert.equal(q.verdict, "below_floor");
});

/* ── unknowns are never zero ────────────────────────────────────── */

test("a needed rate that is unset withholds the cost, floor and verdict, and says which", () => {
  const q = computeQuote({ ...RATES, cvScoreCost: null }, { ...NORMAL, quotedPrice: 120 });
  assert.equal(q.lines.cv, null);
  assert.equal(q.costUsd, null);
  assert.equal(q.floorUsd, null);
  assert.equal(q.profitUsd, null);
  assert.equal(q.verdict, null);
  assert.deepEqual(q.blockedBy, ["CV scoring rate not set"]);
});

test("an unset rate with no volume against it blocks nothing", () => {
  const q = computeQuote(
    { ...RATES, whatsappMessageCost: null },
    { ...NORMAL, whatsappMessages: 0, quotedPrice: 120 },
  );
  assert.equal(q.lines.whatsapp, 0);
  close(q.costUsd, 17.1);
  assert.deepEqual(q.blockedBy, []);
});

test("the fixed cost is always needed, since every customer carries a share", () => {
  const q = computeQuote(
    { ...RATES, fixedMonthlyCost: null },
    { applicants: 0, asyncInterviews: 0, whatsappMessages: 0, quotedPrice: 99 },
  );
  assert.equal(q.costUsd, null);
  assert.deepEqual(q.blockedBy, ["Fixed cost rate not set"]);
});

test("an unset minimum price or margin withholds the floor and verdict, but not the cost", () => {
  const noPrice = computeQuote({ ...RATES, minimumPrice: null }, { ...NORMAL, quotedPrice: 120 });
  close(noPrice.costUsd, 18.6);
  assert.equal(noPrice.floorUsd, null);
  assert.equal(noPrice.verdict, null);
  close(noPrice.profitUsd, 101.4);
  assert.deepEqual(noPrice.blockedBy, ["Minimum price not set"]);
  const noMargin = computeQuote(
    { ...RATES, minimumMarginPct: null },
    { ...NORMAL, quotedPrice: 120 },
  );
  assert.equal(noMargin.floorUsd, null);
  assert.deepEqual(noMargin.blockedBy, ["Minimum margin not set"]);
});

test("a minimum margin of 100% or more has no floor, and says so", () => {
  const q = computeQuote({ ...RATES, minimumMarginPct: 100 }, { ...NORMAL, quotedPrice: 120 });
  assert.equal(q.floorUsd, null);
  assert.deepEqual(q.blockedBy, ["Minimum margin must be below 100%"]);
});

/* ── live AI is not part of the quote yet ───────────────────────── */

test("live AI is not an input: nothing in the arithmetic or the builder reads it, and nothing blocks on it", () => {
  // Code only: the module's doc comment explains why live AI is absent.
  const code = (rel) =>
    readFileSync(new URL(rel, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const arithmetic = code("./quote.ts");
  assert.match(arithmetic, /export function computeQuote/, "comment stripping left the code");
  assert.doesNotMatch(arithmetic, /live/i);
  const builder = code("../app/admin/companies/_quote-builder.tsx");
  assert.doesNotMatch(builder, /liveInterviews|Live AI/);
  // A live minute rate, even if one were set, changes nothing.
  const q = computeQuote({ ...RATES, liveMinuteCost: 1 }, { ...NORMAL, quotedPrice: 120 });
  assert.equal(q.verdict, "healthy");
  assert.ok(!q.blockedBy.some((b) => /live/i.test(b)));
});
