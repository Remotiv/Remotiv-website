/**
 * Proof that the network guard works (#48): a REAL @upstash/redis client and
 * the REAL invite limiter, pointed at a Redis URL, are stopped before any
 * request leaves the process, and the attempt is on record, so the
 * `assertNoNetwork()` each limiter test file ends with would fail the suite.
 *
 *   node --test "src/test-support/no-network.test.ts"
 *
 * The URL is on .invalid, so even a guard that failed could not reach a host,
 * and every test here has a 10 s timeout, so a guard that failed makes these
 * tests FAIL instead of hanging (the runner has no default timeout).
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork, NetworkBlockedError } from "./no-network.mjs";

const guard = blockNetwork();
register(new URL("./node-resolve.mjs", import.meta.url));
const { Redis } = await import("@upstash/redis");
const limit = await import("../lib/invite-password-limit.ts");
const https = await import("node:https");
const net = await import("node:net");

test("a real Upstash client is stopped at fetch, before any request leaves", {
  timeout: 10_000,
}, async () => {
  const redis = new Redis({
    url: "https://blocked.example.invalid",
    token: "not-a-token",
    retry: false,
  });
  await assert.rejects(redis.ping(), NetworkBlockedError);
  assert.ok(guard.attempts.length >= 1, "the client did try");
  assert.ok(
    guard.attempts.every((a) => a === "fetch"),
    "every try was a fetch, and blocked",
  );
});

test("the older paths are blocked too: https.request, net.connect (named ESM imports included)", {
  timeout: 10_000,
}, () => {
  guard.attempts.length = 0;
  assert.throws(() => https.request("https://blocked.example.invalid"), NetworkBlockedError);
  assert.throws(() => net.connect(443, "blocked.example.invalid"), NetworkBlockedError);
  assert.deepEqual([...guard.attempts], ["https.request", "net.connect"]);
});

test("the limiter swallows the error (it fails closed), but the attempt is recorded, so the suite fails", {
  timeout: 10_000,
}, async () => {
  guard.attempts.length = 0;
  limit.setInvitePasswordStoresForTests(
    limit.defaultAttemptStore({
      UPSTASH_REDIS_REST_URL: "https://blocked.example.invalid",
      UPSTASH_REDIS_REST_TOKEN: "not-a-token",
    }),
  );
  const real = console.error;
  console.error = () => {};
  let result: unknown;
  try {
    result = await limit.reserveInvitePasswordAttempt("probe@example.invalid");
  } finally {
    console.error = real;
  }
  assert.deepEqual(result, { ok: false, reason: "unavailable" }, "refused, as designed");
  assert.ok(guard.attempts.includes("fetch"), "but the guard saw the call");
  assert.throws(() => guard.assertNoNetwork(), /a unit test tried the network: fetch/);
});
