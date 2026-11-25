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

const { endClosedInterview } = await import("./closed.ts");
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
 * A running interview, wired as live-flow.tsx wires it, closed under the
 * candidate at `closeAt` (or never). The provider's side never closes: its
 * transport keeps sending whatever it likes after this side closed it.
 */
async function interview({ closeAt = null, answer = [409, INTERVIEW_CLOSED], runMs = 5 * 60_000 }) {
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
  const pr = new PieceRecorder({
    mime: "video/webm",
    sink: server.sink,
    makeRecorder: rec.make,
    now: () => clock.now,
    pieceMs: PIECE_MS,
    clock,
    onChange: () => {},
    onClosed: () =>
      endClosedInterview({
        closeTransport: () => transport.close(),
        stopMedia: () => {
          media.stops += 1;
        },
        show: () => {
          state = liveReducer(state, { t: "closed_under" });
          shownAt = clock.now;
        },
      }),
  });
  pr.start();
  if (closeAt !== null) {
    await clock.advance(closeAt);
    server.closed = answer;
  }
  await clock.advance(runMs);
  return {
    clock,
    rec,
    server,
    pr,
    transport,
    media,
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
  const r = await interview({ closeAt: null, runMs: 50_000 });
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
    /endClosedInterview\(\{\s*closeTransport: \(\) => transportRef\.current\?\.close\(\),\s*stopMedia,\s*show: \(\) => dispatch\(\{ t: "closed_under" \}\),\s*\}\)/,
  );
  assert.match(flow, /if \(limitHitRef\.current \|\| closedRef\.current\) return;/);
});
