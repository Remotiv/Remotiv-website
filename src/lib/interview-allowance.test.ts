/**
 * The interview allowance module: reading consume_allowance's answer for
 * interview_sent, giving a credit back without ever throwing, and the fixed
 * refusal message with its Karachi reset date.
 *
 *   node --test src/lib/interview-allowance.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/server-only-stub.mjs", import.meta.url));

const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const {
  consumeInterviewAllowance,
  INTERVIEW_ALLOWANCE_UNAVAILABLE,
  INTERVIEW_SENT_METRIC,
  interviewLimitMessage,
  releaseInterviewAllowance,
} = await import("./interview-allowance.ts");

for (const m of ["error", "warn"]) console[m] = () => {};

const rpcAnswer = (answer) => fakeService((name) => (name.startsWith("rpc:") ? answer : {}));
const SESSION = "6f1c2a8e-3b7d-4c11-9a0e-5d2f8b7c1e44";

test("a grant carries the usage id, and the call names the company, interview_sent and the session", async () => {
  const service = rpcAnswer({
    data: [
      {
        allowed: true,
        unlimited: false,
        reason: "within_limit",
        used: 1,
        allowance: 5,
        usage_id: "u-1",
      },
    ],
    error: null,
  });
  assert.deepEqual(await consumeInterviewAllowance(service, "co", SESSION), {
    allowed: true,
    usageId: "u-1",
    unlimited: false,
    reason: "within_limit",
  });
  assert.equal(INTERVIEW_SENT_METRIC, "interview_sent");
  assert.deepEqual(service.rpcs, [
    {
      name: "consume_allowance",
      args: { p_company: "co", p_metric: "interview_sent", p_ref: SESSION },
    },
  ]);
});

test("an unlimited grant (internal, no plan, no limit) is a grant like any other", async () => {
  for (const reason of ["unlimited_internal", "unlimited_no_plan", "unlimited_metric_not_set"]) {
    const service = rpcAnswer({
      data: [{ allowed: true, unlimited: true, reason, used: 9, allowance: null, usage_id: "u-9" }],
      error: null,
    });
    assert.deepEqual(
      await consumeInterviewAllowance(service, "co", SESSION),
      { allowed: true, usageId: "u-9", unlimited: true, reason },
      reason,
    );
  }
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
  assert.deepEqual(await consumeInterviewAllowance(service, "co", SESSION), {
    allowed: false,
    used: 5,
    allowance: 5,
  });
});

test("no decision throws: an error, no rows, or a grant without an id", async () => {
  for (const [label, answer] of [
    ["error", { data: null, error: { message: "permission denied" } }],
    ["no rows", { data: [], error: null }],
    ["no id", { data: [{ allowed: true, unlimited: false, usage_id: null }], error: null }],
  ]) {
    await assert.rejects(consumeInterviewAllowance(rpcAnswer(answer), "co", SESSION), label);
  }
});

test("release names the usage id, and never throws whatever the database does", async () => {
  const ok = rpcAnswer({ data: true, error: null });
  await releaseInterviewAllowance(ok, "u-1");
  assert.deepEqual(ok.rpcs, [{ name: "release_allowance", args: { p_usage_id: "u-1" } }]);
  for (const service of [
    rpcAnswer({ data: null, error: { message: "boom" } }),
    rpcAnswer({ data: false, error: null }),
    fakeService(() => {
      throw new Error("socket hang up");
    }),
  ]) {
    await releaseInterviewAllowance(service, "u-1");
  }
});

test("the refusal message is fixed, and its date is the next Karachi month, not UTC's", () => {
  const text = (date) =>
    `This company has used all its async interview invitations for this month. The limit resets on ${date} or can be raised by Remotiv.`;
  assert.equal(interviewLimitMessage(new Date("2026-10-15T09:00:00Z")), text("1 November 2026"));
  // 20:00 UTC on 31 October is already 1 November in Karachi: the month that
  // resets next is December. A UTC calendar would still say November.
  assert.equal(interviewLimitMessage(new Date("2026-10-31T20:00:00Z")), text("1 December 2026"));
  // And the last Karachi hour of October still resets on 1 November.
  assert.equal(interviewLimitMessage(new Date("2026-10-31T18:59:59Z")), text("1 November 2026"));
  assert.doesNotMatch(interviewLimitMessage(new Date()), /—/);
  assert.doesNotMatch(INTERVIEW_ALLOWANCE_UNAVAILABLE, /—/);
});
