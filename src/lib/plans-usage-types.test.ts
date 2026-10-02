/**
 * The Usage tab's pure rules: the billing month, the allowance labels, and the
 * cost text that must never turn an unknown into a zero.
 *
 *   node --test src/lib/plans-usage-types.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowanceState,
  costLine,
  costText,
  estimateCost,
  formatPkr,
  INTERNAL_LABEL,
  karachiMonthWindow,
  NO_PLAN_LABEL,
  NOT_CALCULATED_LABEL,
  PKR_RATE_NOT_SET,
  RATE_NOT_SET,
  TOTAL_UNAVAILABLE_LABEL,
  totalText,
} from "./plans-usage-types.ts";

/* ── the month boundary ─────────────────────────────────────────── */

test("the month turns at midnight in Karachi, not at midnight UTC", () => {
  // 19:00 UTC on 30 September is 00:00 on 1 October in Karachi (UTC+5).
  const october = karachiMonthWindow(new Date("2026-09-30T19:00:00.000Z"));
  assert.equal(october.startIso, "2026-09-30T19:00:00.000Z");
  assert.equal(october.endIso, "2026-10-31T19:00:00.000Z");
  assert.equal(october.label, "October 2026");

  // One second earlier is still September there, though UTC says the same day.
  const september = karachiMonthWindow(new Date("2026-09-30T18:59:59.000Z"));
  assert.equal(september.startIso, "2026-08-31T19:00:00.000Z");
  assert.equal(september.endIso, "2026-09-30T19:00:00.000Z");
  assert.equal(september.label, "September 2026");

  // The two windows meet exactly: end is exclusive, the next start inclusive.
  assert.equal(september.endIso, october.startIso);
});

test("an early-morning Karachi instant on the 1st is already the new month, though UTC is still the old one", () => {
  // 02:00 on 1 November in Karachi is 21:00 on 31 October in UTC.
  const w = karachiMonthWindow(new Date("2026-10-31T21:00:00.000Z"));
  assert.equal(w.label, "November 2026");
  assert.equal(w.startIso, "2026-10-31T19:00:00.000Z");
});

test("December rolls into January of the next year", () => {
  const w = karachiMonthWindow(new Date("2026-12-15T12:00:00.000Z"));
  assert.equal(w.startIso, "2026-11-30T19:00:00.000Z");
  assert.equal(w.endIso, "2026-12-31T19:00:00.000Z");
  const jan = karachiMonthWindow(new Date("2026-12-31T19:00:00.000Z"));
  assert.equal(jan.label, "January 2027");
});

/* ── allowances ─────────────────────────────────────────────────── */

test("a customer with no plan is flagged as no plan, unlimited", () => {
  const s = allowanceState({ isInternal: false, hasPlan: false, limit: null, used: 12 });
  assert.equal(s.kind, "no_plan");
  assert.equal(s.flagged, true);
  assert.equal(s.label, NO_PLAN_LABEL);
  assert.equal(NO_PLAN_LABEL, "No plan - unlimited");
});

test("an internal company is labelled exempt, never flagged, even with or without a plan", () => {
  for (const hasPlan of [false, true]) {
    const s = allowanceState({ isInternal: true, hasPlan, limit: hasPlan ? 5 : null, used: 50 });
    assert.equal(s.kind, "internal");
    assert.equal(s.flagged, false);
    assert.equal(s.label, INTERNAL_LABEL);
  }
  assert.equal(INTERNAL_LABEL, "Internal - exempt");
});

test("a plan with no limit for a metric is unlimited, not flagged; a limit shows used of limit", () => {
  assert.equal(
    allowanceState({ isInternal: false, hasPlan: true, limit: null, used: 3 }).kind,
    "unlimited",
  );
  const within = allowanceState({ isInternal: false, hasPlan: true, limit: 10, used: 3 });
  assert.deepEqual(within, { kind: "limit", label: "3 of 10", flagged: false, over: false });
  // Nothing enforces yet, so going over is possible and must be visible.
  const over = allowanceState({ isInternal: false, hasPlan: true, limit: 10, used: 12 });
  assert.equal(over.over, true);
  assert.equal(over.label, "12 of 10 - over");
});

/* ── unset rates are never zero ─────────────────────────────────── */

const RATES_UNSET = {
  cvScoreCost: null,
  asyncInterviewCost: null,
  liveMinuteCost: null,
  whatsappMessageCost: null,
  fixedMonthlyCost: null,
  clientsSharingFixedCost: 1,
  pkrPerUsd: null,
};
const usage = (over = {}) => ({
  companyId: "c1",
  name: "Acme",
  status: "active",
  isInternal: false,
  plan: null,
  cvScored: 0,
  asyncInvitations: 0,
  asyncCompleted: 0,
  liveInterviews: 0,
  whatsappDelivered: 0,
  ...over,
});

test("an unset rate reads 'rate not set', with or without usage, and never $0.00", () => {
  for (const count of [0, 7]) {
    const line = costLine(count, null);
    assert.deepEqual(line, { kind: "rate_not_set" });
    const text = costText(line, null);
    assert.equal(text.primary, RATE_NOT_SET);
    assert.equal(text.tone, "warn");
    assert.doesNotMatch(text.primary, /\$|0\.00/);
  }
});

test("a set rate gives an amount, and PKR beside it only when the exchange rate is set", () => {
  const line = costLine(4, 0.05);
  assert.deepEqual(costText(line, null), {
    primary: "$0.20",
    secondary: PKR_RATE_NOT_SET,
    tone: "amount",
  });
  assert.deepEqual(costText(line, 280), { primary: "$0.20", secondary: "PKR 56", tone: "amount" });
  assert.equal(formatPkr(1, null), PKR_RATE_NOT_SET);
});

test("live AI carries no cost estimate, even with a minute rate set, and says so rather than zero", () => {
  const e = estimateCost(usage({ liveInterviews: 2 }), { ...RATES_UNSET, liveMinuteCost: 1 });
  assert.deepEqual(e.live, { kind: "not_calculated" });
  assert.equal(costText(e.live, 280).primary, NOT_CALCULATED_LABEL);
  assert.equal(e.excludesLive, true);
  // Nothing about live interviews reaches the total or blocks it.
  assert.ok(!e.blockedBy.some((b) => /live/i.test(b)));
});

/* ── async: the allowance counts invitations, the cost counts completions ── */

test("async cost is completed interviews times the rate; invitations never enter it", () => {
  const rates = { ...RATES_UNSET, asyncInterviewCost: 0.5 };
  // Ten invitations, two completed: cost is 2 x 0.50, not 10 x 0.50.
  const e = estimateCost(
    usage({ isInternal: true, asyncInvitations: 10, asyncCompleted: 2 }),
    rates,
  );
  assert.deepEqual(e.asyncInterviews, { kind: "amount", usd: 1 });
  // Invitations alone cost nothing here, however many there are.
  const none = estimateCost(
    usage({ isInternal: true, asyncInvitations: 40, asyncCompleted: 0 }),
    rates,
  );
  assert.deepEqual(none.asyncInterviews, { kind: "amount", usd: 0 });
});

test("an unset async rate blocks the total only when an interview was completed", () => {
  const invitedOnly = estimateCost(usage({ isInternal: true, asyncInvitations: 5 }), RATES_UNSET);
  assert.equal(invitedOnly.totalUsd, 0);
  assert.ok(invitedOnly.unsetButUnused.includes("Async interview"));
  const completed = estimateCost(
    usage({ isInternal: true, asyncInvitations: 5, asyncCompleted: 1 }),
    RATES_UNSET,
  );
  assert.equal(completed.totalUsd, null);
  assert.deepEqual(completed.blockedBy, ["Async interview rate not set"]);
});

test("the total is withheld, with reasons, when a rate it needs is unset", () => {
  const e = estimateCost(usage({ cvScored: 5, whatsappDelivered: 3 }), RATES_UNSET);
  assert.equal(e.totalUsd, null);
  assert.deepEqual(e.blockedBy, [
    "CV scoring rate not set",
    "WhatsApp rate not set",
    "Fixed cost rate not set",
  ]);
  const t = totalText(e, null);
  assert.equal(t.primary, TOTAL_UNAVAILABLE_LABEL);
  assert.equal(t.tone, "warn");
});

test("a metric with no usage never blocks the total, since zero of anything is exactly zero", () => {
  const rates = {
    ...RATES_UNSET,
    cvScoreCost: 0.04,
    fixedMonthlyCost: 100,
    clientsSharingFixedCost: 4,
  };
  const e = estimateCost(usage({ cvScored: 10 }), rates);
  // 10 x 0.04 + 100 / 4 = 25.40; async and WhatsApp are unset but unused.
  assert.equal(e.totalUsd, 25.4);
  assert.deepEqual(costText(e.asyncInterviews, null).primary, RATE_NOT_SET);
  // Exact, and it says which unset rates it did not need.
  assert.deepEqual(totalText(e, 280), {
    primary: "$25.40",
    secondary: "PKR 7,112. Not set, and not needed this month: Async interview, WhatsApp.",
    tone: "amount",
  });
});

test("an internal company carries no fixed-cost share and is never blocked by the fixed rate", () => {
  const e = estimateCost(usage({ isInternal: true }), RATES_UNSET);
  assert.deepEqual(e.fixedAllocation, { kind: "not_allocated" });
  assert.equal(e.totalUsd, 0);
});

test("a $0.00 total beside unset rates says why it is zero, so it never reads as a zero rate", () => {
  // The live October case: an internal company, no usage yet, every rate unset.
  const t = totalText(estimateCost(usage({ isInternal: true }), RATES_UNSET), null);
  assert.equal(t.primary, "$0.00");
  assert.equal(
    t.secondary,
    "PKR rate not set. Not set, and not needed this month: CV scoring, Async interview, WhatsApp.",
  );
  // Once every rate is set, nothing is added.
  const all = {
    ...RATES_UNSET,
    cvScoreCost: 0.04,
    asyncInterviewCost: 0.5,
    whatsappMessageCost: 0.01,
    pkrPerUsd: 280,
  };
  assert.equal(totalText(estimateCost(usage({ isInternal: true }), all), 280).secondary, "PKR 0");
});
