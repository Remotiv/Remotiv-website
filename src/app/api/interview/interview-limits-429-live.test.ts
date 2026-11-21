/**
 * #57 slice 1: what a live candidate's video goes through when
 * live/video-upload-url or live/video-confirm answers 429. Every piece stays
 * on the page, is tried again on the uploader's own backoff, and is saved
 * once, with the bytes that were recorded.
 *
 *   node --test "src/app/api/interview/interview-limits-429-live.test.ts"
 *
 * Everything from the candidate's screen to the database runs as shipped:
 * the PieceRecorder and httpLiveServer (the page's code), the two route
 * handlers with the real limiter and limits (memory store: no Redis is
 * configured here), and lib/interviews/live-video.ts. The database and bucket
 * are fake-live-db.mjs, which applies migration 044's rules; the recorder and
 * the clock are fakes. Synthetic data only.
 */
// @ts-nocheck - same reason as live-video.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/server": "export const NextResponse = { json(body, init) { return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }); } };",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__videoService; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const realNow = Date.now;
const BASE = Date.parse("2026-11-21T09:00:05.000Z");
/** The wall clock the routes and the limiter read: the run's start plus the fake clock. */
let clockNow = BASE;
Date.now = () => clockNow;
const logs = [];
const realLog = console.log;
const realError = console.error;
console.log = (...a) => logs.push(a.join(" "));
console.error = () => {};

const { limitInterview } = await import("./_lib/limits.ts");
const reserveRoute = (await import("./live/video-upload-url/route.ts")).POST;
const confirmRoute = (await import("./live/video-confirm/route.ts")).POST;
const { PieceRecorder } = await import("../../interview/[token]/_live/video-pieces.ts");
const { httpLiveServer } = await import("../../interview/[token]/_live/live-server.ts");
const { hashSessionToken } = await import("../../../lib/interviews/tokens.ts");
const { fakeLiveDb } = await import("../../../test-support/fake-live-db.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000d7";
const DAY = 86_400_000;
const SEC = 1_000;
const MIN = 60_000;

function fakeClock(start) {
  let now = 0;
  let next = 0;
  const queue = [];
  return {
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
        clockNow = start + now;
        t.fn();
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      }
      now = end;
      clockNow = start + now;
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

/** A MediaRecorder stand-in: a WebM header, then a chunk each second, each piece's bytes kept. */
function recorders(clock) {
  const made = [];
  return {
    made,
    make() {
      const r = {
        bytes: [],
        ondataavailable: null,
        onstop: null,
        started: false,
        start() {
          r.started = true;
          const emit = (b) => {
            r.bytes.push(...b);
            r.ondataavailable?.({ data: new Blob([new Uint8Array(b)]) });
          };
          const n = made.length;
          emit([0x1a, 0x45, 0xdf, 0xa3, n, n, n, n, 9, 9, 9, 9, 9, 9, 9, 9]);
          const tick = () => {
            if (!r.started) return;
            emit(Array(64).fill(n));
            clock.setTimeout(tick, 1000);
          };
          clock.setTimeout(tick, 1000);
        },
        stop() {
          r.started = false;
          r.bytes.push(7);
          r.ondataavailable?.({ data: new Blob([new Uint8Array([7])]) });
          clock.setTimeout(() => r.onstop?.(), 0);
        },
      };
      made.push(r);
      return r;
    },
  };
}

/** One open live interview, the page's server client, and every route answer counted. */
function world(token) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: "7aad434d-0000-4000-8000-0000000000d7",
        job_id: "2d4a8cde-0000-4000-8000-0000000000d7",
        application_id: null,
        kind: "live",
        status: "started",
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE + 5 * DAY).toISOString(),
        consent_at: "2026-10-21T09:00:00.000Z",
        consent_version: "live-v1",
        live_ended_at: null,
        delete_after: new Date(BASE + 180 * DAY).toISOString(),
      },
    ],
    signed_url_logs: [],
  });
  globalThis.__videoService = db.service;
  const answers = { "video-upload-url": [], "video-confirm": [] };
  const call = async (handler, route, init) => {
    const res = await handler(new Request(`https://remotiv.test${route}`, init));
    answers[route.split("/").pop()].push(res.status);
    return res;
  };
  // The page's fetch: the two routes in-process, storage PUT into the fake
  // bucket, and confirm's 16-byte read served from it.
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u === "/api/interview/live/video-upload-url") return call(reserveRoute, u, init);
    if (u === "/api/interview/live/video-confirm") return call(confirmRoute, u, init);
    if (u.startsWith("https://storage.test/upload/")) {
      const bytes = new Uint8Array(await init.body.arrayBuffer());
      const { error } = await db.putSigned(u, bytes, init.headers["content-type"]);
      return new Response(null, { status: error ? 409 : 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(new URL(String(url)).pathname.replace(/^\/signed\//, ""));
    const o = db.objects.get(path);
    return o
      ? new Response(o.bytes.slice(0, 16), { status: 206 })
      : new Response(null, { status: 404 });
  };
  const server = httpLiveServer(token, fetchImpl);
  return { db, server, answers };
}

function run(token, start) {
  clockNow = start;
  const clock = fakeClock(start);
  const rec = recorders(clock);
  const w = world(token);
  const views = [];
  const pr = new PieceRecorder({
    mime: "video/webm",
    sink: w.server.pieces,
    makeRecorder: rec.make,
    now: () => clock.now,
    pieceMs: 10 * SEC,
    clock,
    onChange: (v) => views.push(v),
  });
  return { clock, rec, pr, views, ...w };
}

const confirmedLines = (i) =>
  logs.filter((l) => l === `[live-video] session ${SESSION}: piece ${i} confirmed`).length;

function savedIntact(t, r, n) {
  const rows = r.db.tables.live_video_pieces.filter((p) => p.session_id === SESSION);
  assert.equal(rows.length, n, `${n} pieces`);
  for (let i = 0; i < n; i++) {
    const row = rows.find((p) => p.piece_index === i);
    assert.equal(row?.status, "confirmed", `piece ${i} confirmed`);
    const stored = r.db.objects.get(row.media_path);
    assert.deepEqual([...stored.bytes], r.rec.made[i].bytes, `piece ${i}: the recorded bytes`);
    assert.equal(confirmedLines(i), 1, `piece ${i} confirmed exactly once`);
  }
  assert.equal(r.pr.drained, true);
  assert.equal(r.pr.unsaved, 0);
  t.diagnostic(
    `video-upload-url ${JSON.stringify(count(r.answers["video-upload-url"]))}, video-confirm ${JSON.stringify(count(r.answers["video-confirm"]))}`,
  );
}
/** How many of each status a route answered. */
function count(statuses) {
  const by = {};
  for (const s of statuses) by[s] = (by[s] ?? 0) + 1;
  return by;
}

test("video-upload-url 429 for the rest of the minute: every piece waits, is saved once after it, nothing lost", async (t) => {
  const token = `live-429-reserve-${"r".repeat(48)}`;
  clockNow = BASE;
  while (limitInterview("live-video-upload", token).ok);
  logs.length = 0;
  const r = run(token, BASE);
  r.pr.start();
  await r.clock.advance(35 * SEC);
  assert.ok(r.answers["video-upload-url"].includes(429), "refused while the minute lasts");
  assert.equal(r.db.tables.live_video_pieces.filter((p) => p.session_id === SESSION).length, 0);
  assert.equal(r.pr.unsaved, 4, "the three finished pieces and the one recording, all held");
  r.pr.stop();
  await r.clock.advance(3 * MIN);
  const firstOk = r.answers["video-upload-url"].indexOf(200);
  assert.ok(firstOk > 0, "saved after the refusals");
  savedIntact(t, r, 4);
});

test("video-confirm 429 after the upload: each piece is confirmed once after the minute, from the bytes already stored", async (t) => {
  const token = `live-429-confirm-${"c".repeat(48)}`;
  const start = BASE + 10 * MIN;
  clockNow = start;
  while (limitInterview("live-video-confirm", token).ok);
  logs.length = 0;
  const r = run(token, start);
  r.pr.start();
  await r.clock.advance(25 * SEC);
  assert.equal(
    r.pr.unsaved,
    3,
    "two uploaded but unconfirmed pieces and the one recording, all held",
  );
  r.pr.stop();
  await r.clock.advance(3 * MIN);
  assert.ok(r.answers["video-confirm"].includes(429), "confirm was refused");
  savedIntact(t, r, 3);
});

test("a 429 is retried, never refused for good, and the server's text never reaches the screen", () => {
  const pieces = readFileSync(
    new URL("../../interview/[token]/_live/video-pieces.ts", import.meta.url),
    "utf8",
  );
  assert.match(pieces, /status !== 408 && status !== 429;/, "429 is not permanent");
  const server = readFileSync(
    new URL("../../interview/[token]/_live/live-server.ts", import.meta.url),
    "utf8",
  );
  const block = server.slice(server.indexOf("pieces: {"));
  assert.doesNotMatch(block, /body\.error/, "the piece client keeps status and code only");
  const screens = readFileSync(
    new URL("../../interview/[token]/_live/screens.tsx", import.meta.url),
    "utf8",
  );
  assert.match(screens, /\{SAVING\.failed\}/);
});

test("teardown", () => {
  Date.now = realNow;
  console.log = realLog;
  console.error = realError;
  clearInterval(globalThis.__rateLimitCleanup);
  guard.assertNoNetwork();
});
