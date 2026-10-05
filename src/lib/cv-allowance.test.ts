/**
 * The allowance module: reading consume_allowance's answer, giving a slot
 * back without ever throwing, and the advisory capacity the Re-score actions
 * read before queueing.
 *
 *   node --test src/lib/cv-allowance.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const { call, fakeService } = await import("../test-support/fake-postgrest.mjs");
const {
  consumeCvAllowance,
  RESCORE_NO_ALLOWANCE_MESSAGE,
  readCvCapacity,
  releaseCvAllowance,
  scoresToQueue,
  unscoredFirst,
} = await import("./cv-allowance.ts");
const { karachiMonthWindow } = await import("./plans-usage-types.ts");

for (const m of ["error", "warn"]) console[m] = () => {};

const rpcAnswer = (answer) => fakeService((name) => (name.startsWith("rpc:") ? answer : {}));

/* ── consume ────────────────────────────────────────────────────── */

test("a grant carries the usage id to release later", async () => {
  const service = rpcAnswer({
    data: [
      {
        allowed: true,
        unlimited: false,
        reason: "within_limit",
        used: 3,
        allowance: 5,
        usage_id: "u-1",
      },
    ],
    error: null,
  });
  assert.deepEqual(await consumeCvAllowance(service, "co", "app"), {
    allowed: true,
    usageId: "u-1",
    unlimited: false,
    reason: "within_limit",
  });
  assert.deepEqual(service.rpcs, [
    { name: "consume_allowance", args: { p_company: "co", p_metric: "cv_scored", p_ref: "app" } },
  ]);
});

test("a refusal is a decision, not an error", async () => {
  const service = rpcAnswer({
    data: [
      {
        allowed: false,
        unlimited: false,
        reason: "limit_reached",
        used: 5,
        allowance: 5,
        usage_id: null,
      },
    ],
    error: null,
  });
  assert.deepEqual(await consumeCvAllowance(service, "co", "app"), {
    allowed: false,
    used: 5,
    allowance: 5,
  });
});

test("no decision throws, with a fixed message: an error, no rows, or a grant without an id", async () => {
  for (const [label, answer] of [
    ["rpc error", { data: null, error: { message: "secret detail" } }],
    ["no rows", { data: [], error: null }],
    ["grant without id", { data: [{ allowed: true, usage_id: null }], error: null }],
  ]) {
    await assert.rejects(consumeCvAllowance(rpcAnswer(answer), "co", "app"), (err) => {
      assert.match(err.message, /^ai_cv_score: the scoring allowance /, label);
      assert.doesNotMatch(err.message, /secret detail/, label);
      return true;
    });
  }
});

/* ── release ────────────────────────────────────────────────────── */

test("release passes the id it was given, and never throws", async () => {
  const ok = rpcAnswer({ data: true, error: null });
  await releaseCvAllowance(ok, "u-9");
  assert.deepEqual(ok.rpcs, [{ name: "release_allowance", args: { p_usage_id: "u-9" } }]);

  await releaseCvAllowance(rpcAnswer({ data: null, error: { message: "x" } }), "u-9");
  await releaseCvAllowance(rpcAnswer({ data: false, error: null }), "u-9");
  const throwing = {
    rpc() {
      throw new Error("network");
    },
  };
  await releaseCvAllowance(throwing, "u-9");
});

/* ── advisory capacity ──────────────────────────────────────────── */

const NOW = new Date("2026-10-15T10:00:00Z");

function capacityService({ internal = false, plan = null, usage = [], fail = null } = {}) {
  return fakeService((table, calls) => {
    if (fail === table) return { data: null, error: { message: "down" } };
    if (table === "companies") return { data: { is_internal: internal }, error: null };
    if (table === "company_plans") return { data: plan, error: null };
    if (table === "usage_events") {
      const [, from, to] = call(calls, "range");
      return { data: usage.slice(from, to + 1), error: null };
    }
    return { data: null, error: null };
  });
}

test("internal, no plan and no CV limit are all unlimited, without counting usage", async () => {
  for (const [label, opts] of [
    ["internal", { internal: true, plan: { cv_scoring_limit: 5 } }],
    ["no plan", { plan: null }],
    ["plan without a CV limit", { plan: { cv_scoring_limit: null } }],
  ]) {
    const service = capacityService(opts);
    assert.deepEqual(await readCvCapacity(service, "co", NOW), { kind: "unlimited" }, label);
    assert.ok(!service.queries.some((q) => q.table === "usage_events"), label);
  }
});

test("a limit counts cv_scored quantity since the Karachi month began, with no upper bound", async () => {
  const service = capacityService({
    plan: { cv_scoring_limit: 10 },
    usage: [{ quantity: 1 }, { quantity: 1 }, { quantity: 2 }],
  });
  assert.deepEqual(await readCvCapacity(service, "co", NOW), {
    kind: "limited",
    limit: 10,
    used: 4,
    available: 6,
  });
  const usage = service.queries.find((q) => q.table === "usage_events").calls;
  assert.deepEqual(call(usage, "eq"), ["eq", "company_id", "co"]);
  assert.ok(usage.some((c) => c[0] === "eq" && c[1] === "type" && c[2] === "cv_scored"));
  assert.deepEqual(call(usage, "gte"), ["gte", "created_at", karachiMonthWindow(NOW).startIso]);
  assert.equal(call(usage, "lt"), undefined, "consume_allowance counts with no upper bound");
});

test("used at or over the limit leaves nothing available, never a negative", async () => {
  const at = capacityService({
    plan: { cv_scoring_limit: 2 },
    usage: [{ quantity: 1 }, { quantity: 1 }],
  });
  assert.equal((await readCvCapacity(at, "co", NOW)).available, 0);
  const over = capacityService({ plan: { cv_scoring_limit: 1 }, usage: [{ quantity: 3 }] });
  assert.equal((await readCvCapacity(over, "co", NOW)).available, 0);
  const zero = capacityService({ plan: { cv_scoring_limit: 0 } });
  assert.equal((await readCvCapacity(zero, "co", NOW)).available, 0);
});

test("a failed read is unknown, which holds nothing back: the worker decides", async () => {
  for (const table of ["companies", "company_plans", "usage_events"]) {
    const service = capacityService({ plan: { cv_scoring_limit: 5 }, fail: table });
    const capacity = await readCvCapacity(service, "co", NOW);
    assert.deepEqual(capacity, { kind: "unknown" }, table);
    assert.equal(scoresToQueue(capacity, 7), 7, table);
  }
});

test("how many to queue: all when unlimited or unknown, at most what is available otherwise", () => {
  assert.equal(scoresToQueue({ kind: "unlimited" }, 40), 40);
  assert.equal(scoresToQueue({ kind: "limited", limit: 10, used: 7, available: 3 }, 40), 3);
  assert.equal(scoresToQueue({ kind: "limited", limit: 10, used: 0, available: 10 }, 4), 4);
  assert.equal(scoresToQueue({ kind: "limited", limit: 10, used: 10, available: 0 }, 1), 0);
});

test("unscored applicants are queued first, each group keeping its order", () => {
  assert.deepEqual(unscoredFirst(["a", "b", "c", "d", "e"], new Set(["a", "c"])), [
    "b",
    "d",
    "e",
    "a",
    "c",
  ]);
  assert.deepEqual(unscoredFirst(["a", "b"], new Set()), ["a", "b"]);
});

test("the Re-score refusal is fixed copy with no em dash", () => {
  assert.equal(
    RESCORE_NO_ALLOWANCE_MESSAGE,
    "No AI scoring is left this month. Re-score once the monthly limit resets or the plan limit is raised.",
  );
  assert.doesNotMatch(RESCORE_NO_ALLOWANCE_MESSAGE, /—/);
});
