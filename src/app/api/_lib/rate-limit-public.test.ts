/**
 * #57 slice 2: the public group counts in its own Upstash database and never
 * in the main one; the noisy buckets use no Redis at all; a refused request
 * costs no command; and every grouped route's Redis errors are one line a
 * minute, the next line saying how many were held back.
 *
 *   node --test "src/app/api/_lib/rate-limit-public.test.ts"
 *
 * The real rate-limit.ts is loaded afresh for each set of settings (a query
 * string gives a new module instance, so its clients are built again), with
 * @upstash/redis replaced by a fake that records every command with its key
 * and the URL of the client that sent it. Public traffic is recognisable by
 * its key (rl:<bucket>:...), so "the main database got none of it" is checked
 * across every client, whichever URL it was built with. Synthetic values only;
 * nothing leaves the machine.
 */
// @ts-nocheck - same reason as rate-limit-diagnostics.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUB = [
  "class UpstashError extends Error { name = 'UpstashError'; }",
  "globalThis.__built ??= [];",
  "globalThis.__commands ??= [];",
  "globalThis.__modes ??= {};",
  "const counts = new Map();",
  "export class Redis {",
  "  constructor({ url, token }) { this.url = url; globalThis.__built.push(url); }",
  "  answer(cmd, key) {",
  "    globalThis.__commands.push({ url: this.url, cmd, key });",
  "    const mode = globalThis.__modes[this.url] ?? 'ok';",
  "    if (mode === 'conn') return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));",
  "    if (mode === 'budget') return Promise.reject(new UpstashError('ERR max requests limit exceeded. Limit: 0, Usage: 0. command was: ' + cmd));",
  "    if (cmd === 'incr') { const n = (counts.get(this.url + key) ?? 0) + 1; counts.set(this.url + key, n); return Promise.resolve(n); }",
  "    return Promise.resolve(1);",
  "  }",
  "  eval() { return this.answer('eval', null); }",
  "  incr(k) { return this.answer('incr', k); }",
  "  pexpire(k) { return this.answer('pexpire', k); }",
  "}",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@upstash/redis") return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const MAIN_URL = "https://main-db-057.upstash.io";
const MAIN_TOKEN = "AXmainTOKEN057aaaaaaaaaaaaaaaaaaaaa";
const KV_URL = "https://kv-db-057.upstash.io";
const KV_TOKEN = "AXkvTOKEN057bbbbbbbbbbbbbbbbbbbbbbbb";
const PUBLIC_URL = "https://public-db-057.upstash.io";
const PUBLIC_TOKEN = "AXpublicTOKEN057ccccccccccccccccccc";
const NAMES = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "RATE_LIMIT_PUBLIC_REDIS_REST_URL",
  "RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN",
  "VERCEL_ENV",
];
const SECRETS = [MAIN_URL, MAIN_TOKEN, KV_URL, KV_TOKEN, PUBLIC_URL, PUBLIC_TOKEN];

const realNow = Date.now;
let clockNow = Date.parse("2026-11-21T10:00:00.000Z");
Date.now = () => clockNow;
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let loads = 0;
/** rate-limit.ts as a new instance with exactly these settings, and the lines it wrote. */
async function load(env) {
  for (const k of NAMES) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.__built = [];
  globalThis.__commands = [];
  globalThis.__modes = {};
  const lines = [];
  const real = { info: console.info, error: console.error };
  console.info = (...a) => lines.push(`info: ${a.join(" ")}`);
  console.error = (...a) => lines.push(`error: ${a.join(" ")}`);
  const mod = await import(`./rate-limit.ts?load=${++loads}`);
  await settle();
  return { ...mod, lines, restore: () => Object.assign(console, real) };
}

const ip = (n = 1) =>
  new Request("http://localhost/x", { headers: { "x-real-ip": `203.0.113.${n}` } });
/** Rate-limit commands (not the cold-start check) carrying this bucket's keys. */
const sent = (bucket) => globalThis.__commands.filter((c) => c.key?.startsWith(`rl:${bucket}:`));
const sentTo = (url) => globalThis.__commands.filter((c) => c.url === url && c.cmd !== "eval");
const noSecrets = (lines) => {
  for (const l of lines) for (const s of SECRETS) assert.ok(!l.includes(s), `leaked a value: ${l}`);
};

const MAIN = { UPSTASH_REDIS_REST_URL: MAIN_URL, UPSTASH_REDIS_REST_TOKEN: MAIN_TOKEN };
const PUBLIC = {
  RATE_LIMIT_PUBLIC_REDIS_REST_URL: PUBLIC_URL,
  RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: PUBLIC_TOKEN,
};
const PROD = { VERCEL_ENV: "production" };

// ── Isolation ────────────────────────────────────────────────────

// Negative control: let publicRedisClient fall back to the main pair (or
// return redisClient()) and the main database receives rl:apply:... here.
test("public pair missing in production: memory, one error-level store line, nothing sent to the main database", async () => {
  const c = await load({ ...MAIN, ...PROD });
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(c.rateLimit(ip(), { bucketKey: "apply", group: "public" }).ok, true);
    await settle();
    assert.deepEqual(sent("apply"), [], "no command for public traffic, anywhere");
    assert.deepEqual(sentTo(MAIN_URL), []);
    assert.deepEqual(
      c.lines.filter((l) => l.includes("public-store")),
      ["error: [rate-limit] public-store=memory reason=PUBLIC_CREDS_MISSING"],
    );
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

test("a half public pair is missing too", async () => {
  for (const half of [
    { RATE_LIMIT_PUBLIC_REDIS_REST_URL: PUBLIC_URL },
    { RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: PUBLIC_TOKEN },
  ]) {
    const c = await load({ ...MAIN, ...PROD, ...half });
    try {
      c.rateLimit(ip(), { bucketKey: "talent", group: "public" });
      await settle();
      assert.deepEqual(sent("talent"), []);
      assert.ok(
        c.lines.includes("error: [rate-limit] public-store=memory reason=PUBLIC_CREDS_MISSING"),
      );
    } finally {
      c.restore();
    }
  }
});

test("public pair naming the main database: memory, PUBLIC_SAME_AS_SECURITY, nothing sent to it", async () => {
  for (const [label, pub] of [
    [
      "the same pair",
      {
        RATE_LIMIT_PUBLIC_REDIS_REST_URL: MAIN_URL,
        RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: MAIN_TOKEN,
      },
    ],
    [
      "the main URL, another token",
      {
        RATE_LIMIT_PUBLIC_REDIS_REST_URL: `${MAIN_URL}/`,
        RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: PUBLIC_TOKEN,
      },
    ],
    [
      "the main token, another URL",
      {
        RATE_LIMIT_PUBLIC_REDIS_REST_URL: PUBLIC_URL,
        RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: MAIN_TOKEN,
      },
    ],
    [
      "the KV database",
      { RATE_LIMIT_PUBLIC_REDIS_REST_URL: KV_URL, RATE_LIMIT_PUBLIC_REDIS_REST_TOKEN: KV_TOKEN },
    ],
  ]) {
    const c = await load({
      ...MAIN,
      KV_REST_API_URL: KV_URL,
      KV_REST_API_TOKEN: KV_TOKEN,
      ...PROD,
      ...pub,
    });
    try {
      for (let i = 0; i < 3; i++)
        c.rateLimit(ip(), { bucketKey: "chat", group: "public", max: 10 });
      await settle();
      assert.deepEqual(sent("chat"), [], label);
      assert.deepEqual(
        c.lines.filter((l) => l.includes("public-store")),
        ["error: [rate-limit] public-store=memory reason=PUBLIC_SAME_AS_SECURITY"],
        label,
      );
      noSecrets(c.lines);
    } finally {
      c.restore();
    }
  }
});

test("only KV_* set: the main limiter uses it, the public group stays in memory", async () => {
  const c = await load({ KV_REST_API_URL: KV_URL, KV_REST_API_TOKEN: KV_TOKEN, ...PROD });
  try {
    c.rateLimit(ip(), { bucketKey: "ai-matching", group: "public" });
    c.rateLimitByKey("unlock:user-1", { max: 30 });
    await settle();
    assert.deepEqual(sent("ai-matching"), [], "public traffic never reaches KV");
    assert.deepEqual(
      sent("unlock")
        .filter((x) => x.cmd === "incr")
        .map((x) => x.url),
      [KV_URL],
      "the main limiter still counts in KV",
    );
    assert.ok(
      c.lines.includes("error: [rate-limit] public-store=memory reason=PUBLIC_CREDS_MISSING"),
    );
  } finally {
    c.restore();
  }
});

test("both pairs set: public traffic goes to the public database only, main traffic to the main one only", async () => {
  const c = await load({ ...MAIN, ...PUBLIC, ...PROD });
  try {
    c.rateLimit(ip(), { bucketKey: "apply", group: "public" });
    c.rateLimitByKey("interview-confirm:tok", { max: 120, group: "interview" });
    await settle();
    assert.deepEqual(new Set(sent("apply").map((x) => x.url)), new Set([PUBLIC_URL]));
    assert.deepEqual(new Set(sent("interview-confirm").map((x) => x.url)), new Set([MAIN_URL]));
    assert.ok(c.lines.includes("info: [rate-limit] public-store=redis"));
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

// ── Errors fail open, to memory, logged ──────────────────────────

for (const [mode, reason] of [
  ["conn", "ECONNREFUSED"],
  ["budget", "ERR"],
]) {
  test(`public database ${mode === "conn" ? "unreachable" : "out of budget"}: decided from memory (still limited), one line, main untouched`, async () => {
    const c = await load({ ...MAIN, ...PUBLIC, ...PROD });
    try {
      globalThis.__modes[PUBLIC_URL] = mode;
      const got = [];
      for (let i = 0; i < 5; i++) {
        got.push(c.rateLimit(ip(7), { bucketKey: "hire-remote", group: "public", max: 3 }).ok);
        await settle();
      }
      assert.deepEqual(got, [true, true, true, false, false], "memory still holds the limit");
      assert.deepEqual(sentTo(MAIN_URL), [], "no fallback to the main database");
      assert.equal(
        sent("hire-remote").length,
        3,
        "only the allowed requests asked, all of them the public database",
      );
      assert.deepEqual(
        c.lines.filter((l) => l.includes("redis-error")),
        [
          `error: [rate-limit] redis-error route=hire-remote group=public outcome=open reason=${reason}`,
        ],
      );
      noSecrets(c.lines);
      for (const l of c.lines) assert.ok(!l.includes("203.0.113") && !l.includes("command was"), l);
    } finally {
      c.restore();
    }
  });
}

// ── What costs a command ─────────────────────────────────────────

test("memory-only routes send no Redis command at all, with both databases configured", async () => {
  const c = await load({ ...MAIN, ...PUBLIC, ...PROD });
  try {
    for (const bucketKey of ["check-duplicate", "jobs", "track-follow-click", "health-worker"]) {
      for (let i = 0; i < 10; i++) c.rateLimit(ip(), { bucketKey, group: "local", max: 5 });
    }
    await settle();
    assert.deepEqual(
      globalThis.__commands.filter((x) => x.cmd !== "eval"),
      [],
    );
    assert.equal(
      c.rateLimit(ip(), { bucketKey: "jobs", group: "local", max: 5 }).ok,
      false,
      "still limited",
    );
  } finally {
    c.restore();
  }
});

// Negative control: sync to Redis on the refused path too and this burst
// sends 50 commands, not 3.
test("over the limit is refused, and a refused burst sends no command", async () => {
  const c = await load({ ...MAIN, ...PUBLIC, ...PROD });
  try {
    const got = [];
    for (let i = 0; i < 50; i++)
      got.push(c.rateLimit(ip(9), { bucketKey: "check-duplicate-bulk", group: "public", max: 3 }));
    await settle();
    assert.equal(got.filter((r) => r.ok).length, 3);
    const refused = got.filter((r) => !r.ok);
    assert.equal(refused.length, 47);
    assert.ok(refused.every((r) => r.retryAfter >= 1 && r.retryAfter <= 60));
    assert.equal(
      sent("check-duplicate-bulk").filter((x) => x.cmd === "incr").length,
      3,
      "3 INCRs, for the 3 allowed",
    );
  } finally {
    c.restore();
  }
});

// ── Throttled lines ──────────────────────────────────────────────

// Negative control: write every error (no per-route minute) and the first
// assertion sees 100 lines.
test("100 errors on one route in a minute: one line; the next minute's line says suppressed=99; routes apart", async () => {
  const c = await load({ ...MAIN, ...PUBLIC, ...PROD });
  try {
    globalThis.__modes[PUBLIC_URL] = "conn";
    globalThis.__modes[MAIN_URL] = "conn";
    clockNow = Date.parse("2026-11-21T11:00:00.000Z");
    for (let i = 0; i < 100; i++) {
      c.rateLimit(ip(i % 250), { bucketKey: "apply", group: "public", max: 1000 });
      await settle(); // each error lands at its own moment
      clockNow += 500;
    }
    const errors = () => c.lines.filter((l) => l.includes("redis-error"));
    const apply =
      "error: [rate-limit] redis-error route=apply group=public outcome=open reason=ECONNREFUSED";
    assert.deepEqual(errors(), [apply]);

    // Another route, and the interview group, each have their own minute.
    c.rateLimit(ip(), { bucketKey: "talent", group: "public" });
    c.rateLimitByKey("interview-submit:tok", { max: 10, group: "interview" });
    await settle();
    assert.deepEqual(errors(), [
      apply,
      "error: [rate-limit] redis-error route=talent group=public outcome=open reason=ECONNREFUSED",
      "error: [rate-limit] redis-error route=interview-submit group=interview outcome=open reason=ECONNREFUSED",
    ]);

    clockNow = Date.parse("2026-11-21T11:01:00.500Z");
    c.rateLimit(ip(), { bucketKey: "apply", group: "public", max: 1000 });
    await settle();
    assert.equal(errors().at(-1), `${apply} suppressed=99`);
    noSecrets(c.lines);
  } finally {
    c.restore();
  }
});

// ── Census ───────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
/** Every limiter call in the app, as "file  name  group". */
function census() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        const rel = p.slice(SRC.length);
        if (rel === "app/api/_lib/rate-limit.ts" || rel === "app/api/interview/_lib/limits.ts")
          continue;
        const src = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        const re =
          /\b(rateLimit|rateLimitByKey|limitInterview|rateLimitClosed|rateLimitClosedByKey)\(/g;
        for (let m = re.exec(src); m; m = re.exec(src)) {
          let depth = 1;
          let i = m.index + m[0].length;
          for (; depth > 0 && i < src.length; i++)
            depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
          const args = src.slice(m.index + m[0].length, i - 1);
          const byRequest = m[1] === "rateLimit" || m[1] === "rateLimitClosed";
          const name =
            m[1] === "limitInterview"
              ? /"([a-z-]+)"/.exec(args)?.[1]
              : byRequest
                ? /bucketKey: "([a-z-]+)"/.exec(args)?.[1]
                : /`([a-z-]+):/.exec(args)?.[1];
          const group =
            m[1] === "limitInterview"
              ? "interview"
              : m[1].startsWith("rateLimitClosed")
                ? "security-closed"
                : (/group: "([a-z]+)"/.exec(args)?.[1] ?? "UNGROUPED");
          out.push(`${rel}  ${name}  ${group}`);
        }
      }
    }
  };
  walk(join(SRC, "app"));
  walk(join(SRC, "lib"));
  return out.sort();
}

/** Every call site and its group. None is left ungrouped. */
const EXPECTED = [
  // Security (slice 3): 9 fail closed, 12 fail open.
  "app/ai-dashboard/(gated)/team/actions.ts  company-invite  security-closed",
  "app/ai-dashboard/(gated)/team/actions.ts  company-invite-resend  security-closed",
  "app/api/admin/send-invite/route.ts  send-invite  security-closed",
  "app/ai-dashboard/accept/actions.ts  company-accept  security-closed",
  "app/api/claim/initiate/route.ts  claim-initiate  security-closed",
  "app/api/claim/verify/route.ts  claim-verify  security-closed",
  "app/api/claim/pre-fill/route.ts  claim-prefill  security-closed",
  "app/api/admin/extract-cv/route.ts  admin-extract-cv  security-closed",
  "app/api/admin/extract-cv-basic/route.ts  extract-cv-basic  security-closed",
  "app/api/cv/browse/[id]/route.ts  cv-browse  security",
  "app/api/cv/own/[source]/[id]/route.ts  cv-own  security",
  "app/api/cv/company-application/[id]/route.ts  cv-company-application  security",
  "app/api/cv/admin-application/[id]/route.ts  cv-admin-application  security",
  "app/api/cv/admin-remote/[id]/route.ts  cv-admin-remote  security",
  "app/api/cv/admin-talent/[id]/route.ts  cv-admin-talent  security",
  "app/api/cv/admin-batch/[id]/route.ts  cv-admin-batch  security",
  "app/api/cv/client-batch/[id]/route.ts  cv-client-batch  security",
  "app/api/batch-candidate-cv/route.ts  batch-candidate-cv  security",
  "app/api/cv/admin-application/availability/route.ts  cv-admin-availability  security",
  "app/browse-talent/actions.ts  unlock  security",
  "app/browse-talent/actions.ts  save  security",
  // Public, own database (slice 2): 7.
  "app/api/apply/route.ts  apply  public",
  "app/api/talent/route.ts  talent  public",
  "app/api/chat/route.ts  chat  public",
  "app/api/ai-matching/route.ts  ai-matching  public",
  "app/api/check-duplicate-bulk/route.ts  check-duplicate-bulk  public",
  "app/api/hire-remote-profiles/route.ts  hire-remote  public",
  "app/api/hire-remote/candidates/route.ts  hire-remote-candidates  public",
  // Public, memory only (slice 2): 4.
  "app/api/check-duplicate/route.ts  check-duplicate  local",
  "app/api/jobs/route.ts  jobs  local",
  "app/api/track/follow-click/route.ts  track-follow-click  local",
  "app/api/health/worker/route.ts  health-worker  local",
  // Interview (slice 1): 10.
  "app/api/interview/submit/route.ts  interview-submit  interview",
  "app/api/interview/upload-url/route.ts  interview-upload-url  interview",
  "app/api/interview/confirm/route.ts  interview-confirm  interview",
  "app/api/interview/playback/route.ts  interview-playback  interview",
  "app/api/interview/consent/route.ts  interview-consent  interview",
  "app/api/interview/live/start/route.ts  live-start  interview",
  "app/api/interview/live/consent/route.ts  live-consent  interview",
  "app/api/interview/live/event/route.ts  live-event  interview",
  "app/api/interview/live/video-upload-url/route.ts  live-video-upload  interview",
  "app/api/interview/live/video-confirm/route.ts  live-video-confirm  interview",
].sort();

test("census: all 42 limiter call sites have a group, none left ungrouped", () => {
  const found = census();
  assert.equal(EXPECTED.length, 42);
  assert.deepEqual(
    found.filter((l) => l.endsWith("UNGROUPED")),
    [],
    "every site needs a group",
  );
  assert.deepEqual(found, EXPECTED, "a new or changed call site must be classified here");
});

test("teardown", () => {
  Date.now = realNow;
  for (const k of NAMES) delete process.env[k];
  clearInterval(globalThis.__rateLimitCleanup);
  guard.assertNoNetwork();
});
