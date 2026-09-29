/**
 * The start gate and per-call budget rules (Phase 5, P2).
 *
 *   node --test src/lib/queue/budgets.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
const {
  canStart,
  DEADLINE_MARGIN_MS,
  FUNCTION_MAX_DURATION_MS,
  MIN_PROVIDER_CALL_BUDGET_MS,
  minStartBudgetMs,
  PROVIDER_CALL_TIMEOUT_CAP_MS,
  providerTimeoutMs,
} = await import("./budgets.ts");
const { assertProviderBudget, createJobContext, providerRequestOptions } = await import(
  "./job-context.ts"
);
const { JobYield } = await import("./failure-class.ts");

test("a paid job type starts only when its first call can fit; other types need little", () => {
  assert.equal(canStart("ai_cv_score", 34_999), false);
  assert.equal(canStart("ai_cv_score", 35_000), true);
  assert.equal(canStart("transcribe", 30_000), false);
  assert.equal(canStart("ai_scorecard", 20_000), true);
  assert.equal(canStart("ai_scorecard", 19_999), false);
  assert.equal(canStart("send_message", 5_000), true);
  assert.equal(canStart("send_message", 4_999), false);
  assert.equal(minStartBudgetMs("cv_purge"), 5_000);
});

test("no start gate is below the per-call minimum, so a yield can never happen with zero progress", () => {
  for (const type of ["ai_cv_score", "transcribe", "ai_scorecard"]) {
    assert.ok(minStartBudgetMs(type) >= MIN_PROVIDER_CALL_BUDGET_MS, type);
  }
});

test("the deadline leaves a margin inside maxDuration", () => {
  assert.equal(FUNCTION_MAX_DURATION_MS, 60_000);
  assert.ok(DEADLINE_MARGIN_MS > 0 && DEADLINE_MARGIN_MS < 10_000);
});

test("provider timeout sits inside the remaining budget and under the cap", () => {
  assert.equal(providerTimeoutMs(30_000), 29_000);
  assert.equal(providerTimeoutMs(100_000), PROVIDER_CALL_TIMEOUT_CAP_MS);
  assert.equal(providerTimeoutMs(500), 1_000);
});

test("job context: remaining budget counts down and the signal aborts at the deadline", async () => {
  let now = 1_000_000;
  const ctx = createJobContext(now + 50, () => now);
  assert.equal(ctx.remainingMs(), 50);
  now += 30;
  assert.equal(ctx.remainingMs(), 20);
  now += 100;
  assert.equal(ctx.remainingMs(), 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ctx.signal.aborted, true);
});

test("assertProviderBudget yields below the minimum and is a no-op without a context", () => {
  const ctx = createJobContext(Date.now() + 5_000);
  assert.throws(
    () => assertProviderBudget(ctx, 20_000, "test"),
    (e) => e instanceof JobYield && /needs 20s/.test(e.message),
  );
  assert.doesNotThrow(() => assertProviderBudget(ctx, 1_000, "test"));
  assert.doesNotThrow(() => assertProviderBudget(undefined, 999_999, "test"));
});

test("request options: signal, budgeted timeout and NO SDK retries inside the worker; nothing outside it", () => {
  const ctx = createJobContext(Date.now() + 30_000);
  const opts = providerRequestOptions(ctx, providerTimeoutMs);
  assert.equal(opts.maxRetries, 0);
  assert.equal(opts.signal, ctx.signal);
  assert.ok(opts.timeout <= 29_000 && opts.timeout > 27_000);
  assert.deepEqual(providerRequestOptions(undefined, providerTimeoutMs), {});
});
