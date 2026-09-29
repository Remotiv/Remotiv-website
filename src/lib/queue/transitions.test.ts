/**
 * The row patches for failure, reclaim and yield (Phase 5, P2/P13).
 *
 *   node --test src/lib/queue/transitions.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
const { TerminalJobError } = await import("./failure-class.ts");
const { backoffMs, planFailure, planReclaim, planYield } = await import("./transitions.ts");

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const noJitter = () => 0.5;

test("an ordinary failure climbs the ladder with backoff and dies at max_attempts", () => {
  const first = planFailure(
    { attempts: 0, max_attempts: 3 },
    new Error("503 overloaded"),
    NOW,
    noJitter,
  );
  assert.equal(first.status, "queued");
  assert.equal(first.attempts, 1);
  assert.equal(Date.parse(first.run_after) - NOW, backoffMs(1, noJitter));
  assert.equal(first.last_error, "503 overloaded");

  const last = planFailure({ attempts: 2, max_attempts: 3 }, new Error("503 again"), NOW, noJitter);
  assert.equal(last.status, "dead");
  assert.equal(last.attempts, 3);
  assert.equal("run_after" in last, false);
});

test("a TerminalJobError is dead on the FIRST attempt with its class in last_error", () => {
  const plan = planFailure(
    { attempts: 0, max_attempts: 3 },
    new TerminalJobError("billing", "provider 400: credit balance is too low"),
    NOW,
  );
  assert.equal(plan.status, "dead");
  assert.equal(plan.attempts, 1);
  assert.equal(plan.last_error, "terminal(billing): provider 400: credit balance is too low");
  assert.equal(plan.locked_by, null);
});

test("a reclaim counts an attempt, requeues immediately, and buries at max", () => {
  const row = {
    attempts: 0,
    max_attempts: 3,
    locked_at: new Date(NOW - 6 * 60_000).toISOString(),
    locked_by: "worker-abc",
    type: "ai_scorecard",
  };
  const first = planReclaim(row, NOW);
  assert.equal(first.status, "queued");
  assert.equal(first.attempts, 1);
  assert.equal(first.run_after, new Date(NOW).toISOString());
  assert.match(
    first.last_error,
    /^reclaimed: lease expired after 360s \(locked_by worker-abc, locked_at .*\); attempt 1 of 3$/,
  );

  const last = planReclaim({ ...row, attempts: 2 }, NOW);
  assert.equal(last.status, "dead");
  assert.equal(last.attempts, 3);
  assert.match(last.last_error, /attempt 3 of 3$/);
});

test("the loop the reclaim rule closes: three kills of the same job reach dead", () => {
  let row = {
    attempts: 0,
    max_attempts: 3,
    locked_at: "2026-09-30T11:50:00Z",
    locked_by: "w",
    type: "transcribe",
  };
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const plan = planReclaim(row, NOW);
    statuses.push(plan.status);
    row = { ...row, attempts: plan.attempts };
  }
  assert.deepEqual(statuses, ["queued", "queued", "dead"]);
});

test("a yield keeps attempts out of the patch and runs again now", () => {
  const plan = planYield("ai_scorecard before answer call: 12s left, needs 20s", NOW);
  assert.equal(plan.status, "queued");
  assert.equal("attempts" in plan, false);
  assert.equal(plan.run_after, new Date(NOW).toISOString());
  assert.equal(plan.last_error, "yielded: ai_scorecard before answer call: 12s left, needs 20s");
});

test("backoff doubles from 30s and caps at an hour", () => {
  assert.equal(backoffMs(1, noJitter), 30_000);
  assert.equal(backoffMs(2, noJitter), 60_000);
  assert.equal(backoffMs(3, noJitter), 120_000);
  assert.equal(backoffMs(20, noJitter), 3_600_000);
});
