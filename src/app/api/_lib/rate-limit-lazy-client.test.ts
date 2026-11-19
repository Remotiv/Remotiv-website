/**
 * #57 (safe part): a bad Redis setting can never break a route or the build,
 * and no URL or token reaches a log.
 *
 *   node --test "src/app/api/_lib/rate-limit-lazy-client.test.ts"
 *
 * The REAL @upstash/redis client, the REAL rate-limit.ts, loaded fresh for each
 * case (`?case=` makes a new module instance) under that case's environment.
 * The client's constructor throws UrlError on a malformed URL, with the URL as
 * its message; rate-limit.ts used to call it while the module loaded. Every
 * console line is captured and searched for the fake URL and token. The
 * network is blocked (no-network.mjs); fetch is replaced by a recorder that
 * also throws, so a test can see which credentials a request WOULD have used
 * without anything leaving the machine. Decisions are not this file's subject
 * (rate-limit-diagnostics.test.ts pins them); only that they still answer.
 */
// @ts-nocheck - same reason as rate-limit-diagnostics.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();
register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

/** fetch, recorded and refused: the host and bearer a request would have carried. */
const fetches = [];
globalThis.fetch = async (url, init = {}) => {
  const auth = new Headers(init.headers ?? {}).get("authorization") ?? "";
  fetches.push({ host: new URL(String(url)).host, bearer: auth.replace(/^Bearer /, "") });
  throw new TypeError("fetch failed (blocked in this test)");
};

const BAD_URL = "not a url: redis-bad-7781.example";
const GOOD_URL = "https://fake-upstash-7781.upstash.io";
const KV_URL = "https://fake-kv-7781.upstash.io";
const TOKEN = "AXfakeTOKEN7781upstashABCDEF0123";
const KV_TOKEN = "AXfakeKVTOKEN7781kvABCDEF0123";
const SECRETS = [
  BAD_URL,
  "redis-bad-7781",
  GOOD_URL,
  "fake-upstash-7781",
  KV_URL,
  "fake-kv-7781",
  TOKEN,
  KV_TOKEN,
];
const NAMES = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "NEXT_PHASE",
  "VERCEL_ENV",
];

let n = 0;
/** Load a fresh rate-limit.ts under `env`, capture every console line it writes. */
async function load(env) {
  for (const k of NAMES) delete process.env[k];
  Object.assign(process.env, env);
  const lines = [];
  const saved = { info: console.info, error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(`${k}: ${a.join(" ")}`);
  let mod = null;
  let threw = null;
  try {
    n += 1;
    mod = await import(`./rate-limit.ts?case=${n}`);
  } catch (err) {
    threw = err;
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  return {
    mod,
    threw,
    lines,
    settle,
    restore: () => Object.assign(console, saved),
  };
}
const noSecrets = (lines) => {
  for (const line of lines) {
    for (const s of SECRETS) assert.ok(!line.includes(s), `a log line carries a value: ${s}`);
  }
};

test("Z1. a malformed URL: the module loads, routes answer from memory, one reason-code line, no value", async () => {
  const c = await load({ UPSTASH_REDIS_REST_URL: BAD_URL, UPSTASH_REDIS_REST_TOKEN: TOKEN });
  try {
    assert.equal(c.threw, null, "importing the limiter must not throw");
    const got = [];
    for (let i = 0; i < 4; i++) got.push(c.mod.rateLimitByKey("z1", { max: 3 }).ok);
    assert.deepEqual(got, [true, true, true, false]);
    const req = new Request("http://localhost/x", { headers: { "x-real-ip": "203.0.113.7" } });
    assert.equal(c.mod.rateLimit(req, { bucketKey: "z1" }).ok, true);
    await c.settle();
    assert.deepEqual(c.lines, [
      "info: [rate-limit] store=redis",
      "error: [rate-limit] redis-client=failed reason=BADURL",
    ]);
    assert.equal(fetches.length, 0, "no client, so no request");
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("Z2. during next build (NEXT_PHASE): loading builds no client and writes nothing; first use still never throws", async () => {
  const c = await load({
    UPSTASH_REDIS_REST_URL: BAD_URL,
    UPSTASH_REDIS_REST_TOKEN: TOKEN,
    NEXT_PHASE: "phase-production-build",
  });
  try {
    assert.equal(c.threw, null);
    assert.deepEqual(c.lines, [], "the build log gets nothing from this module");
    assert.equal(c.mod.rateLimitByKey("z2").ok, true);
    await c.settle();
    assert.deepEqual(c.lines, ["error: [rate-limit] redis-client=failed reason=BADURL"]);
    // Asked again: the answer is kept, no second line.
    c.mod.rateLimitByKey("z2");
    await c.settle();
    assert.equal(c.lines.length, 1);
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("Z3. a mixed pair (an UPSTASH URL with a KV token) is no pair: memory, no client, no request", async () => {
  const before = fetches.length;
  const c = await load({ UPSTASH_REDIS_REST_URL: GOOD_URL, KV_REST_API_TOKEN: KV_TOKEN });
  try {
    assert.equal(c.threw, null);
    c.mod.rateLimitByKey("z3");
    await c.settle();
    assert.deepEqual(c.lines, ["info: [rate-limit] store=memory"]);
    assert.equal(fetches.length, before, "nothing was sent with half a pair");
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("Z4. the KV pair alone is a complete pair: its URL and its token, together, and nothing logged of either", async () => {
  const before = fetches.length;
  const c = await load({ KV_REST_API_URL: KV_URL, KV_REST_API_TOKEN: KV_TOKEN });
  try {
    c.mod.rateLimitByKey("z4");
    await c.settle();
    const sent = fetches.slice(before);
    assert.ok(sent.length >= 1, "the check and the INCR were attempted");
    assert.ok(
      sent.every((f) => f.host === new URL(KV_URL).host && f.bearer === KV_TOKEN),
      "every request used the KV pair, both halves",
    );
    assert.equal(c.lines[0], "info: [rate-limit] store=redis");
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("Z5. both pairs set: UPSTASH wins, whole; a valid setting decides exactly as before", async () => {
  const before = fetches.length;
  const c = await load({
    UPSTASH_REDIS_REST_URL: GOOD_URL,
    UPSTASH_REDIS_REST_TOKEN: TOKEN,
    KV_REST_API_URL: KV_URL,
    KV_REST_API_TOKEN: KV_TOKEN,
  });
  try {
    const got = [];
    for (let i = 0; i < 32; i++) got.push(c.mod.rateLimitByKey("z5").ok);
    assert.deepEqual(got, [...Array(30).fill(true), false, false]);
    await c.settle();
    // Z4's client retries in the background (Upstash backs off), so this window
    // can hold its requests too; what must hold is that this client used the
    // UPSTASH pair whole.
    const sent = fetches.slice(before);
    assert.ok(sent.some((f) => f.host === new URL(GOOD_URL).host && f.bearer === TOKEN));
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("Z6. the source builds no client at module load and reads no single variable on its own", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./rate-limit.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Redis\.fromEnv/);
  assert.doesNotMatch(code, /process\.env\.(UPSTASH|KV)_/);
  assert.match(code, /redisCredentialPair\(process\.env, \{ kvFallback: true \}\)/);
  assert.match(
    code,
    /try \{\s*client = new Redis\(\{ url: creds\.url, token: creds\.token \}\);\s*\} catch \(err\) \{/,
  );
  // Exactly one place builds a client, and it is inside that function.
  assert.equal((code.match(/new Redis\(/g) ?? []).length, 1);
});

test("teardown", () => {
  for (const k of NAMES) delete process.env[k];
  clearInterval(globalThis.__rateLimitCleanup);
});

test("no request ever mixed the pairs: each carried one URL with its own token", () => {
  const pairs = new Set([
    `${new URL(GOOD_URL).host} ${TOKEN}`,
    `${new URL(KV_URL).host} ${KV_TOKEN}`,
  ]);
  assert.ok(fetches.length >= 2);
  for (const f of fetches) assert.ok(pairs.has(`${f.host} ${f.bearer}`), "a mixed pair was sent");
});

test("no request left the machine (the recorder refused them all)", () => {
  // blockNetwork records node-level attempts; fetch is the recorder above.
  guard.assertNoNetwork();
});
