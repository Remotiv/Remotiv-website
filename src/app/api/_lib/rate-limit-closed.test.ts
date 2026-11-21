/**
 * #57 slice 3: the security group. Nine limits FAIL CLOSED: decided by the
 * main database with one atomic script per call, refused with a calm sentence
 * when it cannot answer, nothing sent or extracted. Twelve FAIL OPEN to this
 * instance's memory. All of them count in the main database, never the public
 * one.
 *
 *   node --test "src/app/api/_lib/rate-limit-closed.test.ts"
 *
 * rate-limit.ts runs as shipped, loaded afresh per set of settings (a query
 * string gives a new module instance), with @upstash/redis replaced by a fake
 * that keeps counts and expiries on a fake clock and runs the limit script
 * atomically, as Redis does. The nine fail-closed sites (6 routes, 3 server
 * actions) also run as shipped, with every import except the limiter replaced
 * by a recorder, so a test sees exactly which dependency was called before
 * the refusal: none that sends, reads or extracts. Synthetic values only;
 * nothing leaves the machine.
 */
// @ts-nocheck - same reason as rate-limit-diagnostics.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();

const LIMITER = new URL("./rate-limit.ts", import.meta.url).href;
const APP = new URL("../../", import.meta.url);
const SITES = {
  team: "ai-dashboard/(gated)/team/actions.ts",
  accept: "ai-dashboard/accept/actions.ts",
  sendInvite: "api/admin/send-invite/route.ts",
  claimInitiate: "api/claim/initiate/route.ts",
  claimVerify: "api/claim/verify/route.ts",
  claimPrefill: "api/claim/pre-fill/route.ts",
  extract: "api/admin/extract-cv/route.ts",
  extractBasic: "api/admin/extract-cv-basic/route.ts",
};

/** Every value a site imports, by module, read from its source. */
function importsOf(file) {
  const src = readFileSync(new URL(file, APP), "utf8");
  const out = {};
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    if (m[1]) continue;
    const names = m[2]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0]);
    if (!out[m[3]]) out[m[3]] = new Set();
    for (const n of names) out[m[3]].add(n);
  }
  return out;
}
const STUBBED = {};
for (const file of Object.values(SITES)) {
  for (const [spec, names] of Object.entries(importsOf(file))) {
    if (spec === "@/app/api/_lib/rate-limit" || spec.startsWith("node:")) continue;
    if (!spec.startsWith("@/") && !spec.startsWith("next/")) continue;
    if (!STUBBED[spec]) STUBBED[spec] = new Set();
    for (const n of names) STUBBED[spec].add(n);
  }
}
const stubSource = (spec, names) =>
  spec === "next/server"
    ? "export const NextResponse = { json(body, init) { return { status: init?.status ?? 200, body, headers: init?.headers ?? {} }; } };"
    : [...names]
        .map((n) => `export const ${n} = globalThis.__recorder(${JSON.stringify(`${spec}:${n}`)});`)
        .join("\n");
const STUBS = Object.fromEntries(Object.entries(STUBBED).map(([s, n]) => [s, stubSource(s, n)]));

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
const REDIS = [
  "class UpstashError extends Error { name = 'UpstashError'; }",
  "globalThis.__commands ??= [];",
  "globalThis.__modes ??= {};",
  "globalThis.__stores ??= {};",
  "export class Redis {",
  "  constructor({ url }) { this.url = url; }",
  "  store() { return (globalThis.__stores[this.url] ??= new Map()); }",
  "  fail(cmd) {",
  "    const mode = globalThis.__modes[this.url];",
  "    if (mode === 'conn') return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });",
  "    if (mode === 'budget') return new UpstashError('ERR max requests limit exceeded. command was: ' + cmd);",
  "    return null;",
  "  }",
  "  live(key) {",
  "    const s = this.store(); const e = s.get(key);",
  "    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) { s.delete(key); return undefined; }",
  "    return e;",
  "  }",
  // The fail-closed script, run atomically. Whether PEXPIRE runs once or on every
  // call is read from the script text, so changing the script changes this.
  "  eval(script, keys, args) {",
  "    globalThis.__commands.push({ url: this.url, cmd: 'eval', key: keys[0] ?? null });",
  "    const err = this.fail('eval'); if (err) return Promise.reject(err);",
  "    if (!keys.length) return Promise.resolve(1);",
  "    const key = keys[0]; const ms = Number(args[0]);",
  "    const e = this.live(key) ?? { n: 0, expiresAt: null };",
  "    e.n += 1; this.store().set(key, e);",
  "    let ttl = e.expiresAt === null ? -1 : e.expiresAt - Date.now();",
  "    const once = /if ttl < 0 then\\\\s+redis\\\\.call\\\\('PEXPIRE'/.test(script);",
  "    const always = !once && /redis\\\\.call\\\\('PEXPIRE'/.test(script);",
  "    if ((once && ttl < 0) || always) { e.expiresAt = Date.now() + ms; ttl = ms; globalThis.__commands.push({ url: this.url, cmd: 'pexpire', key }); }",
  "    return Promise.resolve([e.n, ttl]);",
  "  }",
  "  incr(key) {",
  "    globalThis.__commands.push({ url: this.url, cmd: 'incr', key });",
  "    const err = this.fail('incr'); if (err) return Promise.reject(err);",
  "    const e = this.live(key) ?? { n: 0, expiresAt: null }; e.n += 1; this.store().set(key, e); return Promise.resolve(e.n);",
  "  }",
  "  pexpire(key, ms) {",
  "    const err = this.fail('pexpire'); if (err) return Promise.reject(err);",
  "    const e = this.live(key); if (e) e.expiresAt = Date.now() + ms; return Promise.resolve(1);",
  "  }",
  "}",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@upstash/redis") return { url: "data:text/javascript," + encodeURIComponent(REDIS), shortCircuit: true };
  if (specifier === "@/app/api/_lib/rate-limit") {
    const phase = context.parentURL ? new URL(context.parentURL).searchParams.get("phase") : null;
    return { url: ${JSON.stringify(LIMITER)} + (phase ? "?phase=" + phase : ""), shortCircuit: true };
  }
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

/** A stand-in for any imported value: records calls, answers any property, is never a promise. */
globalThis.__calls = [];
globalThis.__recorder = function recorder(path) {
  return new Proxy(() => {}, {
    get(_, p) {
      if (p === "then") return undefined;
      if (p === Symbol.toPrimitive) return () => "x";
      return recorder(`${path}.${String(p)}`);
    },
    apply() {
      globalThis.__calls.push(path);
      return recorder(`${path}()`);
    },
  });
};

const MAIN_URL = "https://main-db-057c.upstash.io";
const MAIN_TOKEN = "AXmainTOKEN057ccccccccccccccccccccc";
const PUBLIC_URL = "https://public-db-057c.upstash.io";
const PUBLIC_TOKEN = "AXpublicTOKEN057ddddddddddddddddddd";
const NAMES = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "RATE_LIMIT_PUBLIC_REDIS_REST_URL",
  "RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN",
  "VERCEL_ENV",
];
const MAIN = { UPSTASH_REDIS_REST_URL: MAIN_URL, UPSTASH_REDIS_REST_TOKEN: MAIN_TOKEN };
const PUBLIC = {
  RATE_LIMIT_PUBLIC_REDIS_REST_URL: PUBLIC_URL,
  RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: PUBLIC_TOKEN,
};
const PROD = { VERCEL_ENV: "production" };
const CALM = "Please try again in a minute.";

const realNow = Date.now;
let clockNow = Date.parse("2026-11-21T12:00:00.000Z");
Date.now = () => clockNow;
const lines = [];
const real = { info: console.info, error: console.error };
console.info = (...a) => lines.push(`info: ${a.join(" ")}`);
console.error = (...a) => lines.push(`error: ${a.join(" ")}`);

let phases = 0;
function settings(env) {
  for (const k of NAMES) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.__commands = [];
  globalThis.__modes = {};
  globalThis.__stores = {};
  lines.length = 0;
}
/** A fresh limiter with these settings. */
async function limiter(env) {
  settings(env);
  return import(`./rate-limit.ts?phase=${++phases}`);
}
/** Fresh copies of the nine sites, bound to a fresh limiter with these settings. */
async function sites(env) {
  settings(env);
  const phase = ++phases;
  const load = (file) => import(`${new URL(file, APP).href}?phase=${phase}`);
  const team = await load(SITES.team);
  const accept = await load(SITES.accept);
  const route = async (file) => (await load(file)).POST;
  return {
    "company-invite": () =>
      team.inviteMember({ email: "a@example.test", name: "A", role: "member" }),
    "company-invite-resend": () => team.resendInvite("invite-1"),
    "company-accept": () =>
      accept.sendInviteCode({
        token: "raw-token-1",
        password: "long-enough-1",
        existingAccount: false,
      }),
    "send-invite": await route(SITES.sendInvite),
    "claim-initiate": await route(SITES.claimInitiate),
    "claim-verify": await route(SITES.claimVerify),
    "claim-prefill": await route(SITES.claimPrefill),
    "admin-extract-cv": await route(SITES.extract),
    "extract-cv-basic": await route(SITES.extractBasic),
  };
}
const req = () =>
  new Request("https://remotiv.test/api/x", {
    method: "POST",
    headers: { "x-real-ip": "203.0.113.50", "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.test", token: "t" }),
  });
/** The dependency calls a site may make before its limit is checked. */
const BEFORE_LIMIT = {
  "company-invite": ["@/app/ai-dashboard/lib/company-guards:requireCompanyRole"],
  "company-invite-resend": ["@/app/ai-dashboard/lib/company-guards:requireCompanyRole"],
  "company-accept": ["@/lib/supabase/server:createServiceClient"],
};
const run = async (call) => {
  globalThis.__calls = [];
  const result = await (call.length ? call(req()) : call());
  return { result, calls: [...globalThis.__calls] };
};
const closedLines = () => lines.filter((l) => l.includes("outcome=closed"));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** What each site answers when refused for "unavailable". */
function assertCalm(site, result) {
  if (site === "admin-extract-cv" || site === "extract-cv-basic") {
    assert.equal(result.status, 503, site);
    assert.deepEqual(result.body, { ok: false, error: "rate_limited" }, site);
  } else if (site.startsWith("company-")) {
    assert.equal(result.error, CALM, site);
    assert.ok(result.success === false || result.ok === false, site);
  } else {
    assert.equal(result.status, 503, site);
    assert.deepEqual(result.body, { error: CALM }, site);
    assert.equal(result.headers["Retry-After"], "60", site);
  }
}

// ── The nine sites, when the main database cannot answer ─────────

// Negative control: a catch in rateLimitClosedByKey that returns ok, and every
// site here goes on to its own work (the calls list grows) and answers 200.
for (const [mode, reason] of [
  ["conn", "ECONNREFUSED"],
  ["budget", "ERR"],
]) {
  test(`main database ${mode === "conn" ? "unreachable" : "out of budget"}: each fail-closed site refuses calmly, calls nothing after the limit, logs outcome=closed`, async () => {
    const s = await sites({ ...MAIN, ...PUBLIC, ...PROD });
    globalThis.__modes[MAIN_URL] = mode;
    for (const [site, call] of Object.entries(s)) {
      const { result, calls } = await run(call);
      assertCalm(site, result);
      assert.deepEqual(calls, BEFORE_LIMIT[site] ?? [], `${site}: nothing sent, read or extracted`);
    }
    assert.deepEqual(
      closedLines().map((l) => l.replace(/^error: /, "")),
      Object.keys(s).map(
        (site) =>
          `[rate-limit] redis-error route=${site} group=security outcome=closed reason=${reason}`,
      ),
    );
    for (const l of lines) {
      for (const v of [
        MAIN_URL,
        MAIN_TOKEN,
        PUBLIC_URL,
        PUBLIC_TOKEN,
        "203.0.113",
        "raw-token",
        "command was",
      ]) {
        assert.ok(!l.includes(v), `leaked: ${l}`);
      }
    }
    assert.deepEqual(
      globalThis.__commands.filter((c) => c.url === PUBLIC_URL),
      [],
      "never the public database",
    );
  });
}

test("no main client in production: each fail-closed site refuses calmly with reason NO_STORE", async () => {
  const s = await sites({ ...PUBLIC, ...PROD });
  for (const [site, call] of Object.entries(s)) {
    const { result, calls } = await run(call);
    assertCalm(site, result);
    assert.deepEqual(calls, BEFORE_LIMIT[site] ?? [], site);
  }
  assert.equal(closedLines().length, 9);
  assert.ok(closedLines().every((l) => l.endsWith("reason=NO_STORE")));
  assert.deepEqual(globalThis.__commands, [], "the public database is not a stand-in");
});

test("the main database answering: each site is let through to its own work", async () => {
  const s = await sites({ ...MAIN, ...PROD });
  for (const [site, call] of Object.entries(s)) {
    const { calls } = await run(call);
    assert.ok(calls.length > (BEFORE_LIMIT[site] ?? []).length, `${site} went on past the limit`);
  }
  assert.equal(globalThis.__commands.filter((c) => c.cmd === "eval" && c.key).length, 9);
});

// ── The fail-closed limit itself ─────────────────────────────────

// Negative control: decide from this instance's memory first (Redis in the
// background) and each instance lets 5 through: 10, not 5.
test("two instances sharing one database allow exactly the limit under 50 concurrent calls", async () => {
  settings({ ...MAIN, ...PROD });
  const a = await import(`./rate-limit.ts?phase=${++phases}`);
  const b = await import(`./rate-limit.ts?phase=${++phases}`);
  const calls = Array.from({ length: 50 }, (_, i) =>
    (i % 2 ? a : b).rateLimitClosedByKey("company-invite:co-1", { max: 5, windowMs: 60_000 }),
  );
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.ok(
    results
      .filter((r) => !r.ok)
      .every((r) => r.reason === "limited" && r.retryAfter >= 1 && r.retryAfter <= 60),
  );
});

// Negative control: PEXPIRE on every call (re-arming the expiry) and a steady
// caller is locked out for good after the first window.
test("the window is fixed from its first call, not a lockout: a steady caller is let in again each window", async () => {
  const l = await limiter({ ...MAIN, ...PROD });
  const start = Date.parse("2026-11-21T13:00:00.000Z");
  const allowedAt = [];
  for (let t = 0; t < 3 * 60_000; t += 5_000) {
    clockNow = start + t;
    if (
      (await l.rateLimitClosedByKey("claim-verify:203.0.113.1", { max: 3, windowMs: 60_000 })).ok
    ) {
      allowedAt.push(t / 1000);
    }
  }
  assert.deepEqual(allowedAt, [0, 5, 10, 60, 65, 70, 120, 125, 130]);
  const expiries = globalThis.__commands.filter((c) => c.cmd === "pexpire");
  assert.equal(expiries.length, 3, "the expiry is set once per window");
});

test("already refused by this instance: refused again without asking Redis", async () => {
  const l = await limiter({ ...MAIN, ...PROD });
  clockNow = Date.parse("2026-11-21T14:00:00.000Z");
  const key = "claim-initiate:203.0.113.2";
  for (let i = 0; i < 5; i++) await l.rateLimitClosedByKey(key, { max: 5, windowMs: 60_000 });
  assert.equal((await l.rateLimitClosedByKey(key, { max: 5, windowMs: 60_000 })).ok, false);
  const asked = globalThis.__commands.filter((c) => c.cmd === "eval").length;
  for (let i = 0; i < 20; i++) {
    const r = await l.rateLimitClosedByKey(key, { max: 5, windowMs: 60_000 });
    assert.deepEqual([r.ok, r.reason], [false, "limited"]);
  }
  assert.equal(
    globalThis.__commands.filter((c) => c.cmd === "eval").length,
    asked,
    "20 refusals, 0 commands",
  );
});

// Negative control: send the fail-closed limit to publicRedisClient() and the
// count lands in the public database.
test("fail-closed counts in the main database only, never the public one", async () => {
  const l = await limiter({ ...MAIN, ...PUBLIC, ...PROD });
  await l.rateLimitClosedByKey("company-invite:co-2", { max: 20, windowMs: 60_000 });
  const evals = globalThis.__commands.filter((c) => c.cmd === "eval" && c.key);
  assert.deepEqual(
    evals.map((c) => c.url),
    [MAIN_URL],
  );
  assert.equal(evals[0].key, "rlc:company-invite:co-2");
});

test("local development without Redis: decided from memory, so invites still work", async () => {
  const l = await limiter({});
  const got = [];
  for (let i = 0; i < 4; i++)
    got.push((await l.rateLimitClosedByKey("company-invite:dev", { max: 3, windowMs: 60_000 })).ok);
  assert.deepEqual(got, [true, true, true, false]);
});

// ── The twelve fail-open sites ───────────────────────────────────

test("fail-open security sites with the main database down: memory decides, still limited, one outcome=open line", async () => {
  const l = await limiter({ ...MAIN, ...PUBLIC, ...PROD });
  globalThis.__modes[MAIN_URL] = "conn";
  clockNow = Date.parse("2026-11-21T15:00:00.000Z");
  const got = [];
  for (let i = 0; i < 5; i++) {
    got.push(l.rateLimit(req(), { bucketKey: "cv-browse", max: 3, group: "security" }).ok);
    await settle();
  }
  assert.deepEqual(got, [true, true, true, false, false]);
  assert.deepEqual(
    lines.filter((x) => x.includes("redis-error")),
    [
      "error: [rate-limit] redis-error route=cv-browse group=security outcome=open reason=ECONNREFUSED",
    ],
  );
  assert.deepEqual(
    globalThis.__commands.filter((c) => c.url === PUBLIC_URL),
    [],
  );
});

test("fail-open security sites with no main client in production: memory decides, still limited", async () => {
  const l = await limiter({ ...PUBLIC, ...PROD });
  const got = [];
  for (let i = 0; i < 3; i++)
    got.push(l.rateLimitByKey("unlock:user-1", { max: 2, group: "security" }).ok);
  assert.deepEqual(got, [true, true, false]);
  assert.deepEqual(globalThis.__commands, [], "never the public database");
});

test("teardown", () => {
  Date.now = realNow;
  Object.assign(console, real);
  for (const k of NAMES) delete process.env[k];
  clearInterval(globalThis.__rateLimitCleanup);
  guard.assertNoNetwork();
});
