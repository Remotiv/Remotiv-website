/**
 * The row patches for failure, reclaim and yield (Phase 5, P2/P13).
 *
 *   node --test src/lib/queue/transitions.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
const { JobYield, MAX_YIELD_DELAY_MS, TerminalJobError } = await import("./failure-class.ts");
const { BACKOFF_MAX_MS, backoffMs, planFailure, planReclaim, planYield } = await import(
  "./transitions.ts"
);

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

/* ── the delayed yield (#85, 3a-1) ────────────────────────────── */

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const SIXTEEN_MINUTES = 16 * 60_000;

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every `new JobYield(...)` in src, as "file: argument count". */
function jobYieldConstructions() {
  const found = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("new JobYield(")) continue;
    const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const visit = (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "JobYield"
      ) {
        found.push(`${relative(SRC, path)}: ${node.arguments?.length ?? 0}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found.sort();
}

/*
 * The seven existing JobYield throwers, all budget yields that must keep
 * running again on the next tick:
 *   assertProviderBudget, queue/job-context.ts:48 (constructs)
 *   final-interviews/import.ts:476 (constructs)
 *   final-interviews/bots.ts (rethrows)
 *   ai/interview-scoring.ts:1612 (rethrows)
 *   ai/cv-scoring.ts:1420 and :1629 (rethrow)
 *   interviews/live-scoring.ts:601 (rethrows)
 * Only the first two build a JobYield; the other five pass on one that was
 * built there. So the two constructions are pinned to one argument, no delay.
 *
 * The one delayed construction (#85, 3a-2) is pinned too, in
 * lib/communication-attempt.ts: JobYield(E2, SEND_RETRY_DELAY_MS), a send
 * waiting on another attempt's row (too_fresh, not_due). Its two arguments
 * are the delay; communication-attempt.test.ts holds the delay under
 * MAX_YIELD_DELAY_MS.
 *
 * Negative control: give either budget construction a second argument, or add
 * a new construction anywhere in src, and this fails.
 */
test("every JobYield construction is pinned: budget yields run again now, the one send wait is delayed", () => {
  assert.deepEqual(jobYieldConstructions(), [
    "lib/communication-attempt.ts: 2",
    "lib/final-interviews/import.ts: 1",
    "lib/queue/job-context.ts: 1",
  ]);
  const budget = new JobYield("ai_scorecard before answer call: 12s left, needs 20s");
  assert.equal(budget.delayMs, 0, "no argument is no delay");
  assert.deepEqual(
    planYield(budget.message, NOW, budget.delayMs),
    planYield(budget.message, NOW),
    "a yield with no delay plans exactly what planYield always planned",
  );
  assert.equal(
    planYield(budget.message, NOW, budget.delayMs).run_after,
    new Date(NOW).toISOString(),
  );
});

// Negative control: if planYield ignored delayMs, run_after would be NOW and
// this fails; if it added it to updated_at too, the second assertion fails.
test("a delayed yield runs again exactly delayMs from now", () => {
  const wait = new JobYield("waiting on another attempt", SIXTEEN_MINUTES);
  assert.equal(wait.delayMs, SIXTEEN_MINUTES);
  const plan = planYield(wait.message, NOW, wait.delayMs);
  assert.equal(plan.run_after, new Date(NOW + SIXTEEN_MINUTES).toISOString());
  assert.equal(plan.updated_at, new Date(NOW).toISOString(), "the write itself is stamped now");
  assert.equal(plan.status, "queued");
  assert.equal(plan.last_error, "yielded: waiting on another attempt");
  assert.equal(planYield("x", NOW, 1).run_after, new Date(NOW + 1).toISOString());
  assert.equal(
    planYield("x", NOW, MAX_YIELD_DELAY_MS).run_after,
    new Date(NOW + MAX_YIELD_DELAY_MS).toISOString(),
  );
});

// Negative control: a planYield that counted the yield (attempts in the patch)
// fails the first assertion. lease.test.ts proves the same through the worker.
test("a delayed yield never touches attempts", () => {
  const plan = planYield("waiting", NOW, SIXTEEN_MINUTES);
  assert.equal("attempts" in plan, false);
  assert.deepEqual(Object.keys(plan).sort(), [
    "last_error",
    "locked_at",
    "locked_by",
    "run_after",
    "status",
    "updated_at",
  ]);
});

/*
 * Each bad delay is refused where the JobYield is built: the constructor throws
 * a TypeError or RangeError instead, so no JobYield, and no silent 0, ever
 * exists. undefined is refused when it is PASSED: leaving the argument out is
 * the budget yield, but a delay variable that turned out undefined is a bug.
 * Negative control: drop checkedDelay and every one of these constructs.
 */
for (const [label, value, Kind] of [
  ["negative", -1, RangeError],
  ["negative fraction", -0.5, RangeError],
  ["fraction", 1.5, RangeError],
  ["NaN", Number.NaN, RangeError],
  ["Infinity", Number.POSITIVE_INFINITY, RangeError],
  ["-Infinity", Number.NEGATIVE_INFINITY, RangeError],
  ["over the ceiling", MAX_YIELD_DELAY_MS + 1, RangeError],
  ["a numeric string", "960000", TypeError],
  ["null", null, TypeError],
  ["undefined, passed", undefined, TypeError],
  ["a bigint", 960000n, TypeError],
  ["an object", { ms: 960000 }, TypeError],
]) {
  test(`a JobYield with a bad delay is refused: ${label}`, () => {
    assert.throws(
      () => new JobYield("waiting", value),
      (err) =>
        err instanceof Kind && !(err instanceof JobYield) && /JobYield: delayMs/.test(err.message),
    );
  });
}

// Negative control: raise either ceiling without the other and this fails.
test("the yield ceiling is the backoff ceiling, and the edges are accepted", () => {
  assert.equal(MAX_YIELD_DELAY_MS, BACKOFF_MAX_MS);
  assert.equal(new JobYield("x", 0).delayMs, 0);
  assert.equal(new JobYield("x", MAX_YIELD_DELAY_MS).delayMs, MAX_YIELD_DELAY_MS);
});
