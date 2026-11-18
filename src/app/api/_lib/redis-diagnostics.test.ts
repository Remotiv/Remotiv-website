/**
 * Redis diagnostics: one word per reason, never a value (#48 / #57).
 *
 *   node --test "src/app/api/_lib/redis-diagnostics.test.ts"
 *
 * Every error below is built to CARRY a secret (a token, a URL, a host, the
 * failing command), because that is what the real Upstash and fetch errors
 * do, and every line produced from it is checked for each of them.
 * Synthetic values only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

// No test in this file may reach a real network (#48): blocked and recorded, checked last.
const guard = blockNetwork();

const {
  LOG_PREFIX,
  redisCheckLine,
  redisReasonCode,
  storeChoice,
  storeChoiceLine,
  throttledFailureLog,
} = await import("./redis-diagnostics.ts");

const SECRETS = [
  "AXyzSECRETtoken0123456789abcdef",
  "https://fake-host-123.upstash.io",
  "fake-host-123.upstash.io",
  "return 1",
  "rl:company-accept",
];
/** The whole grammar of what may be written. */
const LINE =
  /^\[rate-limit\] (store=(redis|memory)|store=production-without-redis missing=UPSTASH_REDIS_REST_(URL|TOKEN)(,UPSTASH_REDIS_REST_TOKEN)?|redis-check=ok|redis-check=failed reason=[A-Z_]+|redis-sync=failed reason=[A-Z_]+( suppressed=\d+)?)$/;
const clean = (line) => {
  assert.match(line, LINE, line);
  for (const s of SECRETS) assert.ok(!line.includes(s), `leaked ${s}: ${line}`);
};

class UpstashError extends Error {
  name = "UpstashError";
}
const upstash = (word) =>
  new UpstashError(
    `${word} invalid or missing auth token, command was: ["eval","return 1",0] at ${SECRETS[1]} with ${SECRETS[0]}`,
  );
const fetchFailed = (code) =>
  Object.assign(new TypeError(`fetch failed to ${SECRETS[1]}`), {
    cause: { code, hostname: SECRETS[2], message: `getaddrinfo ${code} ${SECRETS[2]}` },
  });

test("reason codes: the Redis reply word or the network code, nothing else", () => {
  const cases = [
    [upstash("WRONGPASS"), "WRONGPASS"],
    [upstash("NOPERM"), "NOPERM"],
    [upstash("ERR"), "ERR"],
    [upstash("NOAUTH"), "NOAUTH"],
    [new UpstashError(`Unexpected response from ${SECRETS[1]}: <html>`), "UPSTASH_OTHER"],
    [fetchFailed("ENOTFOUND"), "ENOTFOUND"],
    [fetchFailed("EAI_AGAIN"), "ENOTFOUND"],
    [fetchFailed("ETIMEDOUT"), "ETIMEDOUT"],
    [fetchFailed("UND_ERR_CONNECT_TIMEOUT"), "ETIMEDOUT"],
    [fetchFailed("ECONNREFUSED"), "ECONNREFUSED"],
    [Object.assign(new Error(SECRETS[1]), { name: "UrlError" }), "BADURL"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "ETIMEDOUT"],
    [new Error(`WRONGPASS-ish but lowercase start ${SECRETS[0]}`), "WRONGPASS"],
    [new Error(`something ${SECRETS[0]}`), "UNKNOWN"],
    [new Error(`MADEUPWORD ${SECRETS[0]}`), "UNKNOWN"],
    [null, "UNKNOWN"],
    [`a string with ${SECRETS[0]}`, "UNKNOWN"],
  ];
  for (const [err, want] of cases) {
    const got = redisReasonCode(err);
    assert.equal(got, want, String(err?.message ?? err));
    for (const s of SECRETS) assert.ok(!got.includes(s));
  }
});

test("store choice: the same both-variables test the limiter uses; names only, never values", () => {
  const url = SECRETS[1];
  const token = SECRETS[0];
  const cases = [
    [{ UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token }, "[rate-limit] store=redis"],
    [
      { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token, VERCEL_ENV: "production" },
      "[rate-limit] store=redis",
    ],
    [{}, "[rate-limit] store=memory"],
    [{ VERCEL_ENV: "preview" }, "[rate-limit] store=memory"],
    [
      { VERCEL_ENV: "production" },
      "[rate-limit] store=production-without-redis missing=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN",
    ],
    [
      { VERCEL_ENV: "production", UPSTASH_REDIS_REST_URL: url },
      "[rate-limit] store=production-without-redis missing=UPSTASH_REDIS_REST_TOKEN",
    ],
    [
      { VERCEL_ENV: "production", UPSTASH_REDIS_REST_TOKEN: token, UPSTASH_REDIS_REST_URL: "" },
      "[rate-limit] store=production-without-redis missing=UPSTASH_REDIS_REST_URL",
    ],
  ];
  for (const [env, want] of cases) {
    const line = storeChoiceLine(storeChoice(env));
    assert.equal(line, want);
    clean(line);
  }
});

test('redis check: EVAL "return 1" with no key; ok, a reason code, or UNEXPECTED_REPLY', async () => {
  const calls = [];
  const ok = await redisCheckLine({
    async eval(script, keys, args) {
      calls.push([script, keys, args]);
      return 1;
    },
  });
  assert.equal(ok, "[rate-limit] redis-check=ok");
  assert.deepEqual(calls, [["return 1", [], []]], "touches no key");
  for (const [reply, want] of [
    [async () => "1", "[rate-limit] redis-check=ok"],
    [async () => 0, "[rate-limit] redis-check=failed reason=UNEXPECTED_REPLY"],
    [
      async () => {
        throw upstash("WRONGPASS");
      },
      "[rate-limit] redis-check=failed reason=WRONGPASS",
    ],
    [
      async () => {
        throw upstash("NOPERM");
      },
      "[rate-limit] redis-check=failed reason=NOPERM",
    ],
    [
      async () => {
        throw fetchFailed("ENOTFOUND");
      },
      "[rate-limit] redis-check=failed reason=ENOTFOUND",
    ],
  ]) {
    const line = await redisCheckLine({ eval: reply });
    assert.equal(line, want);
    clean(line);
  }
});

test("sync failures: at most one line a minute per instance, with the held-back count", () => {
  let t = 0;
  const lines = [];
  const log = throttledFailureLog(
    (l) => lines.push(l),
    60_000,
    () => t,
  );
  log(upstash("WRONGPASS"));
  for (let i = 0; i < 5; i++) {
    t += 1_000;
    log(fetchFailed("ETIMEDOUT"));
  }
  t = 60_000;
  log(fetchFailed("ENOTFOUND"));
  t = 61_000;
  log(upstash("ERR"));
  assert.deepEqual(lines, [
    "[rate-limit] redis-sync=failed reason=WRONGPASS",
    "[rate-limit] redis-sync=failed reason=ENOTFOUND suppressed=5",
  ]);
  for (const l of lines) clean(l);
});

test("the prefix is fixed", () => {
  assert.equal(LOG_PREFIX, "[rate-limit]");
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
