/**
 * readCompanyUsage against a database that honours filters: the capped figures
 * come from the rows consume_allowance counts, in the same Karachi month, for
 * this company only; the price is read only on request; failures carry no
 * figures and no raw text.
 *
 *   node --test src/lib/company-usage.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call } from "../test-support/fake-postgrest.mjs";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const { COMPANY, DB, OTHER, RAW_ERROR, usageWorld } = await import(
  "../test-support/company-usage-world.mjs"
);
const { readCompanyUsage } = await import("./company-usage.ts");
const { allowanceResetDate, karachiMonthWindow } = await import("./plans-usage-types.ts");

const NOW = new Date("2026-10-15T09:00:00.000Z");
const usageQueries = (service) => service.queries.filter((q) => q.table === "usage_events");
const eqs = (q) => q.calls.filter((c) => c[0] === "eq").map((c) => c.slice(1));

test("AI scoring sums usage_events cv_scored; invitations sum usage_events interview_sent", async () => {
  const service = usageWorld();
  const r = await readCompanyUsage(service, COMPANY, { includePrice: false }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cv, { metric: "cv_scored", used: 82, limit: 300, level: "ok" });
  assert.deepEqual(r.interviews, { metric: "interview_sent", used: 24, limit: 50, level: "ok" });
  const types = usageQueries(service).map((q) => eqs(q).find(([col]) => col === "type")?.[1]);
  assert.deepEqual([...new Set(types)].sort(), ["cv_scored", "interview_sent"]);
  // No other table is a source for the capped figures.
  const tables = new Set(service.queries.map((q) => q.table));
  assert.deepEqual([...tables].sort(), ["companies", "company_plans", "usage_events"]);
});

test("both are counted from the Karachi month start, as consume_allowance counts, with no upper bound", async () => {
  const service = usageWorld();
  await readCompanyUsage(service, COMPANY, { includePrice: false }, NOW);
  const start = karachiMonthWindow(NOW).startIso;
  assert.equal(start, "2026-09-30T19:00:00.000Z");
  for (const q of usageQueries(service)) {
    assert.deepEqual(call(q.calls, "gte"), ["gte", "created_at", start]);
    assert.equal(call(q.calls, "lt"), undefined, "consume_allowance has no upper bound");
    assert.deepEqual(call(q.calls, "eq"), ["eq", "company_id", COMPANY]);
  }
});

test("the reset date is the shared helper's, the first of the next Karachi month", async () => {
  const late = new Date("2026-10-31T20:00:00.000Z"); // already 1 November in Karachi
  const r = await readCompanyUsage(usageWorld(), COMPANY, { includePrice: false }, late);
  assert.equal(r.resetDate, allowanceResetDate(late));
  assert.equal(r.resetDate, "1 December 2026");
  const mid = await readCompanyUsage(usageWorld(), COMPANY, { includePrice: false }, NOW);
  assert.equal(mid.resetDate, "1 November 2026");
});

test("another company's plan and usage never reach this company's figures", async () => {
  const r = await readCompanyUsage(usageWorld(), COMPANY, { includePrice: true }, NOW);
  assert.equal(r.plan.planName, "Growth");
  assert.deepEqual(r.plan.price, { amount: 199, currency: "USD" });
  assert.equal(r.cv.used, 82);
  const other = await readCompanyUsage(usageWorld(), OTHER, { includePrice: true }, NOW);
  assert.equal(other.plan.planName, "Enterprise");
  assert.equal(other.cv.used, 999);
});

test("the price is not even selected unless asked for", async () => {
  const service = usageWorld();
  const r = await readCompanyUsage(service, COMPANY, { includePrice: false }, NOW);
  assert.equal("price" in r.plan, false, "the key must be absent, not null");
  const plan = service.queries.find((q) => q.table === "company_plans");
  assert.doesNotMatch(call(plan.calls, "select")[1], /quoted_price|currency/);
  assert.doesNotMatch(JSON.stringify(r), /199/);
});

test("no plan: unlimited for both metrics, never a warning level", async () => {
  const db = { ...DB, company_plans: DB.company_plans.filter((p) => p.company_id !== COMPANY) };
  const r = await readCompanyUsage(usageWorld({ db }), COMPANY, { includePrice: true }, NOW);
  assert.equal(r.plan, null);
  assert.deepEqual(r.cv, { metric: "cv_scored", used: 82, limit: null, level: "unlimited" });
  assert.deepEqual(r.interviews, {
    metric: "interview_sent",
    used: 24,
    limit: null,
    level: "unlimited",
  });
});

test("an internal company is exempt: no plan or usage read at all", async () => {
  const db = { ...DB, companies: [{ id: COMPANY, is_internal: true }] };
  const service = usageWorld({ db });
  assert.deepEqual(await readCompanyUsage(service, COMPANY, { includePrice: true }, NOW), {
    ok: true,
    internal: true,
  });
  assert.deepEqual(
    service.queries.map((q) => q.table),
    ["companies"],
  );
});

test("a limit of 0 is paused, and 80% and 100% read as such", async () => {
  const withLimits = (cv, inv) => ({
    ...DB,
    company_plans: [{ ...DB.company_plans[0], cv_scoring_limit: cv, async_interview_limit: inv }],
  });
  const zero = await readCompanyUsage(
    usageWorld({ db: withLimits(0, 0) }),
    COMPANY,
    { includePrice: false },
    NOW,
  );
  assert.equal(zero.cv.level, "paused");
  assert.equal(zero.interviews.level, "paused");
  const edge = await readCompanyUsage(
    usageWorld({ db: withLimits(100, 24) }),
    COMPANY,
    { includePrice: false },
    NOW,
  );
  assert.equal(edge.cv.level, "warn", "82 of 100");
  assert.equal(edge.interviews.level, "paused", "24 of 24");
});

for (const table of ["companies", "company_plans", "usage_events"]) {
  test(`a failed ${table} read returns no figures, and the raw cause goes to the server log only`, async () => {
    const logged = [];
    const orig = console.error;
    console.error = (...a) => logged.push(a.map((x) => JSON.stringify(x) ?? String(x)).join(" "));
    try {
      const r = await readCompanyUsage(
        usageWorld({ failing: table }),
        COMPANY,
        { includePrice: true },
        NOW,
      );
      assert.deepEqual(r, { ok: false });
      assert.ok(
        logged.some((l) => l.includes("permission denied")),
        "raw cause must be logged",
      );
    } finally {
      console.error = orig;
    }
  });
}

test("the raw error text is never in what the reader returns", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await readCompanyUsage(
      usageWorld({ failing: "company_plans" }),
      COMPANY,
      { includePrice: true },
      NOW,
    );
    assert.ok(!JSON.stringify(r).includes(RAW_ERROR));
  } finally {
    console.error = orig;
  }
});

test("it only reads: no write and no function call", async () => {
  const service = usageWorld();
  await readCompanyUsage(service, COMPANY, { includePrice: true }, NOW);
  const verbs = service.queries.flatMap((q) => q.calls.map((c) => c[0]));
  for (const write of ["insert", "update", "upsert", "delete"])
    assert.ok(!verbs.includes(write), write);
  assert.equal(service.rpcs.length, 0);
});
