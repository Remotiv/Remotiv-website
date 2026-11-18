/**
 * The invitation password limit (#48, QA-SAFETY-40 T-2).
 *
 *   node --test "src/lib/invite-password-limit.test.ts"
 *
 * Keyed on the account (the normalised invited address), atomic by
 * reservation, sliding lock, cleared by a correct password. The Redis store is
 * driven through a fake whose eval is a real INCR + PEXPIRE on a Map; the
 * concurrency cases fire every request in the same tick. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../test-support/no-network.mjs";

// No test in this file may reach a real network (#48): blocked and recorded, checked last.
const guard = blockNetwork();

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const limitModule = await import("./invite-password-limit.ts");
const {
  INVITE_PASSWORD_LOCK_MS,
  INVITE_PASSWORD_MAX_ATTEMPTS,
  clearInvitePasswordAttempts,
  invitePasswordKey,
  memoryAttemptStore,
  redisAttemptStore,
  reserveInvitePasswordAttempt,
  setInvitePasswordStoresForTests,
} = await import("./invite-password-limit.ts");

const EMAIL = "rae@acme.test";

/** A clock the memory store reads; advanced by hand. */
function clock(start = Date.parse("2026-11-17T12:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** A fake Upstash client: eval runs the script's two commands on a Map, synchronously. */
function fakeRedis(c, { failEval = false } = {}) {
  const keys = new Map();
  return {
    keys,
    async eval(script, [key], [ttl]) {
      if (failEval) throw new Error("connect ECONNREFUSED");
      assert.match(script, /INCR/);
      assert.match(script, /PEXPIRE/);
      const e = keys.get(key);
      const count = e && e.expiresAt > c.now() ? e.count + 1 : 1;
      keys.set(key, { count, expiresAt: c.now() + Number(ttl) });
      return count;
    },
    async del(key) {
      keys.delete(key);
    },
  };
}

const reserveN = async (n, email = EMAIL) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await reserveInvitePasswordAttempt(email)).ok);
  return out;
};

test("the limit is 10 attempts and a 15 minute lock", () => {
  assert.equal(INVITE_PASSWORD_MAX_ATTEMPTS, 10);
  assert.equal(INVITE_PASSWORD_LOCK_MS, 15 * 60 * 1000);
});

test("the key is the account: trimmed, lower-cased, hashed, never the address itself", () => {
  const k = invitePasswordKey("  Rae@ACME.test ");
  assert.equal(k, invitePasswordKey("rae@acme.test"));
  assert.match(k, /^invite-pw:[0-9a-f]{64}$/);
  assert.ok(!k.includes("rae"), "no address in the key");
  assert.notEqual(k, invitePasswordKey("ray@acme.test"));
});

test("10 attempts are allowed, the 11th is locked, and the lock reports its length", async () => {
  const c = clock();
  setInvitePasswordStoresForTests(memoryAttemptStore(c.now));
  assert.deepEqual(await reserveN(10), Array(10).fill(true));
  const r = await reserveInvitePasswordAttempt(EMAIL);
  assert.deepEqual(r, { ok: false, reason: "locked", retryAfterSeconds: 900 });
});

test("the same account under any spelling shares one count; another account does not", async () => {
  const c = clock();
  setInvitePasswordStoresForTests(memoryAttemptStore(c.now));
  await reserveN(5, "rae@acme.test");
  await reserveN(5, " RAE@acme.TEST");
  assert.equal((await reserveInvitePasswordAttempt("Rae@Acme.Test")).ok, false);
  assert.equal((await reserveInvitePasswordAttempt("sam@acme.test")).ok, true);
});

test("the lock slides: guessing through it keeps it locked; 15 quiet minutes open it", async () => {
  const c = clock();
  setInvitePasswordStoresForTests(memoryAttemptStore(c.now));
  await reserveN(11);
  c.advance(14 * 60 * 1000);
  assert.equal((await reserveInvitePasswordAttempt(EMAIL)).ok, false, "14 min, still locked");
  c.advance(14 * 60 * 1000);
  assert.equal(
    (await reserveInvitePasswordAttempt(EMAIL)).ok,
    false,
    "re-armed by the last attempt",
  );
  c.advance(INVITE_PASSWORD_LOCK_MS);
  assert.equal((await reserveInvitePasswordAttempt(EMAIL)).ok, true, "15 quiet minutes later");
});

test("a correct password clears the count", async () => {
  const c = clock();
  setInvitePasswordStoresForTests(memoryAttemptStore(c.now));
  await reserveN(9);
  await clearInvitePasswordAttempts(" RAE@acme.test");
  assert.deepEqual(await reserveN(10), Array(10).fill(true));
});

test("concurrent: 50 attempts in one tick, exactly 10 get a slot (memory store)", async () => {
  const c = clock();
  setInvitePasswordStoresForTests(memoryAttemptStore(c.now));
  const r = await Promise.all(
    Array.from({ length: 50 }, () => reserveInvitePasswordAttempt(EMAIL)),
  );
  assert.equal(r.filter((x) => x.ok).length, 10);
});

test("concurrent: 50 attempts in one tick, exactly 10 get a slot (Redis store, one script per attempt)", async () => {
  const c = clock();
  const redis = fakeRedis(c);
  setInvitePasswordStoresForTests(redisAttemptStore(redis));
  const r = await Promise.all(
    Array.from({ length: 50 }, () => reserveInvitePasswordAttempt(EMAIL)),
  );
  assert.equal(r.filter((x) => x.ok).length, 10);
  assert.equal(redis.keys.get(invitePasswordKey(EMAIL)).count, 50, "every attempt counted");
  await clearInvitePasswordAttempts(EMAIL);
  assert.equal(redis.keys.size, 0, "a correct password deletes the shared key");
});

test("multiple instances: two stores sharing one Redis, 50 interleaved attempts, exactly 10 slots", async () => {
  // Each serverless instance builds its own client; the count lives only in
  // Redis, and each attempt is ONE script call (INCR + PEXPIRE), so there is
  // no read on the instance followed by a write.
  const c = clock();
  const server = fakeRedis(c);
  const instances = [redisAttemptStore(server), redisAttemptStore(server)];
  const r = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      instances[i % 2].increment(invitePasswordKey(EMAIL), 1000),
    ),
  );
  assert.deepEqual(
    [...r].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
    "50 distinct counts: no two attempts read the same value",
  );
  setInvitePasswordStoresForTests(instances[0]);
  assert.equal((await reserveInvitePasswordAttempt(EMAIL)).ok, false, "already over the limit");
});

test("the Redis store is one EVAL per attempt: no separate GET or SET", async () => {
  const c = clock();
  const calls = [];
  const server = fakeRedis(c);
  const spy = new Proxy(server, {
    get(t, k) {
      if (typeof t[k] === "function") calls.push(String(k));
      return t[k];
    },
  });
  setInvitePasswordStoresForTests(redisAttemptStore(spy));
  await reserveInvitePasswordAttempt(EMAIL);
  await reserveInvitePasswordAttempt(EMAIL);
  assert.deepEqual(calls, ["eval", "eval"]);
});

test("Redis failing: FAILS CLOSED - every attempt refused as unavailable, nothing counted elsewhere, nothing named in the log", async () => {
  const c = clock();
  const logged = [];
  const real = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    setInvitePasswordStoresForTests(redisAttemptStore(fakeRedis(c, { failEval: true })));
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await reserveInvitePasswordAttempt(EMAIL), {
        ok: false,
        reason: "unavailable",
      });
    }
  } finally {
    console.error = real;
  }
  assert.equal(logged.length, 3);
  assert.ok(logged.every((l) => !l.includes("rae") && !l.includes("ECONNREFUSED")));
});

test("store choice: Redis when configured; production without Redis fails closed; dev/staging uses memory", async () => {
  assert.equal(typeof limitModule.defaultAttemptStore, "function");
  const prod = limitModule.defaultAttemptStore({ VERCEL_ENV: "production" });
  await assert.rejects(prod.increment("k", 1000));
  setInvitePasswordStoresForTests(prod);
  assert.deepEqual(await reserveInvitePasswordAttempt(EMAIL), { ok: false, reason: "unavailable" });
  const dev = limitModule.defaultAttemptStore({});
  assert.equal(await dev.increment("k", 1000), 1);
  assert.equal(await dev.increment("k", 1000), 2);
  const redis = limitModule.defaultAttemptStore({
    UPSTASH_REDIS_REST_URL: "https://example.invalid",
    UPSTASH_REDIS_REST_TOKEN: "test-token-not-real",
  });
  assert.equal(typeof redis.increment, "function", "a Redis-backed store is built (no call made)");
});

/* ── Hardening (re-ship of #48): lazy client, fallback names, reason-code logs ── */

const SECRET_URL = "https://fake-host-789.upstash.io";
const SECRET_TOKEN = "AXyzFAKEinviteToken0123456789";
const LINE =
  /^\[invite-password-limit\] (store=redis source=(upstash|kv)|store=memory|store=production-without-redis missing=[A-Z_|,]+|attempt refused reason=[A-Z_]+|clear failed reason=[A-Z_]+)$/;

/** Run fn with console.error and console.warn captured. */
async function captured(fn) {
  const lines = [];
  const [e, w] = [console.error, console.warn];
  console.error = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = e;
    console.warn = w;
  }
}
const noValues = (line) => {
  for (const s of [SECRET_URL, SECRET_TOKEN, "fake-host-789", "not-a-url", "rae@"]) {
    assert.ok(!line.includes(s), `leaked ${s}: ${line}`);
  }
};

test("a bad URL is a refusal, not a crash: the store builds lazily, the attempt is refused and logged as BADURL", async () => {
  const env = { UPSTASH_REDIS_REST_URL: "not-a-url", UPSTASH_REDIS_REST_TOKEN: SECRET_TOKEN };
  const store = limitModule.defaultAttemptStore(env); // must not throw
  setInvitePasswordStoresForTests(store);
  const { result, lines } = await captured(async () => [
    await reserveInvitePasswordAttempt(EMAIL),
    await reserveInvitePasswordAttempt(EMAIL),
  ]);
  assert.deepEqual(result, [
    { ok: false, reason: "unavailable" },
    { ok: false, reason: "unavailable" },
  ]);
  const ours = lines.filter((l) => l.startsWith("[invite-password-limit]"));
  assert.deepEqual(ours, [
    "[invite-password-limit] attempt refused reason=BADURL",
    "[invite-password-limit] attempt refused reason=BADURL",
  ]);
  for (const l of lines) noValues(l);
  for (const l of ours) assert.match(l, LINE);
});

/*
 * Credential pairs: UPSTASH pair, else KV pair, else none. Never mixed. The
 * selector is the one the store uses (redisCredentialPair) and the line is
 * built from the same selector, so the log cannot disagree with the decision.
 */
const U_URL = "https://fake-upstash-111.upstash.io";
const U_TOKEN = "AXyzFAKEupstashToken1111";
const K_URL = "https://fake-kv-222.upstash.io";
const K_TOKEN = "AXyzFAKEkvToken2222";
const VALUES = [U_URL, U_TOKEN, K_URL, K_TOKEN, "fake-upstash-111", "fake-kv-222"];
const PAIR_CASES = [
  // [label, env, expected pair (null = none), production line]
  [
    "UPSTASH pair",
    { UPSTASH_REDIS_REST_URL: U_URL, UPSTASH_REDIS_REST_TOKEN: U_TOKEN },
    ["UPSTASH_REDIS_REST", U_URL, U_TOKEN],
    "store=redis source=upstash",
  ],
  [
    "KV pair",
    { KV_REST_API_URL: K_URL, KV_REST_API_TOKEN: K_TOKEN },
    ["KV_REST_API", K_URL, K_TOKEN],
    "store=redis source=kv",
  ],
  [
    "both pairs: UPSTASH wins, whole",
    {
      UPSTASH_REDIS_REST_URL: U_URL,
      UPSTASH_REDIS_REST_TOKEN: U_TOKEN,
      KV_REST_API_URL: K_URL,
      KV_REST_API_TOKEN: K_TOKEN,
    },
    ["UPSTASH_REDIS_REST", U_URL, U_TOKEN],
    "store=redis source=upstash",
  ],
  [
    "UPSTASH half + full KV pair: the KV pair, whole",
    { UPSTASH_REDIS_REST_URL: U_URL, KV_REST_API_URL: K_URL, KV_REST_API_TOKEN: K_TOKEN },
    ["KV_REST_API", K_URL, K_TOKEN],
    "store=redis source=kv",
  ],
  [
    "mixed: UPSTASH url + KV token",
    { UPSTASH_REDIS_REST_URL: U_URL, KV_REST_API_TOKEN: K_TOKEN },
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_TOKEN,KV_REST_API_URL",
  ],
  [
    "mixed: KV url + UPSTASH token",
    { KV_REST_API_URL: K_URL, UPSTASH_REDIS_REST_TOKEN: U_TOKEN },
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_URL,KV_REST_API_TOKEN",
  ],
  [
    "partial: UPSTASH url only",
    { UPSTASH_REDIS_REST_URL: U_URL },
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_TOKEN,KV_REST_API_URL,KV_REST_API_TOKEN",
  ],
  [
    "partial: UPSTASH token only",
    { UPSTASH_REDIS_REST_TOKEN: U_TOKEN },
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_URL,KV_REST_API_URL,KV_REST_API_TOKEN",
  ],
  [
    "partial: KV url only",
    { KV_REST_API_URL: K_URL },
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN,KV_REST_API_TOKEN",
  ],
  [
    "nothing",
    {},
    null,
    "store=production-without-redis missing=UPSTASH_REDIS_REST_URL,UPSTASH_REDIS_REST_TOKEN,KV_REST_API_URL,KV_REST_API_TOKEN",
  ],
];
const { redisCredentialPair } = await import("../app/api/_lib/redis-diagnostics.ts");

test("credential pairs: a complete pair only, UPSTASH before KV, never a URL from one and a token from the other", () => {
  for (const [label, env, want] of PAIR_CASES) {
    const got = redisCredentialPair(env, { kvFallback: true });
    if (want === null) {
      assert.equal(got, null, label);
    } else {
      assert.deepEqual(got, { pair: want[0], url: want[1], token: want[2] }, label);
    }
  }
});

test("the store line, dev and production, for every pair case: names only, never a value", () => {
  for (const [label, env, want, prodLine] of PAIR_CASES) {
    const dev = limitModule.inviteStoreLine(env);
    const source = want && want[0] === "KV_REST_API" ? "kv" : "upstash";
    assert.equal(
      dev,
      want
        ? `[invite-password-limit] store=redis source=${source}`
        : "[invite-password-limit] store=memory",
      label,
    );
    const prod = limitModule.inviteStoreLine({ ...env, VERCEL_ENV: "production" });
    assert.equal(prod, `[invite-password-limit] ${prodLine}`, label);
    for (const l of [dev, prod]) {
      assert.match(l, LINE);
      for (const v of VALUES) assert.ok(!l.includes(v), `${label}: leaked ${v}`);
    }
  }
});

test("mixed or partial in production: the store refuses (NO_STORE), it never tries a half pair", async () => {
  for (const [label, env, want] of PAIR_CASES) {
    if (want) continue;
    setInvitePasswordStoresForTests(
      limitModule.defaultAttemptStore({ ...env, VERCEL_ENV: "production" }),
    );
    const { result, lines } = await captured(() => reserveInvitePasswordAttempt(EMAIL));
    assert.deepEqual(result, { ok: false, reason: "unavailable" }, label);
    assert.deepEqual(lines, ["[invite-password-limit] attempt refused reason=NO_STORE"], label);
  }
});

test("mixed or partial in dev: the memory store, which counts and allows", async () => {
  for (const [label, env, want] of PAIR_CASES) {
    if (want) continue;
    setInvitePasswordStoresForTests(limitModule.defaultAttemptStore(env));
    assert.deepEqual(await reserveInvitePasswordAttempt(EMAIL), { ok: true }, label);
  }
});

test("a complete pair builds the lazy Redis store (no call until an attempt), for either pair", () => {
  const memory = limitModule.defaultAttemptStore({}).increment.toString();
  for (const env of [PAIR_CASES[0][1], PAIR_CASES[1][1]]) {
    assert.notEqual(limitModule.defaultAttemptStore(env).increment.toString(), memory);
  }
});

test("production without Redis: still fails closed, now logged as NO_STORE", async () => {
  setInvitePasswordStoresForTests(limitModule.defaultAttemptStore({ VERCEL_ENV: "production" }));
  const { result, lines } = await captured(() => reserveInvitePasswordAttempt(EMAIL));
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
  assert.deepEqual(lines, ["[invite-password-limit] attempt refused reason=NO_STORE"]);
});

test("a failed clear is logged as a reason code and never throws", async () => {
  setInvitePasswordStoresForTests({
    async increment() {
      return 1;
    },
    async clear() {
      throw Object.assign(new Error(`WRONGPASS token ${SECRET_TOKEN} at ${SECRET_URL}`), {
        name: "UpstashError",
      });
    },
  });
  const { lines } = await captured(() => clearInvitePasswordAttempts(EMAIL));
  assert.deepEqual(lines, ["[invite-password-limit] clear failed reason=WRONGPASS"]);
  noValues(lines[0]);
});

test("source: the module builds no client at load, and logs the store once, outside a build", () => {
  const src = readFileSync(new URL("./invite-password-limit.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Redis\.fromEnv\(/);
  assert.equal((code.match(/new Redis\(/g) ?? []).length, 1, "one constructor call");
  assert.match(
    code,
    /inner \?\?= redisAttemptStore\(new Redis\(\{ url, token \}\)\);/,
    "inside the lazy getter",
  );
  assert.match(
    code,
    /if \(process\.env\.NEXT_PHASE !== "phase-production-build"\) \{\s*console\.info\(inviteStoreLine\(process\.env\)\);\s*\}/,
  );
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
