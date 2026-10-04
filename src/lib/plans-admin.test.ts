/**
 * Plans & Rates writes and reads against a fake database: plan writes go only
 * through set_company_plan and remove_company_plan, always with an actor, and
 * nothing writes the plan tables directly or touches the allowance functions.
 *
 *   node --test src/lib/plans-admin.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { call, fakeService } from "../test-support/fake-postgrest.mjs";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const { readPlansAdmin, removeCompanyPlan, saveCompanyPlan, savePricingSettings } = await import(
  "./plans-admin.ts"
);

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const COMPANY = "cccccccc-0000-4000-8000-000000000002";
const RAW = "duplicate key value violates unique constraint";
const ok = (data) => ({ data, error: null });

const PLAN = {
  planName: "Starter",
  cvScoringLimit: 300,
  asyncInterviewLimit: null,
  quotedPrice: 199,
  notes: "Annual",
};

const quiet = async (fn) => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) =>
    logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    return await fn(logged);
  } finally {
    console.error = orig;
  }
};

/** Every direct write verb the fake saw on a table. */
const directWrites = (service, table) =>
  service.queries
    .filter((q) => q.table === table)
    .flatMap((q) => q.calls.map((c) => c[0]))
    .filter((v) => ["insert", "update", "upsert", "delete"].includes(v));

/* ── saving a plan ──────────────────────────────────────────────── */

test("saving a plan calls set_company_plan with the actor, and writes the table no other way", async () => {
  const service = fakeService((key) => (key === "rpc:set_company_plan" ? ok({}) : ok(null)));
  const r = await saveCompanyPlan(service, ACTOR, COMPANY, PLAN);
  assert.deepEqual(r, { ok: true });
  assert.equal(service.rpcs.length, 1);
  assert.deepEqual(service.rpcs[0], {
    name: "set_company_plan",
    args: {
      p_company: COMPANY,
      p_actor: ACTOR,
      p_plan_name: "Starter",
      p_cv_scoring_limit: 300,
      p_async_interview_limit: null,
      p_live_minutes_limit: null,
      p_quoted_price: 199,
      p_currency: "USD",
      p_notes: "Annual",
    },
  });
  assert.deepEqual(directWrites(service, "company_plans"), []);
});

test("an existing live-minutes limit is passed back unchanged, since the form has no field for it", async () => {
  const service = fakeService((key) =>
    key === "company_plans" ? ok({ live_minutes_limit: 120 }) : ok({}),
  );
  await saveCompanyPlan(service, ACTOR, COMPANY, PLAN);
  assert.equal(service.rpcs[0].args.p_live_minutes_limit, 120);
});

test("no actor, no call: the database is never reached without someone to name", async () => {
  const service = fakeService(() => ok({}));
  for (const actor of ["", null, undefined]) {
    assert.equal((await saveCompanyPlan(service, actor, COMPANY, PLAN)).ok, false);
    assert.equal((await removeCompanyPlan(service, actor, COMPANY)).ok, false);
    assert.equal((await savePricingSettings(service, actor, {})).ok, false);
  }
  assert.equal(service.rpcs.length, 0);
  assert.equal(service.queries.length, 0);
});

test("a failed set_company_plan returns a fixed sentence and logs the raw error", async () => {
  const service = fakeService((key) =>
    key === "rpc:set_company_plan" ? { data: null, error: { message: RAW } } : ok(null),
  );
  await quiet(async (logged) => {
    const r = await saveCompanyPlan(service, ACTOR, COMPANY, PLAN);
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes(RAW), "raw database text reached the admin");
    assert.match(r.error, /Nothing was changed/);
    assert.ok(logged.some((l) => l.includes(RAW)));
  });
});

/* ── removing a plan ────────────────────────────────────────────── */

test("removing a plan calls remove_company_plan with the actor, and nothing else", async () => {
  const service = fakeService(() => ok(true));
  const r = await removeCompanyPlan(service, ACTOR, COMPANY);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(service.rpcs, [
    { name: "remove_company_plan", args: { p_company: COMPANY, p_actor: ACTOR } },
  ]);
  assert.equal(service.queries.length, 0, "no direct table access at all");
});

/* ── pricing settings ───────────────────────────────────────────── */

test("pricing settings update the one row, stamped with the actor", async () => {
  const service = fakeService(() => ok([{ id: "default" }]));
  const value = { cv_score_cost: 0.033, clients_sharing_fixed_cost: 10 };
  assert.deepEqual(await savePricingSettings(service, ACTOR, value), { ok: true });
  const q = service.queries.find((x) => x.table === "pricing_settings");
  assert.deepEqual(call(q.calls, "update"), ["update", { ...value, updated_by: ACTOR }]);
  assert.deepEqual(call(q.calls, "eq"), ["eq", "id", "default"]);
  assert.equal(service.rpcs.length, 0);
});

test("a pricing save that changes no row is a failure, not a silent success", async () => {
  const service = fakeService(() => ok([]));
  await quiet(async () => {
    const r = await savePricingSettings(service, ACTOR, { clients_sharing_fixed_cost: 1 });
    assert.equal(r.ok, false);
  });
});

/* ── reading ────────────────────────────────────────────────────── */

function world({ failing = null } = {}) {
  return fakeService((table, calls) => {
    if (failing === table) return { data: null, error: { message: RAW } };
    const range = call(calls, "range");
    if (range && range[1] > 0) return ok([]);
    switch (table) {
      case "companies":
        return ok([
          { id: COMPANY, name: "Acme", status: "active", is_internal: false },
          { id: "internal", name: "Remotiv", status: "active", is_internal: true },
        ]);
      case "company_plans":
        return ok([
          {
            company_id: COMPANY,
            plan_name: "Starter",
            cv_scoring_limit: 300,
            async_interview_limit: null,
            live_minutes_limit: null,
            quoted_price: "199.00",
            currency: "USD",
            notes: null,
          },
        ]);
      case "company_plan_history":
        // Already newest first, as the query orders it.
        return ok([
          {
            id: 2,
            company_id: COMPANY,
            operation: "UPDATE",
            snapshot: {
              plan_name: "Starter",
              cv_scoring_limit: 300,
              quoted_price: 199,
              currency: "USD",
            },
            changed_by: ACTOR,
            changed_at: "2026-10-04T10:00:00Z",
          },
          {
            id: 1,
            company_id: COMPANY,
            operation: "INSERT",
            snapshot: {
              plan_name: "Trial",
              cv_scoring_limit: 50,
              quoted_price: null,
              currency: "USD",
            },
            changed_by: null,
            changed_at: "2026-10-03T10:00:00Z",
          },
        ]);
      case "admin_users":
        return ok([{ user_id: ACTOR, full_name: "Waleed" }]);
      case "pricing_settings":
        return ok({
          cv_score_cost: "0.0330",
          clients_sharing_fixed_cost: 10,
          pkr_per_usd: null,
          minimum_price: "99.00",
          minimum_margin_pct: "60.00",
        });
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
}

test("the plans tab reads plans, history newest first with named actors, and rates", async () => {
  const service = world();
  const r = await readPlansAdmin(service);
  assert.equal(r.ok, true);
  const acme = r.companies.find((c) => c.id === COMPANY);
  assert.equal(acme.plan.planName, "Starter");
  assert.equal(acme.plan.quotedPrice, 199);
  assert.deepEqual(
    acme.history.map((h) => [h.id, h.operation, h.changedBy]),
    [
      [2, "UPDATE", "Waleed"],
      [1, "INSERT", "Unknown - a direct database edit"],
    ],
  );
  const hist = service.queries.find((q) => q.table === "company_plan_history");
  assert.deepEqual(call(hist.calls, "order"), ["order", "changed_at", { ascending: false }]);
  assert.equal(r.companies.find((c) => c.id === "internal").plan, null);
  assert.equal(r.rates.cvScoreCost, 0.033);
  assert.equal(r.rates.minimumMarginPct, 60);
  assert.equal(r.rates.pkrPerUsd, null);
});

test("a failed read on the plans tab yields categories and no data", async () => {
  await quiet(async (logged) => {
    for (const table of [
      "companies",
      "company_plans",
      "company_plan_history",
      "admin_users",
      "pricing_settings",
    ]) {
      const r = await readPlansAdmin(world({ failing: table }));
      assert.equal(r.ok, false, table);
      assert.equal("companies" in r, false);
      assert.ok(!JSON.stringify(r).includes(RAW), table);
    }
    assert.ok(logged.some((l) => l.includes(RAW)));
  });
});

/* ── the source: one door, an actor from the session, no enforcement ── */

const SRC = fileURLToPath(new URL("../", import.meta.url));
const code = (f) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });

test("only plans-admin.ts calls the plan functions, and nothing writes the plan tables directly", () => {
  const all = files(SRC);
  const callers = all
    .filter((f) => /set_company_plan|remove_company_plan/.test(code(f)))
    .map((f) => relative(SRC, f));
  assert.deepEqual(callers, ["lib/plans-admin.ts"]);
  for (const f of all) {
    const c = code(f);
    assert.doesNotMatch(
      c,
      /from\(\s*["'](company_plans|company_plan_history)["']\s*\)\s*\.(insert|update|upsert|delete)\(/,
      relative(SRC, f),
    );
  }
});

test("the actions take the actor from the server session, never from the browser", () => {
  const actions = code(join(SRC, "app/admin/companies/actions.ts"));
  for (const fn of [
    "savePricingSettingsAction",
    "saveCompanyPlanAction",
    "removeCompanyPlanAction",
  ]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}(`));
    const end = body.indexOf("\n}\n");
    const text = body.slice(0, end);
    assert.match(text, /const ctx = await requireSuperAdmin\(\);/, fn);
    assert.match(text, /ctx\.user\.id/, fn);
    // The signature carries no actor parameter for a caller to forge.
    assert.doesNotMatch(text.slice(0, text.indexOf("{")), /actor|userId/i, fn);
  }
});

test("nothing in this step calls the allowance functions", () => {
  const callers = files(SRC).filter((f) => /consume_allowance|release_allowance/.test(code(f)));
  assert.deepEqual(
    callers.map((f) => relative(SRC, f)),
    [],
  );
});
