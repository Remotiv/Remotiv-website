/**
 * What each role receives from the server for each surface, run through the
 * real loaders against a database that honours filters.
 *
 *   node --test src/app/ai-dashboard/lib/company-usage-view.test.ts
 *
 * The company comes only from the (stubbed) session. The payload is what the
 * page renders from, so a field absent here is absent from the page.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";
import { call } from "../../../test-support/fake-postgrest.mjs";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/company-usage-test-hook.mjs", import.meta.url));

const { COMPANY, DB, OTHER, RAW_ERROR, usageWorld } = await import(
  "../../../test-support/company-usage-world.mjs"
);
const { loadApplicantsUsage, loadOverviewUsage, loadSettingsUsage } = await import(
  "./company-usage-view.ts"
);

/** Run a loader as `role` of `company`, at a fixed instant, against `service`. */
async function as(role, loader, { service = usageWorld(), company = COMPANY } = {}) {
  globalThis.__usageServiceForTests = () => service;
  globalThis.__usageCtxForTests = { companyId: company, role, memberId: "m-1" };
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T09:00:00.000Z") });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map((x) => JSON.stringify(x) ?? String(x)).join(" "));
  try {
    return { view: await loader(), service, logged };
  } finally {
    console.error = orig;
    mock.timers.reset();
    delete globalThis.__usageServiceForTests;
    delete globalThis.__usageCtxForTests;
  }
}

const CV = { metric: "cv_scored", used: 82, limit: 300, level: "ok" };
const INV = { metric: "interview_sent", used: 24, limit: 50, level: "ok" };

/* ── Settings card ──────────────────────────────────────────────── */

test("owner: the card with plan name, quoted price, usage and the Karachi reset date", async () => {
  const { view } = await as("owner", loadSettingsUsage);
  assert.deepEqual(view, {
    kind: "card",
    planName: "Growth",
    price: { amount: 199, currency: "USD" },
    metrics: [CV, INV],
    resetDate: "1 November 2026",
    warnings: [],
  });
});

test("admin: the same card, and quoted_price is absent from the server payload", async () => {
  const { view, service } = await as("admin", loadSettingsUsage);
  assert.deepEqual(view, {
    kind: "card",
    planName: "Growth",
    metrics: [CV, INV],
    resetDate: "1 November 2026",
    warnings: [],
  });
  assert.equal("price" in view, false);
  assert.doesNotMatch(JSON.stringify(view), /199|quoted|price/i);
  const plan = service.queries.find((q) => q.table === "company_plans");
  assert.doesNotMatch(call(plan.calls, "select")[1], /quoted_price/, "never even selected");
});

for (const role of ["recruiter", "hiring_manager"]) {
  test(`${role}: no Settings card, and nothing is read for it`, async () => {
    const { view, service } = await as(role, loadSettingsUsage);
    assert.equal(view, null);
    assert.equal(service.queries.length, 0);
  });
}

/* ── Overview meter ─────────────────────────────────────────────── */

test("owner and admin: the meter, linking to the card; recruiter: the meter, no link", async () => {
  for (const [role, linksToCard] of [
    ["owner", true],
    ["admin", true],
    ["recruiter", false],
  ]) {
    const { view } = await as(role, loadOverviewUsage);
    assert.deepEqual(view, { kind: "meter", metrics: [CV, INV], linksToCard }, role);
    assert.doesNotMatch(JSON.stringify(view), /Growth|199|price/, `${role}: usage only`);
  }
});

test("hiring manager: no meter, and nothing is read", async () => {
  const { view, service } = await as("hiring_manager", loadOverviewUsage);
  assert.equal(view, null);
  assert.equal(service.queries.length, 0);
});

/* ── Applicants banner ──────────────────────────────────────────── */

const atLimits = (cv, inv) => ({
  ...DB,
  company_plans: [{ ...DB.company_plans[0], cv_scoring_limit: cv, async_interview_limit: inv }],
});

for (const role of ["owner", "admin", "recruiter"]) {
  test(`${role}: a banner at 80%, a paused banner at 100%, nothing below 80%`, async () => {
    const below = await as(role, loadApplicantsUsage);
    assert.equal(below.view, null, "82/300 and 24/50 are below 80%");

    const warn = await as(role, loadApplicantsUsage, {
      service: usageWorld({ db: atLimits(100, 30) }),
    });
    assert.deepEqual(warn.view, {
      kind: "banner",
      warnings: [
        { metric: "cv_scored", level: "warn", text: "You've used 80% of this month's AI scoring." },
        {
          metric: "interview_sent",
          level: "warn",
          text: "You've used 80% of this month's async interview invitations.",
        },
      ],
    });

    const paused = await as(role, loadApplicantsUsage, {
      service: usageWorld({ db: atLimits(82, 0) }),
    });
    assert.deepEqual(paused.view, {
      kind: "banner",
      warnings: [
        {
          metric: "cv_scored",
          level: "paused",
          text: "AI scoring paused until 1 November 2026. Applications still arrive and can be reviewed by hand.",
        },
        {
          metric: "interview_sent",
          level: "paused",
          text: "Async interview invitations paused until 1 November 2026.",
        },
      ],
    });
    // Usage only: the banner carries no plan name and no price, whoever sees it.
    assert.doesNotMatch(JSON.stringify(paused.view), /Growth|199|price/);
  });
}

test("hiring manager: never an Applicants banner, even when paused, and nothing is read", async () => {
  const { view, service } = await as("hiring_manager", loadApplicantsUsage, {
    service: usageWorld({ db: atLimits(0, 0) }),
  });
  assert.equal(view, null);
  assert.equal(service.queries.length, 0);
});

/* ── no plan, internal ──────────────────────────────────────────── */

test("no plan: unlimited figures, no warnings, no banner", async () => {
  const db = { ...DB, company_plans: DB.company_plans.filter((p) => p.company_id !== COMPANY) };
  const card = await as("owner", loadSettingsUsage, { service: usageWorld({ db }) });
  assert.deepEqual(card.view, {
    kind: "card",
    planName: null,
    price: null,
    metrics: [
      { ...CV, limit: null, level: "unlimited" },
      { ...INV, limit: null, level: "unlimited" },
    ],
    resetDate: "1 November 2026",
    warnings: [],
  });
  const banner = await as("recruiter", loadApplicantsUsage, { service: usageWorld({ db }) });
  assert.equal(banner.view, null);
});

test("internal company: no card, no meter, no banner, for any role", async () => {
  const db = { ...atLimits(0, 0), companies: [{ id: COMPANY, is_internal: true }] };
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    for (const loader of [loadSettingsUsage, loadOverviewUsage, loadApplicantsUsage]) {
      const { view } = await as(role, loader, { service: usageWorld({ db }) });
      assert.equal(view, null, `${role} ${loader.name}`);
    }
  }
});

/* ── scoping ────────────────────────────────────────────────────── */

test("the company is the session's: no loader takes one, and an argument is ignored", async () => {
  for (const loader of [loadSettingsUsage, loadOverviewUsage, loadApplicantsUsage]) {
    assert.equal(loader.length, 0, `${loader.name} must take no parameters`);
  }
  // A browser cannot call these (they are not server actions), but even a
  // caller that passed another company's id gets the session's company.
  const service = usageWorld();
  globalThis.__usageServiceForTests = () => service;
  globalThis.__usageCtxForTests = { companyId: COMPANY, role: "owner", memberId: "m-1" };
  try {
    const view = await loadSettingsUsage(OTHER);
    assert.equal(view.planName, "Growth");
    assert.equal(view.metrics[0].used, 82);
  } finally {
    delete globalThis.__usageServiceForTests;
    delete globalThis.__usageCtxForTests;
  }
});

test("every query is filtered to the session's company, and another company's figures never appear", async () => {
  for (const [company, plan, cvUsed] of [
    [COMPANY, "Growth", 82],
    [OTHER, "Enterprise", 999],
  ]) {
    const { view, service } = await as("owner", loadSettingsUsage, { company });
    assert.equal(view.planName, plan);
    assert.equal(view.metrics[0].used, cvUsed);
    for (const q of service.queries) {
      const col = q.table === "companies" ? "id" : "company_id";
      assert.deepEqual(
        q.calls.find((c) => c[0] === "eq" && c[1] === col),
        ["eq", col, company],
        q.table,
      );
    }
  }
});

/* ── errors ─────────────────────────────────────────────────────── */

test("a failed read: the card and meter say only the fixed message's kind; the raw cause is logged", async () => {
  for (const loader of [loadSettingsUsage, loadOverviewUsage]) {
    const { view, logged } = await as("owner", loader, {
      service: usageWorld({ failing: "company_plans" }),
    });
    assert.deepEqual(view, { kind: "error" });
    assert.ok(!JSON.stringify(view).includes(RAW_ERROR));
    assert.ok(
      logged.some((l) => l.includes("permission denied")),
      "raw cause must be logged",
    );
  }
  const banner = await as("recruiter", loadApplicantsUsage, {
    service: usageWorld({ failing: "usage_events" }),
  });
  assert.equal(banner.view, null, "the banner stays silent on a failed read");
});
