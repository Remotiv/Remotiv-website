/**
 * AVI commit 10: the camera video in pieces (PieceRecorder) and the screen's
 * calls to Remotiv's server (live-server.ts). A fake recorder, a fake sink
 * and a fake clock; nothing waits and nothing leaves the machine.
 *
 *   node --test "src/app/interview/?token?/_live/live-video-pieces.test.ts"   (?token? matches [token]: brackets would be read as a glob)
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { PieceRecorder, baseMime, RETRY_MS, PIECE_MS } = await import("./video-pieces.ts");
const { httpLiveServer, startAnswerFrom, consentAnswerFrom } = await import("./live-server.ts");

function fakeClock() {
  let now = 0;
  let next = 0;
  const queue = [];
  return {
    get now() {
      return now;
    },
    setTimeout(fn, ms) {
      const t = { id: ++next, at: now + ms, fn };
      queue.push(t);
      return t.id;
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
        t.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

/** A MediaRecorder stand-in: a chunk each second, the last one on stop, then onstop. */
function fakeRecorders(clock) {
  const made = [];
  const make = () => {
    const r = {
      ondataavailable: null,
      onstop: null,
      started: false,
      start() {
        r.started = true;
        const tick = () => {
          if (!r.started) return;
          r.ondataavailable?.({ data: new Blob([new Uint8Array(1000)]) });
          clock.setTimeout(tick, 1000);
        };
        clock.setTimeout(tick, 1000);
      },
      stop() {
        r.started = false;
        r.ondataavailable?.({ data: new Blob([new Uint8Array(500)]) });
        clock.setTimeout(() => r.onstop?.(), 0);
      },
    };
    made.push(r);
    return r;
  };
  return { made, make };
}

function fakeSink({ failUploads = 0 } = {}) {
  const calls = [];
  let uploadFailures = failUploads;
  return {
    calls,
    get failing() {
      return uploadFailures;
    },
    set failing(n) {
      uploadFailures = n;
    },
    async reserve(index, mime) {
      calls.push(["reserve", index, mime]);
      return { url: `https://storage.test/upload/s/v${index}.webm` };
    },
    async upload(url, blob, mime) {
      if (uploadFailures > 0) {
        uploadFailures -= 1;
        calls.push(["upload-failed", url]);
        throw new Error("network");
      }
      calls.push(["upload", url, blob.size, mime]);
    },
    async confirm(p) {
      calls.push(["confirm", p.index, p.startedAtMs, p.durationMs, p.last]);
    },
  };
}

function recorder(opts = {}) {
  const clock = fakeClock();
  const rec = fakeRecorders(clock);
  const sink = fakeSink(opts);
  const views = [];
  const pr = new PieceRecorder({
    mime: "video/webm",
    sink,
    makeRecorder: rec.make,
    now: () => clock.now,
    pieceMs: 10_000,
    clock,
    onChange: (v) => views.push(v),
  });
  return { clock, rec, sink, pr, views };
}

test("pieces: reserved as each starts, a new recorder per piece, uploaded and confirmed in order with its timing", async () => {
  const { clock, rec, sink, pr } = recorder();
  pr.start();
  await clock.advance(25_000);
  pr.stop();
  await clock.advance(1);
  assert.equal(rec.made.length, 3, "a new recorder per piece");
  assert.deepEqual(
    sink.calls.filter((c) => c[0] === "confirm"),
    [
      ["confirm", 0, 0, 10_000, false],
      ["confirm", 1, 10_000, 10_000, false],
      ["confirm", 2, 20_000, 5_000, true],
    ],
  );
  // Each piece is reserved when it starts, before anything of it is uploaded.
  const first = (kind, i) => sink.calls.findIndex((c) => c[0] === kind && c[1] === i);
  assert.ok(
    sink.calls.findIndex((c) => c[0] === "reserve" && c[1] === 1) <
      sink.calls.findIndex((c) => c[0] === "upload" && c[1].endsWith("v1.webm")),
  );
  assert.ok(first("reserve", 2) >= 0);
  assert.equal(pr.drained, true);
  assert.equal(pr.unsaved, 0);
});

test("each piece is a complete file of its own chunks, never another piece's", async () => {
  const { clock, sink, pr } = recorder();
  pr.start();
  await clock.advance(10_000);
  pr.stop();
  await clock.advance(1);
  const sizes = sink.calls.filter((c) => c[0] === "upload").map((c) => c[2]);
  // Piece 0: the chunks of seconds 1 to 9 (the rotation at 10s comes first)
  // and its stop chunk. Piece 1: stopped at once, its stop chunk only.
  assert.deepEqual(sizes, [9 * 1000 + 500, 500]);
});

test("a failed upload is retried with backoff and then saved; nothing is lost and the end waits for it", async () => {
  const { clock, sink, pr } = recorder({ failUploads: 2 });
  pr.start();
  pr.stop();
  await clock.advance(1);
  assert.equal(pr.drained, false, "not drained while the upload is failing");
  await clock.advance(RETRY_MS[0] + RETRY_MS[1] + 1);
  assert.equal(sink.calls.filter((c) => c[0] === "upload-failed").length, 2);
  assert.deepEqual(
    sink.calls.filter((c) => c[0] === "confirm").map((c) => c[1]),
    [0],
  );
  assert.equal(pr.drained, true);
});

test("past every retry the piece waits as failed, its file kept, until Try again saves it", async () => {
  const { clock, sink, pr, views } = recorder({ failUploads: 99 });
  pr.start();
  pr.stop();
  await clock.advance(60_000);
  assert.equal(views.at(-1)[0].state, "failed");
  assert.equal(pr.drained, false);
  assert.equal(pr.unsaved, 1);
  sink.failing = 0;
  pr.retryFailed();
  await clock.advance(1);
  assert.equal(views.at(-1)[0].state, "saved");
  assert.equal(pr.drained, true);
});

test("stop is the end: the last piece is marked last, no new piece starts after it, and stop twice is harmless", async () => {
  const { clock, rec, sink, pr } = recorder();
  pr.start();
  await clock.advance(3_000);
  pr.stop();
  pr.stop();
  await clock.advance(60_000);
  assert.equal(rec.made.length, 1);
  assert.deepEqual(
    sink.calls.filter((c) => c[0] === "confirm"),
    [["confirm", 0, 0, 3_000, true]],
  );
});

test("the real piece length is two minutes (044 allows three); the stored type is the base type", () => {
  assert.equal(PIECE_MS, 120_000);
  assert.equal(baseMime("video/webm;codecs=vp8,opus"), "video/webm");
  assert.equal(baseMime("video/mp4;codecs=avc1.42E01E,mp4a.40.2"), "video/mp4");
  assert.equal(baseMime("video/x-matroska"), null);
});

/* ── the server client ────────────────────────────────────────── */

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = answer(url, init);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { calls, fn };
}

test("the token goes in the body only, never in a URL", async () => {
  const token = "candidate-token-0123456789abcdef";
  const f = fakeFetch((url) =>
    url.includes("video-upload-url")
      ? { status: 200, body: { url: "https://storage.test/u" } }
      : { status: 200, body: { ok: true } },
  );
  const s = httpLiveServer(token, f.fn);
  await s.consent();
  await s.start();
  s.event("end_pressed");
  await s.pieces.reserve(0, "video/webm");
  await s.pieces.confirm({
    index: 0,
    mime: "video/webm",
    startedAtMs: 0,
    durationMs: 1,
    last: true,
  });
  await new Promise((r) => setTimeout(r, 0));
  for (const c of f.calls) {
    assert.doesNotMatch(c.url, new RegExp(token), c.url);
    assert.match(c.init.body, new RegExp(token));
  }
  assert.deepEqual(
    f.calls.map((c) => c.url),
    [
      "/api/interview/live/consent",
      "/api/interview/live/start",
      "/api/interview/live/event",
      "/api/interview/live/video-upload-url",
      "/api/interview/live/video-confirm",
    ],
  );
});

test("start answers: the ticket; busy and any failure as 'try again'; the rest as what they are", () => {
  const join = { mode: "mock", script: "completed", turnDetection: "server" };
  assert.deepEqual(startAnswerFrom({ status: 200, body: { join } }), { ok: true, join });
  assert.deepEqual(
    startAnswerFrom({ status: 503, body: { code: "busy", retryAfterSeconds: 30 } }),
    {
      ok: false,
      reason: "busy",
      retryAfterSeconds: 30,
    },
  );
  assert.equal(
    startAnswerFrom({ status: 503, body: { code: "unavailable" } }).reason,
    "unavailable",
  );
  assert.equal(startAnswerFrom({ status: 500, body: {} }).reason, "unavailable");
  assert.equal(
    startAnswerFrom({ status: 409, body: { code: "already_started" } }).reason,
    "already_started",
  );
  assert.equal(
    startAnswerFrom({ status: 403, body: { code: "consent_required" } }).reason,
    "consent_required",
  );
  assert.equal(startAnswerFrom({ status: 409, body: { code: "consent_locked" } }).reason, "locked");
  assert.equal(consentAnswerFrom({ status: 200, body: { ok: true } }), "saved");
  assert.equal(consentAnswerFrom({ status: 409, body: { code: "consent_locked" } }), "locked");
  assert.equal(consentAnswerFrom({ status: 500, body: { code: "consent_not_saved" } }), "failed");
});

test("a report that fails is tried once more; a closed tab goes by sendBeacon as text", async () => {
  let n = 0;
  const f = fakeFetch(() =>
    ++n === 1 ? { status: 502, body: {} } : { status: 200, body: { ok: true } },
  );
  httpLiveServer("candidate-token-0123456789abcdef", f.fn).event("connection_lost");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.calls.length, 2);

  const beacons = [];
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      sendBeacon: (url, blob) => {
        beacons.push({ url, type: blob.type });
        return true;
      },
    },
  });
  try {
    httpLiveServer("candidate-token-0123456789abcdef", f.fn).beacon("tab_closed");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });
  }
  assert.deepEqual(beacons, [{ url: "/api/interview/live/event", type: "text/plain" }]);
});
