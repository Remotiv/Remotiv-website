/**
 * #54: an interview closed under the candidate while it runs (the applicant's
 * delete began, the session cancelled, its delete_after due, or its row gone)
 * ends on the candidate's screen within one piece (PIECE_MS, 30 s): the
 * provider connection is closed here, the recorder and every upload stop,
 * and "This interview has been closed" shows, whatever the provider's side
 * does. Fake clock, fake recorders, a fake upload sink answering as
 * live-video.ts does (pinned there); the recorder (video-pieces.ts), the
 * screen's state machine (machine.ts) and the stop (closed.ts) are the
 * shipped code, wired as live-flow.tsx wires them (pinned below).
 *
 *   node --test "src/app/interview/[token]/_live/live-closed.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { endClosedInterview, ClosedWatch, watchedSink, CLOSED_CHECK_MS } = await import(
  "./closed.ts"
);
const { statusAnswerFrom, httpLiveServer } = await import("./live-server.ts");
const { INITIAL, liveReducer } = await import("./machine.ts");
const { BLOCKED } = await import("./copy.ts");
const { PieceRecorder, PieceHttpError, PIECE_MS, closedBy, INTERVIEW_CLOSED } = await import(
  "./video-pieces.ts"
);

/** A clock whose timers run only when advanced. */
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
        await new Promise((r) => setImmediate(r));
      }
      now = end;
      await new Promise((r) => setImmediate(r));
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
      stops: 0,
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
        r.stops += 1;
        r.ondataavailable?.({ data: new Blob([new Uint8Array(500)]) });
        clock.setTimeout(() => r.onstop?.(), 0);
      },
    };
    made.push(r);
    return r;
  };
  return { made, make };
}

/** How the server answers once the interview is closed under the candidate (live-video.ts). */
const CLOSED_ANSWERS = {
  "the applicant's delete began (071 Close)": [409, INTERVIEW_CLOSED],
  "the session cancelled": [409, INTERVIEW_CLOSED],
  "delete_after due": [409, INTERVIEW_CLOSED],
  "the session's row gone (Finish)": [404, "not_found"],
};

/** The upload routes, answering for the session as it is now. */
function fakeServer(clock) {
  const calls = [];
  const server = {
    calls,
    closed: null,
    /** The status route (#55 part 2), answering as live-video.ts does. */
    async status() {
      calls.push(["status", null, clock.now]);
      return server.closed ? "closed" : "open";
    },
    sink: {
      async reserve(index) {
        calls.push(["reserve", index, clock.now]);
        if (server.closed) throw new PieceHttpError("reserve", ...server.closed);
        return { url: `https://storage.test/upload/s/v${index}.webm` };
      },
      async upload(url) {
        calls.push(["upload", url, clock.now]);
      },
      async confirm(p) {
        calls.push(["confirm", p.index, clock.now]);
        if (server.closed) throw new PieceHttpError("confirm", ...server.closed);
      },
    },
  };
  return server;
}

/**
 * A running interview, wired as live-flow.tsx wires it: the recorder's sink
 * counted by a ClosedWatch, both ending the interview through one closeHere.
 * Closed under the candidate at `closeAt` (or never); the recorder stopped at
 * `stopAt` (the camera or recorder gone mid-call), or never started
 * (`noRecorder`). The provider's side never closes: its transport keeps
 * sending whatever it likes after this side closed it. Times are from the
 * conversation's start.
 */
async function interview({
  closeAt = null,
  answer = [409, INTERVIEW_CLOSED],
  stopAt = null,
  noRecorder = false,
  until = 5 * 60_000,
}) {
  const clock = fakeClock();
  const rec = fakeRecorders(clock);
  const server = fakeServer(clock);
  let state = liveReducer(
    liveReducer(liveReducer(INITIAL, { t: "begin" }), { t: "consent_result", answer: "saved" }),
    { t: "start" },
  );
  state = liveReducer(state, { t: "transport", event: { type: "started" } });
  const transport = {
    closes: 0,
    close() {
      transport.closes += 1;
    },
    /** The provider's side, still open: it keeps talking. */
    send(event) {
      state = liveReducer(state, { t: "transport", event });
    },
  };
  const media = { stops: 0 };
  let shownAt = null;
  let closed = false;
  let pr = null;
  const watch = new ClosedWatch({
    clock,
    now: () => clock.now,
    check: () => server.status(),
    onClosed: () => closeHere(),
  });
  // live-flow.tsx's closeHere.
  const closeHere = () => {
    if (closed) return;
    closed = true;
    watch.stop();
    endClosedInterview({
      closeTransport: () => transport.close(),
      stopRecording: () => pr?.abandon(),
      stopMedia: () => {
        media.stops += 1;
      },
      show: () => {
        state = liveReducer(state, { t: "closed_under" });
        shownAt = clock.now;
      },
    });
  };
  watch.start();
  if (!noRecorder) {
    pr = new PieceRecorder({
      mime: "video/webm",
      sink: watchedSink(server.sink, watch),
      makeRecorder: rec.make,
      now: () => clock.now,
      pieceMs: PIECE_MS,
      clock,
      onChange: () => {},
      onClosed: closeHere,
    });
    pr.start();
  }
  const steps = [
    [stopAt, () => pr?.stop()],
    [closeAt, () => (server.closed = answer)],
  ]
    .filter(([at]) => at !== null)
    .sort((a, b) => a[0] - b[0]);
  for (const [at, act] of steps) {
    await clock.advance(at - clock.now);
    act();
  }
  await clock.advance(until - clock.now);
  const statusCalls = server.calls.filter((c) => c[0] === "status");
  return {
    clock,
    rec,
    server,
    pr,
    transport,
    media,
    statusCalls,
    get state() {
      return state;
    },
    shownAt,
  };
}

test("#54 an active interview closed under the candidate ends on the screen within one piece: call closed, recorder stopped, closed screen, nothing more sent", async () => {
  for (const [label, answer] of Object.entries(CLOSED_ANSWERS)) {
    // Mid-piece: 40 s in, the next reserve is at 60 s.
    const closeAt = 40_000;
    const r = await interview({ closeAt, answer });
    assert.ok(r.shownAt !== null, `${label}: the screen learned`);
    assert.deepEqual(r.statusCalls, [], `${label}: pieces were flowing, so no status check`);
    assert.ok(r.shownAt - closeAt <= PIECE_MS, `${label}: within ${PIECE_MS} ms`);
    assert.equal(r.transport.closes, 1, `${label}: the provider connection closed here`);
    assert.equal(r.media.stops, 1, `${label}: camera and microphone stopped`);
    assert.ok(
      r.rec.made.every((m) => !m.started),
      `${label}: no recorder running`,
    );
    assert.equal(r.pr.closedUnder, true);
    assert.equal(r.pr.unsaved, 0, `${label}: nothing left waiting to upload`);
    assert.deepEqual([r.state.screen, r.state.blocked], ["blocked", "interview_closed"], label);
    assert.deepEqual(
      r.server.calls.filter((c) => c[2] > r.shownAt),
      [],
      `${label}: no reserve, upload or confirm after it, for the 5 minutes that follow`,
    );
    assert.equal(r.rec.made.length, 3, `${label}: no new piece recorded after it`);
  }
});

test("#54 the provider's side still open: Remotiv ends it anyway, and nothing it sends is heard", async () => {
  const r = await interview({ closeAt: 10_000 });
  assert.equal(r.state.blocked, "interview_closed");
  r.transport.send({ type: "agent", state: "speaking" });
  r.transport.send({ type: "agent_text", text: "Tell me about a time you..." });
  r.transport.send({ type: "ended", endReason: "completed", graceful: true });
  assert.deepEqual(
    [r.state.screen, r.state.blocked, r.state.agent, r.state.caption, r.state.ending],
    ["blocked", "interview_closed", null, null, null],
  );
  assert.equal(r.transport.closes, 1, "closed once, from this side");
});

test("#54 closed while the video is still being saved after the end: the uploads stop there too", async () => {
  const r = await interview({ closeAt: null, until: 50_000 });
  r.pr.stop();
  r.server.closed = [409, INTERVIEW_CLOSED];
  await r.clock.advance(60_000);
  assert.equal(r.pr.closedUnder, true);
  assert.equal(r.state.blocked, "interview_closed");
  assert.equal(r.pr.unsaved, 0);
});

test("#54 a normal interview is unaffected: pieces keep recording and saving, nothing is closed", async () => {
  const r = await interview({ closeAt: null });
  assert.equal(r.shownAt, null);
  assert.equal(r.transport.closes, 0);
  assert.equal(r.media.stops, 0);
  assert.equal(r.pr.closedUnder, false);
  assert.equal(r.state.screen, "interview");
  assert.deepEqual(r.statusCalls, [], "pieces flowing: the status route is never asked");
  const confirms = r.server.calls.filter((c) => c[0] === "confirm").map((c) => c[1]);
  assert.deepEqual(
    confirms,
    Array.from({ length: 10 }, (_, i) => i),
    "every piece of 5 minutes",
  );
});

test("#54 only the closed answers close it: a refused piece, a network failure or a 5xx never do", () => {
  assert.equal(closedBy(new PieceHttpError("reserve", 409, INTERVIEW_CLOSED)), true);
  assert.equal(closedBy(new PieceHttpError("confirm", 409, INTERVIEW_CLOSED)), true);
  assert.equal(closedBy(new PieceHttpError("reserve", 404, "not_found")), true);
  for (const e of [
    new PieceHttpError("reserve", 409, "not_open"),
    new PieceHttpError("confirm", 409, "window_closed"),
    new PieceHttpError("confirm", 404, "not_uploaded"),
    new PieceHttpError("confirm", 404, "not_reserved"),
    new PieceHttpError("upload", 403),
    new PieceHttpError("reserve", 503, "unavailable"),
    new Error("network"),
  ]) {
    assert.equal(closedBy(e), false, e.message);
  }
});

test("#54 the screen's words: 'This interview has been closed', and the code matches the server's", () => {
  assert.equal(BLOCKED.interview_closed.heading, "This interview has been closed");
  assert.doesNotMatch(BLOCKED.interview_closed.body("Acme"), /delet|cancel/i, "never the reason");
  const server = readFileSync(
    new URL("../../../../lib/interviews/live-video.ts", import.meta.url),
    "utf8",
  );
  assert.match(server, new RegExp(`INTERVIEW_CLOSED = "${INTERVIEW_CLOSED}"`));
});

test("#54 the screen wires it: the recorder's onClosed ends the interview here, and the provider is not heard after", () => {
  const flow = readFileSync(new URL("./live-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /onClosed: closeHere,/);
  assert.match(
    flow,
    /watchRef\.current\?\.stop\(\);\s*endClosedInterview\(\{\s*closeTransport: \(\) => transportRef\.current\?\.close\(\),\s*stopRecording: \(\) => recorderRef\.current\?\.abandon\(\),\s*stopMedia,\s*show: \(\) => dispatch\(\{ t: "closed_under" \}\),\s*\}\)/,
  );
  // #55 part 2: the watch starts with the conversation, counts the recorder's requests, and closes the same way.
  assert.match(
    flow,
    /new ClosedWatch\(\{\s*clock: realClock,\s*now: \(\) => performance\.now\(\),\s*check: \(\) => server\.status\(\),\s*onClosed: closeHere,\s*\}\);\s*watchRef\.current = watch;\s*watch\.start\(\);/,
  );
  assert.match(flow, /sink: watchedSink\(server\.pieces, watch\),/);
  assert.match(flow, /if \(limitHitRef\.current \|\| closedRef\.current\) return;/);
});

/* ── #55 part 2: closed with no video pieces going out ─────────── */

test("#55 the recorder stopped mid-call: the status check notices a close within 30 s, and ends it the same way", async () => {
  for (const [label, answer] of Object.entries(CLOSED_ANSWERS)) {
    // The recorder stops 45 s in (its last piece uploads then); the close comes later.
    const r = await interview({ stopAt: 45_000, closeAt: 100_000, answer });
    const lastPiece = Math.max(
      ...r.server.calls.filter((c) => c[0] !== "status" && c[2] < 100_000).map((c) => c[2]),
    );
    assert.ok(r.shownAt !== null, `${label}: the screen learned`);
    assert.ok(r.shownAt - 100_000 <= CLOSED_CHECK_MS, `${label}: within 30 s of the close`);
    assert.ok(r.statusCalls.length >= 1, `${label}: by the status route`);
    assert.ok(
      r.statusCalls[0][2] - lastPiece <= CLOSED_CHECK_MS,
      `${label}: first check 30 s after the last request`,
    );
    assert.equal(r.transport.closes, 1, label);
    assert.equal(r.media.stops, 1, label);
    assert.deepEqual([r.state.screen, r.state.blocked], ["blocked", "interview_closed"], label);
    assert.deepEqual(
      r.server.calls.filter((c) => c[2] > r.shownAt),
      [],
      `${label}: nothing more asked after it`,
    );
  }
});

test("#55 worst case: the recorder stops right after a successful piece request, the close a moment later: still within 30 s", async () => {
  // The rotation at 60 s reserves piece 2; the recorder stops at once (its
  // last piece uploads at 60 s too); the delete lands 1 ms later.
  const r = await interview({ stopAt: 60_000, closeAt: 60_001 });
  const before = r.server.calls.filter((c) => c[2] <= 60_001 && c[0] !== "status");
  assert.equal(Math.max(...before.map((c) => c[2])), 60_000, "the last piece request at 60 s");
  assert.ok(r.shownAt !== null);
  assert.ok(
    r.shownAt - 60_000 <= CLOSED_CHECK_MS,
    `shown ${r.shownAt - 60_000} ms after the last request`,
  );
  assert.ok(r.shownAt - 60_001 < CLOSED_CHECK_MS, "under 30 s after the close");
  assert.equal(r.state.blocked, "interview_closed");
});

test("#55 no recorder at all (no camera recording): the status check alone notices, within 30 s", async () => {
  const r = await interview({ noRecorder: true, closeAt: 10_000 });
  assert.ok(r.shownAt !== null && r.shownAt - 10_000 <= CLOSED_CHECK_MS);
  assert.deepEqual([r.state.screen, r.state.blocked], ["blocked", "interview_closed"]);
  assert.equal(r.transport.closes, 1);
});

test("#55 the recorder stopped and the interview still open: one check every 30 s, nothing ended", async () => {
  const r = await interview({ stopAt: 45_000, until: 5 * 60_000 });
  assert.equal(r.shownAt, null);
  assert.equal(r.transport.closes, 0);
  const gaps = r.statusCalls.map((c, i) => c[2] - (i === 0 ? 45_000 : r.statusCalls[i - 1][2]));
  assert.ok(
    r.statusCalls.length >= 8 && r.statusCalls.length <= 9,
    `${r.statusCalls.length} checks in 255 s`,
  );
  assert.ok(
    gaps.every((g) => g <= CLOSED_CHECK_MS),
    "never more than 30 s apart",
  );
  assert.equal(r.state.screen, "interview");
});

test("#55 the status answers: open, closed for interview_closed and not_found, anything else unknown", async () => {
  assert.equal(statusAnswerFrom({ status: 200, body: { open: true } }), "open");
  assert.equal(statusAnswerFrom({ status: 409, body: { code: INTERVIEW_CLOSED } }), "closed");
  assert.equal(statusAnswerFrom({ status: 404, body: { code: "not_found" } }), "closed");
  for (const res of [
    { status: 429, body: { code: "rate_limited" } },
    { status: 502, body: {} },
    { status: 200, body: {} },
    { status: 409, body: { code: "not_open" } },
  ]) {
    assert.equal(statusAnswerFrom(res), "unknown", JSON.stringify(res));
  }
  // The token in the body, never in the URL.
  const asked = [];
  const s = httpLiveServer("candidate-token-0123456789abcdef", async (url, init) => {
    asked.push([url, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ open: true }), { status: 200 });
  });
  assert.equal(await s.status(), "open");
  assert.deepEqual(asked, [
    ["/api/interview/live/status", { token: "candidate-token-0123456789abcdef" }],
  ]);
  const down = httpLiveServer("candidate-token-0123456789abcdef", async () => {
    throw new Error("network");
  });
  assert.equal(await down.status(), "unknown");
});
