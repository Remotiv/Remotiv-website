/**
 * The client usage rules: thresholds, copy, and who sees which surface.
 *
 *   node --test src/lib/company-usage-types.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const {
  meterLine,
  metricUsage,
  NEED_MORE,
  quotaLevel,
  quotaWarning,
  quotaWarnings,
  UNLIMITED_THIS_MONTH,
  USAGE_LOAD_ERROR,
  usageSurfacesFor,
  usedOfLimit,
} = await import("./company-usage-types.ts");

/* ── thresholds ─────────────────────────────────────────────────── */

test("named cases: 80% warns, the limit pauses, 0 pauses at once, unlimited never warns", () => {
  const cases = [
    [0, 10, "ok"],
    [7, 10, "ok"],
    [8, 10, "warn"],
    [9, 10, "warn"],
    [10, 10, "paused"],
    [12, 10, "paused"],
    [3, 4, "ok"],
    [4, 5, "warn"],
    [159, 200, "ok"], // 79.5%: a rounded percentage would call this 80
    [160, 200, "warn"],
    [199, 200, "warn"],
    [200, 200, "paused"],
    [0, 0, "paused"],
    [5, 0, "paused"],
    [0, 1, "ok"],
    [1, 1, "paused"],
    [0, null, "unlimited"],
    [1_000_000, null, "unlimited"],
  ];
  for (const [used, limit, want] of cases) {
    assert.equal(quotaLevel(used, limit), want, `${used} / ${limit}`);
  }
});

test("every used/limit pair up to 400 matches the integer rule, with no fraction compared", () => {
  for (let limit = 0; limit <= 400; limit++) {
    for (let used = 0; used <= limit + 2; used++) {
      const want = used >= limit ? "paused" : used * 100 >= limit * 80 ? "warn" : "ok";
      assert.equal(quotaLevel(used, limit), want, `${used} / ${limit}`);
    }
  }
});

/* ── copy ───────────────────────────────────────────────────────── */

test("the four warnings, word for word, and none below 80% or without a limit", () => {
  const at = (metric, used, limit) =>
    quotaWarning(metricUsage(metric, used, limit), "1 November 2026");
  assert.equal(at("cv_scored", 80, 100), "You've used 80% of this month's AI scoring.");
  assert.equal(
    at("cv_scored", 100, 100),
    "AI scoring paused until 1 November 2026. Applications still arrive and can be reviewed by hand.",
  );
  assert.equal(
    at("interview_sent", 40, 50),
    "You've used 80% of this month's async interview invitations.",
  );
  assert.equal(
    at("interview_sent", 50, 50),
    "Async interview invitations paused until 1 November 2026.",
  );
  assert.equal(
    at("interview_sent", 0, 0),
    "Async interview invitations paused until 1 November 2026.",
  );
  assert.equal(at("cv_scored", 79, 100), null);
  assert.equal(at("cv_scored", 5000, null), null);
  assert.deepEqual(
    quotaWarnings(
      [metricUsage("cv_scored", 5000, null), metricUsage("interview_sent", 3, null)],
      "1 November 2026",
    ),
    [],
  );
});

test("meter lines and card figures, limited and unlimited", () => {
  assert.equal(meterLine(metricUsage("cv_scored", 82, 300)), "82 / 300 AI-scored applicants");
  assert.equal(
    meterLine(metricUsage("interview_sent", 24, 50)),
    "24 / 50 async interview invitations",
  );
  assert.equal(usedOfLimit(metricUsage("cv_scored", 12, null)), "12 / Unlimited");
  assert.equal(UNLIMITED_THIS_MONTH, "Unlimited this month");
  assert.equal(NEED_MORE, "Need more? Contact your Remotiv account manager.");
  assert.equal(USAGE_LOAD_ERROR, "Usage couldn't be loaded.");
});

/* ── who sees what ──────────────────────────────────────────────── */

test("owner: card, price, meter, banner; admin: card, meter, banner; recruiter: meter, banner; hiring manager: nothing", () => {
  assert.deepEqual(usageSurfacesFor("owner"), {
    settingsCard: true,
    price: true,
    overviewMeter: true,
    applicantsBanner: true,
  });
  assert.deepEqual(usageSurfacesFor("admin"), {
    settingsCard: true,
    price: false,
    overviewMeter: true,
    applicantsBanner: true,
  });
  assert.deepEqual(usageSurfacesFor("recruiter"), {
    settingsCard: false,
    price: false,
    overviewMeter: true,
    applicantsBanner: true,
  });
  assert.deepEqual(usageSurfacesFor("hiring_manager"), {
    settingsCard: false,
    price: false,
    overviewMeter: false,
    applicantsBanner: false,
  });
});
