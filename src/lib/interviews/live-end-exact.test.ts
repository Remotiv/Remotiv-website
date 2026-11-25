/**
 * #23, migration 069: a live interview that runs over is ended at the moment
 * its backstop was DUE, however late the server notices, and the video upload
 * window and the restart hour both count from that stored end.
 *
 * A 30-minute interview started at 00:00 is due to end at 40:00 (its limit
 * plus END_GRACE_MS). Here nothing notices until 43:00, when a video request
 * arrives. The fake database applies 069's rule (endRule "069"); the same run
 * under 044's rule, production's until 069 is applied, shows what 069 changes.
 *
 *   node --test src/lib/interviews/live-end-exact.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__endService; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { reservePieceUpload, confirmPiece } = await import("./live-video.ts");
const { stampOverdueLiveEnds, END_GRACE_MS } = await import("./live-events.ts");
const { restartEligibility } = await import("./live-restart.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000023a1";
const TOKEN = "live-end-exact-token-0123456789abcdef";
const MIN = 60_000;
const DAY = 86_400_000;
const START = Date.parse("2026-11-26T09:00:00.000Z");
const at = (minutes: number) => START + minutes * MIN;
const DUE = at(40);
const iso = (ms: number) => new Date(ms).toISOString();

const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};

/** A started 30-minute live interview; its clock is `clock.now`, the database's and the server's. */
function world(endRule: "044" | "069") {
  const clock = { now: at(0) };
  const db = fakeLiveDb(
    {
      interview_sessions: [
        {
          id: SESSION,
          company_id: "7aad434d-0000-4000-8000-000000000023",
          job_id: null,
          application_id: null,
          kind: "live",
          attempt: 1,
          status: "started",
          token_hash: hashSessionToken(TOKEN),
          expires_at: iso(at(0) + 5 * DAY),
          consent_at: iso(at(-5)),
          consent_version: "live-v1",
          started_at: iso(at(0)),
          provider_session_id: "provider-23",
          // Unreadable settings: the 30-minute default (liveEndDueAt), logged.
          live_settings: null,
          live_outcome: null,
          live_ended_at: null,
          delete_after: iso(at(0) + 180 * DAY),
        },
      ],
      signed_url_logs: [],
    },
    { now: () => clock.now, endRule },
  );
  globalThis.__endService = db.service;
  const deps = {
    service: db.service,
    now: () => clock.now,
    fetchHead: async (url) =>
      db.objects.get(decodeURIComponent(new URL(url).pathname.replace(/^\/signed\//, ""))).bytes,
  };
  const row = () => db.tables.interview_sessions[0];
  const reserve = (piece: number) =>
    quiet(() => reservePieceUpload({ token: TOKEN, piece, mimeType: "video/webm" }, deps));
  const confirm = (piece: number) =>
    quiet(() =>
      confirmPiece(
        {
          token: TOKEN,
          piece,
          mimeType: "video/webm",
          startedAtMs: piece * 120_000,
          durationMs: 120_000,
          last: true,
        },
        deps,
      ),
    );
  const restart = () => {
    const verdict = restartEligibility({ ...row(), decided: false }, clock.now);
    return verdict.eligible ? "eligible" : verdict.code;
  };
  return { clock, db, deps, row, reserve, confirm, restart };
}

/** A piece reserved while the call ran, uploaded; confirmed later by the caller. */
async function pieceInFlight(w) {
  w.clock.now = at(35);
  const r = await w.reserve(0);
  assert.equal(r.status, 200, "reserved while the interview ran");
  const put = await w.db.putSigned(
    r.body.url,
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]),
    "video/webm",
  );
  assert.equal(put.error, null, "uploaded");
}

test("due at 40:00, first noticed at 43:00: the end stored is 40:00 exactly", async () => {
  assert.equal(DUE, at(0) + 30 * MIN + END_GRACE_MS, "the 30-minute limit plus the grace");
  const w = world("069");
  await pieceInFlight(w);
  w.clock.now = at(43);
  assert.equal((await w.reserve(1)).body.code, "not_open", "nothing new after the end");
  assert.equal(w.row().live_ended_at, iso(DUE), "stamped at the due time, not at 43:00");
});

test("upload deadline counts from 40:00: open at 69:59, closed at 70:01 (not 73:00)", async () => {
  const w = world("069");
  await pieceInFlight(w);
  w.clock.now = at(43);
  await w.reserve(1); // the backstop stamps here
  w.clock.now = at(70) - 1000;
  assert.equal((await w.confirm(0)).status, 200, "inside 30 minutes of 40:00");

  const late = world("069");
  await pieceInFlight(late);
  late.clock.now = at(43);
  await late.reserve(1);
  late.clock.now = at(70) + 1000;
  assert.equal((await late.confirm(0)).body.code, "window_closed", "30 minutes after 40:00");
});

test("restart wait counts from 40:00: too soon at 99:59, eligible at 100:01 (not 103:00)", async () => {
  const w = world("069");
  w.clock.now = at(43);
  assert.equal(await quiet(() => stampOverdueLiveEnds(w.db.service, w.deps.now)), 1, "the sweep");
  assert.equal(w.row().live_ended_at, iso(DUE));
  w.clock.now = at(100) - 1000;
  assert.equal(w.restart(), "too_soon");
  w.clock.now = at(100) + 1000;
  assert.equal(w.restart(), "eligible", "an hour after 40:00, with no export");
});

test("under 044 (before 069 is applied) the same run stores 43:00: the gap 069 closes", async () => {
  const w = world("044");
  await pieceInFlight(w);
  w.clock.now = at(43);
  await w.reserve(1);
  assert.equal(w.row().live_ended_at, iso(at(43)), "the noticed time");
  w.clock.now = at(70) + 1000;
  assert.equal((await w.confirm(0)).status, 200, "the window still open past 70:00");
  w.clock.now = at(100) + 1000;
  assert.equal(w.restart(), "too_soon", "the restart still waiting past 100:00");
});

test("the stored end is set once: a later export, sweep or terminal status never moves it", async () => {
  const w = world("069");
  w.clock.now = at(43);
  await quiet(() => stampOverdueLiveEnds(w.db.service, w.deps.now));
  w.clock.now = at(50);
  assert.equal(
    await quiet(() => stampOverdueLiveEnds(w.db.service, w.deps.now)),
    0,
    "nothing left to stamp",
  );
  const { error } = await w.db.service
    .from("interview_sessions")
    .update({ live_ended_at: iso(at(41)) })
    .eq("id", SESSION);
  assert.ok(error, "a direct rewrite is refused");
  await w.db.service.from("interview_sessions").update({ status: "submitted" }).eq("id", SESSION);
  assert.equal(w.row().live_ended_at, iso(DUE), "still 40:00");
});

test("069 keeps a written end only inside [started_at, now()]: anything else is now()", async () => {
  for (const [label, written] of [
    ["in the future", at(60)],
    ["before the call started", at(-1)],
  ]) {
    const w = world("069");
    w.clock.now = at(43);
    await w.db.service
      .from("interview_sessions")
      .update({ live_ended_at: iso(written) })
      .eq("id", SESSION);
    assert.equal(w.row().live_ended_at, iso(at(43)), label);
  }
  const w = world("069");
  w.row().started_at = null;
  w.clock.now = at(43);
  await w.db.service
    .from("interview_sessions")
    .update({ live_ended_at: iso(at(40)) })
    .eq("id", SESSION);
  assert.equal(w.row().live_ended_at, iso(at(43)), "no started_at: now()");
});
