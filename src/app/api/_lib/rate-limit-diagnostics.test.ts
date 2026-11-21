/**
 * The site-wide limiter with diagnostics wired in: the lines it writes, and
 * that every allow/deny decision is unchanged (#48 / #57, logs only).
 *
 *   node --test "src/app/api/_lib/rate-limit-diagnostics.test.ts"
 *
 * The real rate-limit.ts is loaded with @upstash/redis replaced by a stub whose
 * every call fails the way production's did (WRONGPASS, carrying the command
 * and a token in its message), and with both UPSTASH_* variables set to fake
 * values. Decisions must match the in-memory limiter exactly; the logs must
 * hold the store, the check result and one throttled sync failure, and no value.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

// No test in this file may reach a real network (#48): blocked and recorded, checked last.
const guard = blockNetwork();

const FAKE_URL = "https://fake-host-456.upstash.io";
const FAKE_TOKEN = "AXyzFAKEtoken9876543210fedcba";
process.env.UPSTASH_REDIS_REST_URL = FAKE_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_TOKEN;
process.env.VERCEL_ENV = "production";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUB = [
  "class UpstashError extends Error { name = 'UpstashError'; }",
  "const fail = (cmd) => Promise.reject(new UpstashError('WRONGPASS invalid or missing auth token, command was: ' + cmd + ' ${FAKE_TOKEN} ${FAKE_URL}'));",
  "globalThis.__redisCalls = [];",
  "export class Redis {",
  "  static fromEnv() { return new Redis(); }",
  "  eval(...a) { globalThis.__redisCalls.push('eval'); return fail('eval'); }",
  "  incr(k) { globalThis.__redisCalls.push('incr'); return fail('incr ' + k); }",
  "  pexpire(k) { globalThis.__redisCalls.push('pexpire'); return fail('pexpire ' + k); }",
  "}",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@upstash/redis") return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const info = [];
const errors = [];
const realInfo = console.info;
const realError = console.error;
console.info = (...a) => info.push(a.join(" "));
console.error = (...a) => errors.push(a.join(" "));
const { rateLimitByKey, rateLimit } = await import("./rate-limit.ts");
const settle = () => new Promise((r) => setTimeout(r, 20));
await settle();

test("cold start: the store line and the check line, by name and reason only", () => {
  assert.deepEqual(info, [
    "[rate-limit] store=redis",
    "[rate-limit] redis-check=failed reason=WRONGPASS",
  ]);
  assert.deepEqual(globalThis.__redisCalls, ["eval"]);
});

test("decisions are unchanged with Redis failing: 30 allowed, then denied, per key", async () => {
  const got = [];
  for (let i = 0; i < 32; i++) got.push(rateLimitByKey("diag-test-key").ok);
  assert.deepEqual(got, [...Array(30).fill(true), false, false]);
  assert.equal(rateLimitByKey("diag-other-key", { max: 2 }).ok, true);
  assert.equal(rateLimitByKey("diag-other-key", { max: 2 }).ok, true);
  assert.equal(rateLimitByKey("diag-other-key", { max: 2 }).ok, false);
  const req = new Request("http://localhost/x", { headers: { "x-real-ip": "203.0.113.9" } });
  const r = [];
  for (let i = 0; i < 4; i++) r.push(rateLimit(req, { max: 3, bucketKey: "diag" }).ok);
  assert.deepEqual(r, [true, true, true, false]);
  const denied = rateLimitByKey("diag-test-key");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter > 0 && denied.retryAfter <= 60);
  await settle();
});

test("sync failures: every failing INCR is swallowed, one line written per minute, no value", () => {
  assert.ok(
    globalThis.__redisCalls.filter((c) => c === "incr").length >= 30,
    "the INCRs still fired",
  );
  assert.deepEqual(errors, [
    // #57 slice 2: production without the public group's own pair says so.
    "[rate-limit] public-store=memory reason=PUBLIC_CREDS_MISSING",
    "[rate-limit] redis-sync=failed reason=WRONGPASS",
  ]);
  for (const line of [...info, ...errors]) {
    for (const s of [FAKE_URL, FAKE_TOKEN, "fake-host-456", "command was", "diag-test-key"]) {
      assert.ok(!line.includes(s), `leaked ${s}: ${line}`);
    }
  }
});

test("teardown", () => {
  console.info = realInfo;
  console.error = realError;
  clearInterval(globalThis.__rateLimitCleanup);
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
