/**
 * The candidate's camera video in an AI Video Interview (migration 044):
 * the two candidate-screen endpoints (lib/interviews/live-video.ts), the
 * 6-month purge and orphan sweep (purge.ts), and the review page's player
 * (live-review.ts, live-video-timeline.ts, _live-review-client.tsx). The
 * database and bucket are fake-live-db.mjs, which applies 044's rules. The
 * live consent text is stubbed as final so recording can be exercised; the
 * real text still refuses everything (live-consent.test.ts).
 *
 *   node --test src/lib/interviews/live-video.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__videoService; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { throw new Error('test: pass a scope'); }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
  ].join("\\n"),
  "@/app/admin/lib/role-guards": "export async function requireSuperAdmin() { throw new Error('test: no super admin'); }",
  "next/navigation": "export function useRouter() { return { refresh() {} }; }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
  "../live-actions": "export async function getLiveTurnAudioUrl() { return { ok: false, error: 'test' }; } export async function runLiveReviewAction() { return { ok: true }; } export async function getLiveVideoPieceUrl() { return { ok: false, error: 'test' }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const { reservePieceUpload, confirmPiece, piecePath, PIECE_MAX_BYTES } = await import(
  "./live-video.ts"
);
const { videoTimeline, videoPositionAt, GAP_TOLERANCE_MS } = await import(
  "./live-video-timeline.ts"
);
const { signLiveVideoPiece, buildLiveReviewView } = await import("./live-review.ts");
const { handleInterviewPurge } = await import("./purge.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { LiveReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client.tsx"
);
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "7aad434d-0000-4000-8000-000000000001";
const OTHER_CO = "7aad434d-0000-4000-8000-000000000002";
const JOB = "2d4a8cde-0000-4000-8000-0000000000aa";
const OTHER_JOB = "2d4a8cde-0000-4000-8000-0000000000ab";
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000a1";
const TOKEN = "live-video-test-token-0123456789abcdef";
const DAY = 86_400_000;
const withHead = (head, n) => {
  const bytes = new Uint8Array(n).fill(7);
  bytes.set(head.slice(0, n));
  return bytes;
};
const WEBM = (n = 64) => withHead([0x1a, 0x45, 0xdf, 0xa3], n);
const MP4 = (n = 64) => withHead([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], n);

function session(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    job_id: JOB,
    application_id: null,
    kind: "live",
    status: "started",
    token_hash: hashSessionToken(TOKEN),
    expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
    consent_at: "2026-10-21T09:00:00.000Z",
    consent_version: "live-v1",
    live_ended_at: null,
    delete_after: new Date(Date.now() + 180 * DAY).toISOString(),
    ...over,
  };
}

function world(over = {}, extraSessions = []) {
  const db = fakeLiveDb({
    interview_sessions: [session(over), ...extraSessions],
    signed_url_logs: [],
  });
  globalThis.__videoService = db.service;
  // The 16-byte read confirm does, served from the fake bucket.
  const heads = { fail: 0 };
  const fetchHead = async (url) => {
    if (heads.fail > 0) {
      heads.fail -= 1;
      throw new Error("storage unreachable");
    }
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/signed\//, ""));
    return db.objects.get(path).bytes.slice(0, 16);
  };
  const deps = { service: db.service, fetchHead };
  return { db, deps, heads };
}

const reserve = (deps, piece, mimeType = "video/webm", token = TOKEN) =>
  reservePieceUpload({ token, piece, mimeType }, deps);
const confirm = (deps, piece, extra = {}) =>
  confirmPiece(
    {
      token: TOKEN,
      piece,
      mimeType: "video/webm",
      startedAtMs: piece * 120_000,
      durationMs: 120_000,
      ...extra,
    },
    deps,
  );
const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};

/** What the screen does for one piece: reserve, upload, confirm. */
async function record(w, piece, { bytes = WEBM(), mime = "video/webm", extra = {} } = {}) {
  const r = await reserve(w.deps, piece, mime);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const put = await w.db.putSigned(r.body.url, bytes, mime);
  assert.equal(put.error, null, "upload");
  return quiet(() => confirm(w.deps, piece, { mimeType: mime, ...extra }));
}
const pieces = (db) => db.tables.live_video_pieces.filter((p) => p.session_id === SESSION);
const piece = (db, i) => pieces(db).find((p) => p.piece_index === i);

/* ── who may upload ───────────────────────────────────────────── */

test("only this live session's link, with saved live-v1 consent", async () => {
  for (const [label, over] of [
    ["no consent", { consent_at: null, consent_version: null }],
    ["the async consent version", { consent_version: "v2" }],
  ]) {
    const w = world(over);
    const r = await reserve(w.deps, 0);
    assert.deepEqual([r.status, r.body.code], [403, "consent_required"], label);
    const c = await confirm(w.deps, 0);
    assert.deepEqual([c.status, c.body.code], [403, "consent_required"], label);
    assert.equal(pieces(w.db).length, 0, `${label}: nothing reserved`);
  }
  const w = world({ kind: "async" });
  assert.deepEqual((await reserve(w.deps, 0)).body.code, "not_found", "an async session's link");
  const w2 = world();
  assert.deepEqual(
    (await reserve(w2.deps, 0, "video/webm", "an-unknown-token-0123456789")).body.code,
    "not_found",
  );
});

test("an open interview: invited or started, not ended, not past its link's expiry", async () => {
  assert.equal((await reserve(world({ status: "invited" }).deps, 0)).status, 200);
  assert.equal((await reserve(world({ status: "started" }).deps, 0)).status, 200);
  for (const [label, over] of [
    ["link expired", { expires_at: new Date(Date.now() - 1000).toISOString() }],
    ["cancelled", { status: "cancelled" }],
    [
      "abandoned long ago",
      { status: "abandoned", live_ended_at: new Date(Date.now() - DAY).toISOString() },
    ],
  ]) {
    const w = world(over);
    const r = await reserve(w.deps, 0);
    assert.deepEqual([r.status, r.body.code], [409, "not_open"], label);
    assert.equal(pieces(w.db).length, 0, label);
  }
});

/* ── reserve, upload, confirm ─────────────────────────────────── */

test("reserving: one row per piece at its exact path, create-only URLs, a refresh gets a fresh URL", async () => {
  const w = world();
  const a = await reserve(w.deps, 0);
  assert.equal(a.status, 200);
  assert.deepEqual(
    [a.body.path, piece(w.db, 0).media_path, piece(w.db, 0).status],
    ["v0.webm", piecePath(SESSION, 0, "video/webm"), "pending"],
  );
  const b = await reserve(w.deps, 0);
  assert.equal(b.status, 200, "asking again (a page refresh) gives a fresh URL");
  assert.equal(pieces(w.db).length, 1, "no duplicate");
  assert.ok(
    w.db.signedUploads.length === 2 && w.db.signedUploads.every((u) => u.upsert === false),
    "create-only",
  );
  assert.deepEqual(
    (await reserve(w.deps, 0, "video/mp4")).body.code,
    "bad_piece",
    "the type is fixed at the start",
  );
  assert.equal((await reserve(w.deps, 1, "video/mp4")).status, 200);
  assert.equal(piece(w.db, 1).media_path, `${SESSION}/v1.mp4`);
  for (const bad of [-1, 200, 1.5, "x"]) {
    assert.deepEqual((await reserve(w.deps, bad)).body.code, "bad_piece", String(bad));
  }
  assert.deepEqual((await reserve(w.deps, 2, "audio/webm")).body.code, "bad_piece");
});

test("confirming: the file is checked; a bad one is removed and can be uploaded again", async () => {
  const w = world();
  assert.deepEqual((await confirm(w.deps, 0)).body.code, "not_reserved");
  await reserve(w.deps, 0);
  assert.deepEqual((await confirm(w.deps, 0)).body.code, "not_uploaded", "nothing arrived");

  const url = (await reserve(w.deps, 0)).body.url;
  await w.db.putSigned(url, new Uint8Array(0), "video/webm");
  assert.deepEqual(
    [(await quiet(() => confirm(w.deps, 0))).status, piece(w.db, 0).status],
    [400, "pending"],
  );
  assert.equal(w.db.objects.has(piece(w.db, 0).media_path), false, "the empty file was removed");

  await w.db.putSigned(
    (await reserve(w.deps, 0)).body.url,
    Uint8Array.from("not a video at all"),
    "video/webm",
  );
  assert.deepEqual(
    (await quiet(() => confirm(w.deps, 0))).body.code,
    "not_video",
    "the first bytes are checked",
  );

  await w.db.putSigned((await reserve(w.deps, 0)).body.url, WEBM(), "video/mp4");
  assert.deepEqual(
    (await quiet(() => confirm(w.deps, 0))).body.code,
    "not_video",
    "stored type must match",
  );

  await w.db.putSigned(
    (await reserve(w.deps, 0)).body.url,
    WEBM(PIECE_MAX_BYTES + 1),
    "video/webm",
  );
  assert.deepEqual((await quiet(() => confirm(w.deps, 0))).status, 413);

  for (const extra of [
    { durationMs: 180_001 },
    { durationMs: 0 },
    { startedAtMs: -1 },
    { startedAtMs: 1.5 },
  ]) {
    assert.deepEqual(
      (await confirm(w.deps, 0, extra)).body.code,
      "bad_timing",
      JSON.stringify(extra),
    );
  }

  const ok = await record(w, 0, { extra: { startedAtMs: 1500, durationMs: 119_000, last: true } });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  const row = piece(w.db, 0);
  assert.deepEqual(
    [row.status, row.bytes, row.started_ms, row.duration_ms, row.is_last],
    ["confirmed", 64, 1500, 119_000, true],
  );
  assert.deepEqual(
    await confirm(w.deps, 0),
    { status: 200, body: { ok: true } },
    "confirming again is ok",
  );
  assert.equal(pieces(w.db).length, 1);
  assert.equal(piece(w.db, 0).started_ms, 1500, "a repeat confirm changes nothing");

  const mp4 = await record(w, 1, { bytes: MP4(), mime: "video/mp4" });
  assert.equal(mp4.status, 200, "Safari's mp4 pieces too");
});

/* ── safeguard B: never replaced ──────────────────────────────── */

test("B: an old upload URL can never replace a confirmed piece", async () => {
  const w = world();
  const oldUrl = (await reserve(w.deps, 0)).body.url;
  await w.db.putSigned(oldUrl, WEBM(), "video/webm");
  assert.equal((await quiet(() => confirm(w.deps, 0))).status, 200);
  const stored = w.db.objects.get(piece(w.db, 0).media_path).bytes.slice();
  const replace = await w.db.putSigned(oldUrl, WEBM(999), "video/webm");
  assert.ok(replace.error, "the create-only URL refuses an existing file");
  assert.deepEqual(
    w.db.objects.get(piece(w.db, 0).media_path).bytes,
    stored,
    "the stored piece is untouched",
  );
  assert.deepEqual(
    await reserve(w.deps, 0),
    { status: 200, body: { alreadyConfirmed: true } },
    "no new URL for it",
  );
  // And the row itself cannot be rewritten (044's guard, mirrored by the fake).
  const { error } = await w.db.service
    .from("live_video_pieces")
    .update({ bytes: 1 })
    .eq("session_id", SESSION);
  assert.ok(error);
});

/* ── safeguard A: the end of the interview ────────────────────── */

test("A: after the end, pieces already started can still upload for 30 minutes; nothing new, nothing after", async () => {
  const w = world();
  assert.equal((await record(w, 0)).status, 200, "during the interview");
  const inFlight = (await reserve(w.deps, 1)).body.url; // started recording before the end
  await w.db.service.from("interview_sessions").update({ status: "submitted" }).eq("id", SESSION);
  assert.ok(
    w.db.tables.interview_sessions[0].live_ended_at,
    "the end is stamped by the status change",
  );

  assert.deepEqual((await reserve(w.deps, 2)).body.code, "not_open", "no new piece after the end");
  assert.equal(pieces(w.db).length, 2);
  const fresh = await reserve(w.deps, 1);
  assert.equal(fresh.status, 200, "a piece started before the end gets a fresh URL in the window");
  await w.db.putSigned(inFlight, WEBM(), "video/webm");
  assert.deepEqual((await quiet(() => confirm(w.deps, 1, { last: true }))).body, { ok: true });

  // 31 minutes after the end (test-only: the fake's clock cannot move).
  const w2 = world();
  await reserve(w2.deps, 0);
  await w2.db.putSigned((await reserve(w2.deps, 0)).body.url, WEBM(), "video/webm");
  w2.db.tables.interview_sessions[0].status = "submitted";
  w2.db.tables.interview_sessions[0].live_ended_at = new Date(
    Date.now() - 31 * 60_000,
  ).toISOString();
  assert.deepEqual((await confirm(w2.deps, 0)).body.code, "window_closed");
  assert.deepEqual((await reserve(w2.deps, 0)).body.code, "not_open", "no URL either");
  assert.equal(piece(w2.db, 0).status, "pending");
});

test("A: an interview that ended with no recorded end gets no window at all", async () => {
  const w = world();
  await w.db.putSigned((await reserve(w.deps, 0)).body.url, WEBM(), "video/webm");
  w.db.tables.interview_sessions[0].status = "abandoned"; // test-only: past the stamp
  assert.deepEqual((await confirm(w.deps, 0)).body.code, "window_closed");
});

/* ── safeguard D: what goes wrong in real interviews ──────────── */

test("D: a page refresh mid-interview: saved pieces stay saved, the current one restarts cleanly", async () => {
  const w = world();
  await record(w, 0);
  await record(w, 1);
  await reserve(w.deps, 2); // recording when the page refreshed; nothing uploaded
  // The page comes back and asks again for every piece it knows about.
  assert.deepEqual((await reserve(w.deps, 0)).body, { alreadyConfirmed: true });
  assert.deepEqual((await reserve(w.deps, 1)).body, { alreadyConfirmed: true });
  const again = await reserve(w.deps, 2);
  assert.equal(again.status, 200);
  assert.equal(pieces(w.db).length, 3, "no duplicate rows");
  await w.db.putSigned(again.body.url, WEBM(), "video/webm");
  assert.equal((await quiet(() => confirm(w.deps, 2))).status, 200);
});

test("D: camera or microphone disconnected: a short piece is kept, the next one continues, a lost one is a gap", async () => {
  const w = world();
  await record(w, 0);
  // The device dropped 15 seconds into piece 1: the screen stops it there and saves it.
  assert.equal(
    (await record(w, 1, { extra: { startedAtMs: 120_000, durationMs: 15_000 } })).status,
    200,
  );
  // Piece 2 started while the device was gone and never uploaded.
  await reserve(w.deps, 2);
  // After reconnecting, piece 3 carries on.
  await record(w, 3, { extra: { startedAtMs: 300_000, durationMs: 120_000, last: true } });
  const t = videoTimeline(pieces(w.db));
  assert.deepEqual(t.missingPieces, [2]);
  assert.equal(t.complete, false);
  assert.deepEqual(t.gaps, [
    { fromMs: 135_000, toMs: 300_000 },
    { fromMs: 420_000, toMs: null },
  ]);
});

test("D: a confirm that fails on our side, then the retry: nothing is lost", async () => {
  const w = world();
  await w.db.putSigned((await reserve(w.deps, 0)).body.url, WEBM(), "video/webm");
  w.heads.fail = 1;
  const first = await quiet(() => confirm(w.deps, 0));
  assert.deepEqual(
    [first.status, first.body.code, piece(w.db, 0).status],
    [502, "unavailable", "pending"],
  );
  assert.ok(w.db.objects.has(piece(w.db, 0).media_path), "the uploaded file is kept for the retry");
  w.db.failNext("live_video_pieces", "update");
  const second = await quiet(() => confirm(w.deps, 0));
  assert.equal(second.status, 409, "a refused write is reported, not hidden");
  const third = await quiet(() => confirm(w.deps, 0));
  assert.deepEqual([third.body, piece(w.db, 0).status], [{ ok: true }, "confirmed"]);
});

test("D: missing pieces are shown as gaps; a complete recording has none", () => {
  const row = (i, started, dur, extra = {}) => ({
    piece_index: i,
    status: "confirmed",
    started_ms: started,
    duration_ms: dur,
    is_last: false,
    media_path: `x/v${i}.webm`,
    ...extra,
  });
  const complete = videoTimeline([
    row(0, 0, 120_000),
    row(1, 120_400, 120_000),
    row(2, 240_900, 60_000, { is_last: true }),
  ]);
  assert.deepEqual([complete.complete, complete.gaps, complete.missingPieces], [true, [], []]);
  assert.ok(GAP_TOLERANCE_MS >= 1000, "a recorder restart is not a gap");
  const holes = videoTimeline([
    row(0, 0, 120_000),
    {
      piece_index: 1,
      status: "pending",
      started_ms: null,
      duration_ms: null,
      is_last: false,
      media_path: "x/v1.webm",
    },
    row(3, 360_000, 120_000, { is_last: true }),
  ]);
  assert.deepEqual(holes.missingPieces, [1, 2]);
  assert.deepEqual(holes.gaps, [
    { fromMs: 120_000, toMs: 360_000 },
    { fromMs: 480_000, toMs: null },
  ]);
  assert.equal(holes.complete, false);
  assert.deepEqual(videoTimeline([]), {
    recorded: false,
    pieces: [],
    gaps: [],
    missingPieces: [],
    complete: false,
    purged: false,
  });
});

/* ── the 6-month purge and the orphan sweep ───────────────────── */

test("purge: a due session's pieces go, rows keep no path; confirmed pieces are kept by the orphan sweep", async () => {
  const DUE = "5b0f2c1e-0000-4000-8000-0000000000d2";
  const w = world({}, [
    session({
      id: DUE,
      token_hash: hashSessionToken(`${TOKEN}-due`),
      delete_after: new Date(Date.now() - DAY).toISOString(),
    }),
  ]);
  await record(w, 0);
  await reserve(w.deps, 1); // reserved, never uploaded
  const dueDeps = { ...w.deps };
  const dueReserve = (i) =>
    reservePieceUpload({ token: `${TOKEN}-due`, piece: i, mimeType: "video/webm" }, dueDeps);
  const dueUrl = (await dueReserve(0)).body.url;
  await w.db.putSigned(dueUrl, WEBM(), "video/webm");
  await quiet(() =>
    confirmPiece(
      { token: `${TOKEN}-due`, piece: 0, mimeType: "video/webm", startedAtMs: 0, durationMs: 1000 },
      dueDeps,
    ),
  );
  await dueReserve(1);
  // An unconfirmed upload and a stray file in the live session's folder, both older than a day.
  await w.db.putSigned((await reserve(w.deps, 1)).body.url, WEBM(), "video/webm");
  await w.db.service.storage
    .from("interview-videos")
    .upload(`${SESSION}/v9.webm`, WEBM(), { contentType: "video/webm" });
  for (const path of w.db.objects.keys()) w.db.age(path, 2 * DAY);

  await quiet(() => handleInterviewPurge({ id: "purge-1", payload: {} }));

  const due = w.db.tables.live_video_pieces.filter((p) => p.session_id === DUE);
  assert.ok(
    due.length === 2 && due.every((p) => p.media_path === null && p.content_purged_at),
    "due rows cleared",
  );
  assert.ok(![...w.db.objects.keys()].some((k) => k.startsWith(`${DUE}/`)), "due files gone");
  assert.ok(w.db.objects.has(`${SESSION}/v0.webm`), "a confirmed piece is referenced, kept");
  assert.equal(w.db.objects.has(`${SESSION}/v1.webm`), false, "an unconfirmed upload is an orphan");
  assert.equal(w.db.objects.has(`${SESSION}/v9.webm`), false, "a stray file is an orphan");
  assert.equal(
    piece(w.db, 0).media_path,
    `${SESSION}/v0.webm`,
    "the later session's rows are untouched",
  );
});

/* ── the review page ──────────────────────────────────────────── */

const ctxOf = (role, over = {}) => ({
  user: { id: `u-${role}`, email: `${role}@company.test` },
  companyId: CO,
  role,
  memberName: role,
  ...over,
});

test("review links: gated by company and hiring team, 5 minutes, logged, never a path", async () => {
  const w = world({ application_id: "03e4863f-0000-4000-8000-0000000000aa" });
  await record(w, 0);
  await reserve(w.deps, 1);
  const all = async () => ({ scoped: false });
  const team = (ids) => async () => ({ scoped: true, jobIds: ids });
  const ok = await signLiveVideoPiece(ctxOf("recruiter"), SESSION, 0, {
    service: w.db.service,
    scope: team([JOB]),
  });
  assert.equal(ok.ok, true);
  assert.match(ok.url, /\?ttl=300$/);
  assert.equal(w.db.tables.signed_url_logs.at(-1).source_table, "live_video_pieces");
  assert.equal(
    (
      await signLiveVideoPiece(ctxOf("recruiter"), SESSION, 0, {
        service: w.db.service,
        scope: team([OTHER_JOB]),
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await signLiveVideoPiece(ctxOf("owner", { companyId: OTHER_CO }), SESSION, 0, {
        service: w.db.service,
        scope: all,
      })
    ).ok,
    false,
  );
  assert.deepEqual(
    await signLiveVideoPiece(ctxOf("owner"), SESSION, 1, { service: w.db.service, scope: all }),
    {
      ok: false,
      error: "That part of the video wasn't saved.",
    },
  );
  // The timeline the page is sent carries no path.
  const t = JSON.stringify(videoTimeline(pieces(w.db)));
  assert.doesNotMatch(t, /media_path|\/v\d\.webm|5b0f2c1e/);
  // No application: signed_url_logs cannot hold the grant, so there is no link (F4).
  w.db.tables.interview_sessions[0].application_id = null;
  const grants = w.db.tables.signed_url_logs.length;
  assert.deepEqual(
    await signLiveVideoPiece(ctxOf("owner"), SESSION, 0, { service: w.db.service, scope: all }),
    {
      ok: false,
      error: "This recording can't be opened: no applicant is linked to the interview.",
    },
  );
  assert.equal(w.db.tables.signed_url_logs.length, grants);
});

test("jump to a quote: its moment on the conversation clock maps to the right piece, by started_ms", () => {
  const p = [
    { index: 0, startedMs: 2_000, durationMs: 120_000, hasVideo: true },
    { index: 1, startedMs: 122_500, durationMs: 120_000, hasVideo: true },
    { index: 3, startedMs: 400_000, durationMs: 60_000, hasVideo: true },
  ];
  assert.deepEqual(videoPositionAt(62_000, p), { index: 0, offsetSeconds: 60 });
  assert.deepEqual(
    videoPositionAt(122_500, p),
    { index: 1, offsetSeconds: 0 },
    "at a boundary: the next piece",
  );
  assert.deepEqual(videoPositionAt(130_000, p), { index: 1, offsetSeconds: 7.5 });
  assert.equal(videoPositionAt(300_000, p), null, "in a gap: no video");
  assert.equal(videoPositionAt(1_000, p), null, "before the first piece");
});

function reviewInput(videoPieces) {
  const t = (id, sequence, speaker, kind, position, text, offset, extra = {}) => ({
    id,
    sequence,
    speaker,
    kind,
    question_position: position,
    responds_to_turn_id: null,
    text: speaker === "interviewer" ? text : null,
    transcript: speaker === "candidate" ? text : null,
    transcript_status: speaker === "candidate" ? "done" : null,
    transcript_segments:
      speaker === "candidate" ? [{ start: 3, end: 8, text, noSpeech: 0.01 }] : null,
    transcript_error: null,
    media_path: `s/t${sequence}.wav`,
    content_purged_at: null,
    offset_ms: offset,
    ...extra,
  });
  const facts = {
    position: 1,
    source: "job",
    status: "answered",
    confirmed: true,
    follow_ups: 0,
    repeats: 0,
    answer_ms: 5000,
    wording_check: null,
    needs_check: false,
  };
  return {
    session: {
      id: SESSION,
      live_settings: { interviewer_name: "Sarah" },
      live_outcome: {
        final: true,
        outcome: "completed",
        questions: [facts],
        answered_count: 1,
        skipped_count: 0,
        total: 1,
        completion_percent: 100,
      },
    },
    frozenQuestions: [{ position: 1, source: "job", text: "Tell me about a migration you led." }],
    turns: [
      t("a", 1, "interviewer", "base_question", 1, "Tell me about a migration you led.", 50_000),
      {
        ...t(
          "b",
          2,
          "candidate",
          null,
          null,
          "I led the migration myself over two months.",
          58_000,
        ),
        responds_to_turn_id: "a",
      },
    ],
    actions: [],
    row: {
      status: "scored",
      overall_score: 80,
      questions: [
        {
          position: 1,
          source: "job",
          competency: "Ownership",
          weight: 1,
          status: "scored",
          reason: "answered",
          score: 80,
          confidence: "high",
          rationale: "Specific.",
          quotes: ["led the migration myself"],
          dropped_quotes: 0,
          model: "m",
          input_tokens: 1,
          output_tokens: 1,
          scored_at: "2026-10-21T10:00:00.000Z",
          timing_check: false,
          style_check: false,
        },
      ],
    },
    attempt: { number: 1, of: 1, isLatest: true, latestSessionId: SESSION, earlierSessionIds: [] },
    videoPieces,
  };
}

const page = (view) =>
  renderToStaticMarkup(
    createElement(LiveReviewClient, {
      view,
      candidateName: "Alex Example",
      jobTitle: "Backend Engineer",
      canAct: false,
    }),
  );
const vrow = (i, started, dur, extra = {}) => ({
  piece_index: i,
  status: "confirmed",
  started_ms: started,
  duration_ms: dur,
  is_last: false,
  media_path: `${SESSION}/v${i}.webm`,
  ...extra,
});

test("the review player: Play video, gaps, incomplete, Sarah's voice not in it, and Watch from a quote", () => {
  // The candidate's quote is 3 s into a turn at 58 s: 61 s, inside piece 0.
  const v = buildLiveReviewView(
    reviewInput([vrow(0, 0, 120_000), vrow(2, 240_000, 120_000, { is_last: true })]),
  );
  assert.equal(v.questions[0].quotes[0].atMs, 61_000);
  const html = page(v);
  assert.match(html, /data-video/);
  assert.match(html, />Play video</);
  assert.match(html, /Video missing from 2:00 to 4:00/);
  assert.match(html, /The recording is incomplete: 1 part was not saved\./);
  assert.match(html, /data-video-sound/);
  assert.match(html, /Sarah&#x27;s voice is not in it/);
  assert.match(html, /data-watch="61000"/);
  assert.doesNotMatch(JSON.stringify(v), /\/v\d\.webm/, "no path in what the page is sent");

  // The quote's moment falls in a gap: no Watch button.
  const gapView = buildLiveReviewView(reviewInput([vrow(1, 120_000, 120_000, { is_last: true })]));
  assert.doesNotMatch(page(gapView), /data-watch=/);

  // No video at all.
  const none = page(buildLiveReviewView(reviewInput([])));
  assert.match(none, /No camera video was recorded for this interview\./);
  assert.doesNotMatch(none, />Play video</);

  // Retention removed it.
  const purged = page(
    buildLiveReviewView(
      reviewInput([
        vrow(0, 0, 120_000, { is_last: true, media_path: null, content_purged_at: "x" }),
      ]),
    ),
  );
  assert.match(purged, /This video was deleted after six months\./);
});

/* ── RB1: only the server ends the interview for video (28 Oct 2026) ── */

const { handleLiveEvent, END_GRACE_MS } = await import("./live-events.ts");
const MIN = 60_000;
/** A started live session: the start route set started_at and the provider session. */
const started = (minutesAgo) => ({
  started_at: new Date(Date.now() - minutesAgo * MIN).toISOString(),
  provider: "mock",
  provider_session_id: "mock-rb1",
});

test("RB1: a forged 'it ended' report from the browser does not close the video: new pieces are still reserved and confirmed", async () => {
  const w = world(started(5));
  for (const detail of ["completed", "candidate_left", "other"]) {
    const res = await quiet(() =>
      handleLiveEvent(
        { token: TOKEN, kind: "provider_end_reported", detail },
        { service: w.db.service },
      ),
    );
    assert.equal(res.status, 200);
  }
  assert.equal(w.db.tables.interview_sessions[0].live_ended_at, null, "not ended by the browser");
  await quiet(() => record(w, 0));
  await quiet(() => record(w, 1));
  assert.deepEqual(
    w.db.tables.live_video_pieces.map((p) => [p.piece_index, p.status]),
    [
      [0, "confirmed"],
      [1, "confirmed"],
    ],
  );
});

test("RB1: the backstop on reserve: past the limit plus the grace, the end is stamped, no new piece, a reserved one still confirms", async () => {
  const w = world(started(5));
  const r0 = await quiet(() => reserve(w.deps, 0));
  assert.equal(r0.status, 200, "piece 0 reserved while the interview runs");
  // The interview started 30 minutes (the ceiling) plus the grace plus a minute ago.
  w.db.tables.interview_sessions[0].started_at = new Date(
    Date.now() - 30 * MIN - END_GRACE_MS - MIN,
  ).toISOString();
  const r1 = await quiet(() => reserve(w.deps, 1));
  assert.deepEqual([r1.status, r1.body.code], [409, "not_open"], "no new piece after the backstop");
  assert.notEqual(
    w.db.tables.interview_sessions[0].live_ended_at,
    null,
    "the server stamped the end",
  );
  // Piece 0 was reserved before the end: it gets its upload and is confirmed within the window.
  const put = await w.db.putSigned(
    (await quiet(() => reserve(w.deps, 0))).body.url,
    WEBM(),
    "video/webm",
  );
  assert.equal(put.error, null);
  assert.deepEqual((await quiet(() => confirm(w.deps, 0))).body, { ok: true });
});

test("RB1: a minute before the limit plus the grace, the video stays open and nothing is stamped", async () => {
  const w = world({
    ...started(0),
    started_at: new Date(Date.now() - 30 * MIN - END_GRACE_MS + MIN).toISOString(),
  });
  assert.equal((await quiet(() => reserve(w.deps, 0))).status, 200);
  assert.equal(w.db.tables.interview_sessions[0].live_ended_at, null);
});
