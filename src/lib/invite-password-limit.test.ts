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
import { test } from "node:test";

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
