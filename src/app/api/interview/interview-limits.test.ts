/**
 * #57 slice 1: the candidate interview token routes' limits. A real interview,
 * however fast and however flaky its network, is never refused; a Redis error
 * lets the request through and writes one line; over the limit is refused.
 *
 *   node --test "src/app/api/interview/interview-limits.test.ts"
 *
 * The real limiter (rate-limit.ts) and the real limits (_lib/limits.ts) run as
 * shipped, with @upstash/redis replaced by a fake that either counts in a Map
 * or fails every command the way production's did. The live call drives the
 * real PieceRecorder (video-pieces.ts) on a fake clock. The ten routes are
 * pinned in source: each asks limitInterview for its own limit and answers 429
 * when refused. Synthetic tokens only; nothing leaves the machine.
 */
// @ts-nocheck - same reason as rate-limit-diagnostics.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();

const FAKE_URL = "https://fake-host-057.upstash.io";
const FAKE_TOKEN = "AXyzFAKEtoken057fedcba9876543210";
process.env.UPSTASH_REDIS_REST_URL = FAKE_URL;
process.env.UPSTASH_REDIS_REST_TOKEN = FAKE_TOKEN;

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUB = [
  "class UpstashError extends Error { name = 'UpstashError'; }",
  "const fail = (cmd) => Promise.reject(new UpstashError('WRONGPASS invalid or missing auth token, command was: ' + cmd + ' ${FAKE_TOKEN}'));",
  "const counts = new Map();",
  "globalThis.__redisMode = 'ok';",
  "export class Redis {",
  "  eval() { return globalThis.__redisMode === 'ok' ? Promise.resolve(1) : fail('eval'); }",
  "  incr(k) {",
  "    if (globalThis.__redisMode !== 'ok') return fail('incr ' + k);",
  "    const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return Promise.resolve(n);",
  "  }",
  "  pexpire(k) { return globalThis.__redisMode === 'ok' ? Promise.resolve(1) : fail('pexpire ' + k); }",
  "}",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@upstash/redis") return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const errors = [];
const realError = console.error;
const realInfo = console.info;
console.error = (...a) => errors.push(a.join(" "));
console.info = () => {};

const realNow = Date.now;
let clockNow = Date.parse("2026-11-20T10:00:00.000Z");
Date.now = () => clockNow;

const { INTERVIEW_LIMITS, limitInterview } = await import("./_lib/limits.ts");
const { rateLimitByKey } = await import("../_lib/rate-limit.ts");
const { PieceRecorder, PieceHttpError } = await import(
  "../../interview/[token]/_live/video-pieces.ts"
);

const settle = () => new Promise((r) => setImmediate(r));
const SEC = 1_000;
const MIN = 60_000;
let tokens = 0;
const newToken = () => `tok-${++tokens}-${"x".repeat(60)}`;

const ROUTES = {
  submit: "interview-submit",
  "upload-url": "interview-upload-url",
  confirm: "interview-confirm",
  playback: "interview-playback",
  consent: "interview-consent",
  "live/start": "live-start",
  "live/consent": "live-consent",
  "live/event": "live-event",
  "live/video-upload-url": "live-video-upload",
  "live/video-confirm": "live-video-confirm",
};

test("the decided limits, per interview token", () => {
  assert.deepEqual(INTERVIEW_LIMITS, {
    "interview-submit": { max: 10, windowMs: MIN },
    "interview-upload-url": { max: 120, windowMs: MIN },
    "interview-confirm": { max: 120, windowMs: MIN },
    "interview-playback": { max: 60, windowMs: MIN },
    "interview-consent": { max: 10, windowMs: MIN },
    "live-start": { max: 10, windowMs: MIN },
    "live-consent": { max: 10, windowMs: MIN },
    "live-event": { max: 60, windowMs: 10 * MIN },
    "live-video-upload": { max: 120, windowMs: MIN },
    "live-video-confirm": { max: 120, windowMs: MIN },
  });
});

test("all ten routes ask limitInterview for their own limit and answer 429 when refused", () => {
  for (const [dir, route] of Object.entries(ROUTES)) {
    const src = readFileSync(new URL(`./${dir}/route.ts`, import.meta.url), "utf8");
    assert.match(
      src,
      new RegExp(
        `const rl = limitInterview\\("${route}", token\\);\\s*if \\(!rl\\.ok\\)[\\s\\S]{0,200}429`,
      ),
      dir,
    );
    assert.doesNotMatch(src, /rateLimitByKey|rateLimit\(/, `${dir}: no limit of its own`);
  }
  assert.deepEqual(Object.values(ROUTES).sort(), Object.keys(INTERVIEW_LIMITS).sort());
});

/**
 * The fastest async interview by hand: a recording every 1.5 s (Start now,
 * Done at once, a tiny upload), 40 a minute for 10 minutes. Every fifth one
 * fails and uses all 3 tries, each reaching both upload-url and confirm. The
 * page's 3 s and 8 s backoff is left out, so the calls come faster than real.
 */
async function fastestLoop(limit) {
  const start = clockNow;
  let refused = 0;
  let calls = 0;
  for (let i = 0; i < 400; i++) {
    // Each Redis reply (or error) lands before the next recording, as it would.
    await settle();
    clockNow = start + i * 1.5 * SEC;
    const tries = i % 5 === 4 ? 3 : 1;
    for (let t = 0; t < tries; t++) {
      for (const route of ["interview-upload-url", "interview-confirm"]) {
        calls++;
        if (!limit(route).ok) refused++;
      }
    }
  }
  return { refused, calls };
}

// Negative control: put back 40 per 10 minutes and the loop is refused (the
// second assertion shows this run would see it).
test("the fastest loop, 40 recordings a minute for 10 minutes with 1 in 5 failing 3 times, is never refused", async () => {
  const token = newToken();
  const now = await fastestLoop((route) => limitInterview(route, token));
  assert.equal(now.calls, 1120);
  assert.equal(now.refused, 0);

  const old = newToken();
  const before = await fastestLoop((route) =>
    rateLimitByKey(`${route}:${old}`, { max: 40, windowMs: 10 * MIN }),
  );
  assert.ok(before.refused > 0, `the old 40 per 10 minutes refuses it (${before.refused} refused)`);
});

/** The live call's reserve and confirm through the real limits, with a network switch. */
function liveSink(token) {
  const s = {
    down: false,
    refused: 0,
    calls: [],
    confirmed: new Set(),
    async reserve(index) {
      s.gate("reserve", "live-video-upload");
      return { url: `https://storage.test/upload/s/v${index}.webm` };
    },
    async upload() {
      if (s.down) throw new Error("network");
    },
    async confirm(p) {
      s.gate("confirm", "live-video-confirm");
      s.confirmed.add(p.index);
    },
    gate(step, route) {
      s.calls.push({ route, at: clockNow });
      if (s.down) throw new Error("network");
      if (!limitInterview(route, token).ok) {
        s.refused++;
        throw new PieceHttpError(step, 429);
      }
    },
  };
  return s;
}

function fakeClock(base) {
  let now = 0;
  let next = 0;
  const queue = [];
  const c = {
    get now() {
      return now;
    },
    setTimeout(fn, ms) {
      queue.push({ id: ++next, at: now + ms, fn });
      return next;
    },
    clearTimeout(id) {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = queue[0];
        if (!t || t.at > end) break;
        queue.shift();
        now = t.at;
        clockNow = base + now;
        t.fn();
        await settle();
      }
      now = end;
      clockNow = base + now;
      await settle();
    },
  };
  return c;
}

function recorders(clock) {
  let made = 0;
  return {
    get made() {
      return made;
    },
    make() {
      made++;
      const r = {
        ondataavailable: null,
        onstop: null,
        started: false,
        start() {
          r.started = true;
          const tick = () => {
            if (!r.started) return;
            r.ondataavailable?.({ data: new Blob([new Uint8Array(100)]) });
            clock.setTimeout(tick, 1000);
          };
          clock.setTimeout(tick, 1000);
        },
        stop() {
          r.started = false;
          r.ondataavailable?.({ data: new Blob([new Uint8Array(50)]) });
          clock.setTimeout(() => r.onstop?.(), 0);
        },
      };
      return r;
    },
  };
}

/** The most calls to one route inside any minute. */
function busiestMinute(calls, route) {
  const at = calls.filter((c) => c.route === route).map((c) => c.at);
  return Math.max(0, ...at.map((t) => at.filter((u) => u >= t && u < t + MIN).length));
}

test("a full live call, 200 pieces on a network that drops for 20 s in every 23 s, saves every piece and is never refused", async (t) => {
  const token = newToken();
  const clock = fakeClock(clockNow);
  const rec = recorders(clock);
  const sink = liveSink(token);
  const pr = new PieceRecorder({
    mime: "video/webm",
    sink,
    makeRecorder: rec.make,
    now: () => clock.now,
    clock,
  });
  // Up for 3 s, down for 20 s, for the whole call.
  let flapping = true;
  const flap = () => {
    if (!flapping) return;
    sink.down = !sink.down;
    clock.setTimeout(flap, sink.down ? 20 * SEC : 3 * SEC);
  };
  clock.setTimeout(flap, 3 * SEC);
  pr.start();
  await clock.advance(199 * 30 * SEC + 15 * SEC);
  pr.stop();
  await clock.advance(10 * MIN);
  flapping = false;
  sink.down = false;
  await clock.advance(10 * MIN);
  assert.equal(rec.made, 200, "200 pieces recorded");
  assert.equal(sink.confirmed.size, 200, "every piece saved");
  assert.equal(sink.refused, 0, "no 429");
  assert.equal(pr.drained, true);
  for (const route of ["live-video-upload", "live-video-confirm"]) {
    t.diagnostic(
      `${route}: ${sink.calls.filter((c) => c.route === route).length} calls, at most ${busiestMinute(sink.calls, route)} in any minute`,
    );
  }
});

// Negative control: refuse on a Redis error (close the bucket in the error
// handler) and the second call here is refused, and so is the loop below.
test("Redis down: every request is still allowed; one line a minute per route, then the count held back, no token", async () => {
  globalThis.__redisMode = "fail";
  errors.length = 0;
  const token = newToken();
  const got = [];
  for (let i = 0; i < 5; i++) {
    got.push(limitInterview("interview-upload-url", token).ok);
    await settle();
    await settle();
  }
  const line =
    "[rate-limit] redis-error route=interview-upload-url group=interview outcome=open reason=WRONGPASS";
  assert.deepEqual(errors, [line], "5 errors in a minute: one line (#57 slice 2 throttling)");
  clockNow += MIN;
  got.push(limitInterview("interview-upload-url", token).ok);
  await settle();
  await settle();
  globalThis.__redisMode = "ok";
  assert.deepEqual(got, [true, true, true, true, true, true]);
  assert.deepEqual(errors, [line, `${line} suppressed=4`]);
  for (const l of errors) {
    for (const s of [token.slice(0, 10), FAKE_URL, FAKE_TOKEN, "command was"]) {
      assert.ok(!l.includes(s), `leaked ${s}: ${l}`);
    }
  }
});

test("Redis down for a whole fastest loop: never refused", async () => {
  globalThis.__redisMode = "fail";
  const token = newToken();
  const { refused } = await fastestLoop((route) => limitInterview(route, token));
  await settle();
  globalThis.__redisMode = "ok";
  assert.equal(refused, 0);
});

test("over the limit is refused, with a wait inside the window", () => {
  const token = newToken();
  clockNow = Date.parse("2026-11-20T12:00:00.000Z");
  for (let i = 0; i < 120; i++)
    assert.equal(limitInterview("interview-upload-url", token).ok, true);
  const refused = limitInterview("interview-upload-url", token);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60);
  for (let i = 0; i < 60; i++) assert.equal(limitInterview("live-event", token).ok, true);
  const event = limitInterview("live-event", token);
  assert.equal(event.ok, false);
  assert.ok(event.retryAfter > 60 && event.retryAfter <= 600, "live/event's window is 10 minutes");
  // Another token is not affected.
  assert.equal(limitInterview("interview-upload-url", newToken()).ok, true);
});

test("teardown", () => {
  Date.now = realNow;
  console.error = realError;
  console.info = realInfo;
  clearInterval(globalThis.__rateLimitCleanup);
  guard.assertNoNetwork();
});
