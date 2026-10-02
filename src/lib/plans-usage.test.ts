/**
 * readPlansUsage against a fake database: what it counts, the month it counts
 * in, that it only reads, and that a failed read yields no numbers at all.
 *
 *   node --test src/lib/plans-usage.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../test-support/fake-postgrest.mjs";

// Node calls the most recently registered hook first: the stub must see the
// bare `server-only` before node-resolve rewrites `@/` paths.
register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const { readPlansUsage } = await import("./plans-usage.ts");

const NOW = new Date("2026-10-15T09:00:00.000Z");
const START = "2026-09-30T19:00:00.000Z";
const END = "2026-10-31T19:00:00.000Z";

const ok = (data) => ({ data, error: null });
const RAW = "permission denied for table usage_events";

const SETTINGS = {
  cv_score_cost: "0.0400",
  async_interview_cost: null,
  live_minute_cost: null,
  whatsapp_message_cost: null,
  fixed_monthly_cost: null,
  clients_sharing_fixed_cost: 1,
  pkr_per_usd: null,
};

/** A small world: one internal company, one customer with a plan, one without. */
/**
 * Which query this is. interview_sessions is read twice: invitations by
 * created_at, and completions by status and submitted_at.
 */
function queryName(table, calls) {
  const completions = calls.some((c) => c[0] === "eq" && c[1] === "status" && c[2] === "submitted");
  return table === "interview_sessions" && completions ? "interview_completions" : table;
}

function world({ failing = null } = {}) {
  return fakeService((table, calls) => {
    if (failing === queryName(table, calls)) return { data: null, error: { message: RAW } };
    // pageAll asks for 0-999 first; a short page ends it.
    const range = call(calls, "range");
    if (range && range[1] > 0) return ok([]);
    switch (table) {
      case "companies":
        return ok([
          { id: "acme", name: "Acme", status: "active", is_internal: false },
          { id: "beta", name: "Beta", status: "active", is_internal: false },
          { id: "remotiv", name: "Remotiv", status: "active", is_internal: true },
        ]);
      case "company_plans":
        return ok([
          {
            company_id: "beta",
            plan_name: "Starter",
            cv_scoring_limit: 100,
            async_interview_limit: null,
            live_minutes_limit: null,
            quoted_price: "199.00",
            currency: "USD",
          },
        ]);
      case "pricing_settings":
        return ok(SETTINGS);
      case "usage_events":
        return ok([
          { company_id: "acme", quantity: 1 },
          { company_id: "acme", quantity: 1 },
          { company_id: "beta", quantity: 3 },
          { company_id: null, quantity: 1 },
        ]);
      case "interview_sessions":
        // Completions: one by acme this month; Remotiv-owned rows have no company.
        if (queryName(table, calls) === "interview_completions") {
          return ok([{ company_id: "acme" }, { company_id: null }]);
        }
        return ok([
          { company_id: "acme", kind: "async" },
          { company_id: "acme", kind: "async" },
          { company_id: "acme", kind: "live" },
          { company_id: "remotiv", kind: "async" },
        ]);
      case "communication_logs":
        return ok([{ company_id: "beta" }, { company_id: "beta" }]);
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
}

const quiet = async (fn) => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) =>
    logged.push(a.map((x) => (x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
  try {
    return await fn(logged);
  } finally {
    console.error = orig;
  }
};

test("counts each metric per company, with plans and rates attached", async () => {
  const r = await readPlansUsage(world(), NOW);
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.companies.map((c) => [c.companyId, c]));
  assert.deepEqual(
    [by.acme.cvScored, by.acme.asyncInvitations, by.acme.liveInterviews, by.acme.whatsappDelivered],
    [2, 2, 1, 0],
  );
  assert.equal(by.beta.cvScored, 3, "quantity is summed, not rows counted");
  assert.equal(by.beta.whatsappDelivered, 2);
  assert.equal(by.remotiv.asyncInvitations, 1);
  // Completions come from their own query, not from the invitations.
  assert.equal(by.acme.asyncCompleted, 1);
  assert.equal(by.remotiv.asyncCompleted, 0);
  assert.equal(by.beta.asyncCompleted, 0);
  assert.equal(by.remotiv.isInternal, true);
  assert.equal(by.acme.plan, null);
  assert.equal(by.beta.plan.cvScoringLimit, 100);
  assert.equal(by.beta.plan.quotedPrice, 199);
  // numeric arrives as a string and is read as a number; NULL stays NULL.
  assert.equal(r.rates.cvScoreCost, 0.04);
  assert.equal(r.rates.asyncInterviewCost, null);
  assert.equal(r.rates.pkrPerUsd, null);
});

test("every usage read is bounded to this Karachi calendar month", async () => {
  const service = world();
  const r = await readPlansUsage(service, NOW);
  assert.equal(r.window.startIso, START);
  assert.equal(r.window.endIso, END);
  for (const table of ["usage_events", "interview_sessions", "communication_logs"]) {
    const q = service.queries.find((x) => queryName(x.table, x.calls) === table);
    assert.deepEqual(call(q.calls, "gte"), ["gte", "created_at", START], table);
    assert.deepEqual(call(q.calls, "lt"), ["lt", "created_at", END], table);
  }
  // Completions are bounded by when the candidate submitted, not when invited.
  const done = service.queries.find((x) => queryName(x.table, x.calls) === "interview_completions");
  const doneEq = done.calls.filter((c) => c[0] === "eq");
  assert.deepEqual(doneEq, [
    ["eq", "kind", "async"],
    ["eq", "status", "submitted"],
  ]);
  assert.deepEqual(call(done.calls, "gte"), ["gte", "submitted_at", START]);
  assert.deepEqual(call(done.calls, "lt"), ["lt", "submitted_at", END]);
  const usage = service.queries.find((x) => x.table === "usage_events");
  assert.deepEqual(call(usage.calls, "eq"), ["eq", "type", "cv_scored"]);
  const wa = service.queries.find((x) => x.table === "communication_logs");
  assert.deepEqual(call(wa.calls, "in"), ["in", "status", ["delivered", "read"]]);
});

test("it only reads: no insert, update, upsert, delete or function call reaches the database", async () => {
  const service = world();
  await readPlansUsage(service, NOW);
  const verbs = service.queries.flatMap((q) => q.calls.map((c) => c[0]));
  for (const write of ["insert", "update", "upsert", "delete", "rpc"]) {
    assert.ok(!verbs.includes(write), `${write} was called`);
  }
});

for (const table of [
  "companies",
  "company_plans",
  "pricing_settings",
  "usage_events",
  "interview_sessions",
  "interview_completions",
  "communication_logs",
]) {
  test(`a failed ${table} read returns no numbers, a category, and the raw cause in the log only`, async () => {
    await quiet(async (logged) => {
      const r = await readPlansUsage(world({ failing: table }), NOW);
      assert.equal(r.ok, false);
      assert.equal(r.readErrors.length, 1);
      assert.equal("companies" in r, false, "no partial figures alongside an error");
      assert.ok(!JSON.stringify(r).includes(RAW), "raw database text reached the result");
      assert.ok(
        logged.some((l) => l.includes(RAW)),
        "raw cause must reach the server log",
      );
    });
  });
}

test("a missing pricing_settings row is reported, not treated as every rate unset", async () => {
  const service = fakeService((table) => (table === "pricing_settings" ? ok(null) : ok([])));
  await quiet(async () => {
    const r = await readPlansUsage(service, NOW);
    assert.equal(r.ok, false);
    assert.deepEqual(r.readErrors, [{ source: "pricing settings" }]);
  });
});

/* ── the page wiring ────────────────────────────────────────────── */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the panel costs async on completions and never sets live interviews against minutes", () => {
  const panel = src("../app/admin/companies/_usage-panel.tsx");
  // Invitations carry the allowance and say where their cost appears instead.
  assert.match(
    panel,
    /Async interview invitations\s*<\/th>\s*<td className=\{CELL\}>\{usage\.asyncInvitations\}<\/td>\s*<td className=\{CELL\}>\s*<Allowance state=\{asyncAllowance\} \/>\s*<\/td>\s*<td className=\{CELL\}>\s*<Muted>Costed on completion<\/Muted>/,
  );
  // The async cost sits on the completed row.
  assert.match(
    panel,
    /Completed async interviews\s*<\/th>\s*<td className=\{CELL\}>\{usage\.asyncCompleted\}<\/td>[\s\S]*?costText\(estimate\.asyncInterviews/,
  );
  // Live: a count, "Not enforced yet", "Not tracked yet" for minutes, and the
  // plan's minutes allowance is not read anywhere in the panel.
  assert.match(panel, /<Muted>\{NOT_ENFORCED_YET\}<\/Muted>/);
  assert.match(
    panel,
    /Live minutes\s*<\/th>\s*<td className=\{CELL\}>\s*<Muted>\{NOT_TRACKED_YET\}<\/Muted>/,
  );
  assert.doesNotMatch(panel, /liveMinutesLimit/);
});

test("the Usage tab is super-admin only, read-only, and says so when it cannot load", () => {
  const actions = src("../app/admin/companies/actions.ts");
  assert.match(
    actions,
    /export async function fetchPlansUsage\(\): Promise<PlansUsageResult> \{\n {2}await requireSuperAdmin\(\);\n {2}return readPlansUsage\(createServiceClient\(\)\);/,
  );
  const panel = src("../app/admin/companies/_usage-panel.tsx");
  assert.match(panel, /Usage could not be loaded\./);
  assert.match(panel, /role="alert"/);
  // Categories only; a raw message field is never rendered.
  assert.match(panel, /result\.readErrors\.map\(\(e\) => e\.source\)/);
  assert.doesNotMatch(panel, /\.message\b/);
  // No form, no button, no server action: nothing on the tab can write.
  assert.doesNotMatch(panel, /<form|<button|"use client"|onClick/);
  const page = src("../app/admin/companies/page.tsx");
  assert.match(page, /if \(tab === "usage"\) \{\n {4}const usage = await fetchPlansUsage\(\);/);
});

test("the reader never touches the allowance functions or a scoring path", () => {
  // Code only: the module's doc comment names these functions to say it never calls them.
  const reader = src("./plans-usage.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(reader, /readPlansUsage/, "comment stripping left the code");
  assert.doesNotMatch(
    reader,
    /consume_allowance|release_allowance|set_company_plan|remove_company_plan/,
  );
  assert.doesNotMatch(reader, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(reader, /cv-scoring|requestCvScore|jobs-queue/);
});
