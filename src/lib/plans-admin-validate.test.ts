/**
 * The Plans & Rates form rules: blank limits mean unlimited, blank rates mean
 * not set, and nothing malformed reaches the database.
 *
 *   node --test src/lib/plans-admin-validate.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUuid,
  parseOptionalLimit,
  parseOptionalMoney,
  SUGGESTED_PRICING,
  validateCompanyPlan,
  validatePricingSettings,
} from "./plans-admin-validate.ts";

/* ── limits ─────────────────────────────────────────────────────── */

test("a blank limit is unlimited (null), never zero", () => {
  for (const raw of ["", "   ", undefined]) {
    assert.deepEqual(parseOptionalLimit(raw), { ok: true, value: null });
  }
  // Zero is a real value: none allowed.
  assert.deepEqual(parseOptionalLimit("0"), { ok: true, value: 0 });
  assert.deepEqual(parseOptionalLimit("1,000"), { ok: true, value: 1000 });
});

test("a limit must be a whole, non-negative number", () => {
  for (const raw of ["-1", "2.5", "ten", "1e3", "+5"]) {
    assert.equal(parseOptionalLimit(raw).ok, false, raw);
  }
});

/* ── money ──────────────────────────────────────────────────────── */

test("money is a plain non-negative number within its decimal places; blank is not set", () => {
  assert.deepEqual(parseOptionalMoney("", 4), { ok: true, value: null });
  assert.deepEqual(parseOptionalMoney("0.033", 4), { ok: true, value: 0.033 });
  assert.deepEqual(parseOptionalMoney(".5", 2), { ok: true, value: 0.5 });
  assert.equal(parseOptionalMoney("0.12345", 4).ok, false);
  assert.equal(parseOptionalMoney("199.999", 2).ok, false);
  for (const raw of ["-1", "abc", "1e2", "$5"]) {
    assert.equal(parseOptionalMoney(raw, 2).ok, false, raw);
  }
});

/* ── pricing settings ───────────────────────────────────────────── */

test("the suggested values pass validation and parse to the brief's numbers", () => {
  const r = validatePricingSettings(SUGGESTED_PRICING);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    cv_score_cost: 0.033,
    async_interview_cost: 0.09,
    whatsapp_message_cost: 0.015,
    fixed_monthly_cost: 45,
    pkr_per_usd: 277,
    clients_sharing_fixed_cost: 10,
    minimum_price: 99,
    minimum_margin_pct: 60,
  });
});

test("blank rates save as not set (null); clients sharing defaults nowhere and must be given", () => {
  const r = validatePricingSettings({ clients_sharing_fixed_cost: "1" });
  assert.equal(r.ok, true);
  assert.equal(r.value.cv_score_cost, null);
  assert.equal(r.value.pkr_per_usd, null);
  assert.equal(r.value.minimum_margin_pct, null);
  assert.equal(validatePricingSettings({}).ok, false);
});

test("the margin must be below 100, the exchange rate above zero, clients a whole number of at least 1", () => {
  const bad = validatePricingSettings({
    ...SUGGESTED_PRICING,
    minimum_margin_pct: "100",
    pkr_per_usd: "0",
    clients_sharing_fixed_cost: "0",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.minimum_margin_pct);
  assert.ok(bad.errors.pkr_per_usd);
  assert.ok(bad.errors.clients_sharing_fixed_cost);
  assert.equal(
    validatePricingSettings({ ...SUGGESTED_PRICING, clients_sharing_fixed_cost: "2.5" }).ok,
    false,
  );
  assert.equal(
    validatePricingSettings({ ...SUGGESTED_PRICING, minimum_margin_pct: "99.99" }).ok,
    true,
  );
});

/* ── company plans ──────────────────────────────────────────────── */

test("a plan with blank limits is unlimited on both, and a blank name saves as Custom", () => {
  const r = validateCompanyPlan({ planName: "  ", cvScoringLimit: "", asyncInterviewLimit: "" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    planName: "Custom",
    cvScoringLimit: null,
    asyncInterviewLimit: null,
    quotedPrice: null,
    notes: null,
  });
});

test("a full plan parses; bad limits, prices and overlong text are refused with field errors", () => {
  const ok = validateCompanyPlan({
    planName: "Starter",
    cvScoringLimit: "300",
    asyncInterviewLimit: "30",
    quotedPrice: "199",
    notes: " Annual ",
  });
  assert.deepEqual(ok.value, {
    planName: "Starter",
    cvScoringLimit: 300,
    asyncInterviewLimit: 30,
    quotedPrice: 199,
    notes: "Annual",
  });
  const bad = validateCompanyPlan({
    planName: "x".repeat(81),
    cvScoringLimit: "-3",
    asyncInterviewLimit: "1.5",
    quotedPrice: "abc",
    notes: "y".repeat(2001),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), [
    "asyncInterviewLimit",
    "cvScoringLimit",
    "notes",
    "planName",
    "quotedPrice",
  ]);
});

test("only a uuid-shaped company id is accepted", () => {
  assert.equal(isUuid("7aad434d-0000-4000-8000-000000000000"), true);
  for (const v of ["", "7aad434d", "'; drop table x;--", null, 42]) {
    assert.equal(isUuid(v), false, String(v));
  }
});
