/**
 * #49: the hard stop at the interview's chosen length. At 30:00 (1800 s) or
 * 60:00 (3600 s) the call ends for the candidate: the interviewer stops, the
 * recording stops, the ending is shown; video pieces still being sent keep
 * uploading after the end. Fake clock, fake recorders, fake upload sink; the
 * limit check (time-limit.ts), the screen's state machine (machine.ts) and the
 * piece recorder (video-pieces.ts) are the shipped code.
 *
 *   node --test "src/app/interview/[token]/_live/live-time-limit.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { endAtTimeLimit, limitReached, secondsLeft } = await import("./time-limit.ts");
const { INITIAL, liveReducer } = await import("./machine.ts");
const { PieceRecorder } = await import("./video-pieces.ts");

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

/** Records every call; uploads fail while `failing` is above 0, as a flaky network would. */
function fakeSink() {
  const calls = [];
  const sink = {
    calls,
    failing: 0,
    async reserve(index) {
      calls.push(["reserve", index, clockRef.now]);
      return { url: `https://storage.test/upload/s/v${index}.webm` };
    },
    async upload(url) {
      if (sink.failing > 0) {
        sink.failing -= 1;
        calls.push(["upload-failed", url, clockRef.now]);
        throw new Error("network");
      }
      calls.push(["upload", url, clockRef.now]);
    },
    async confirm(p) {
      calls.push(["confirm", p.index, clockRef.now, p.last]);
    },
  };
  return sink;
}
let clockRef = { now: 0 };

/**
 * A conversation that started at clock 0 and is checked every 500 ms, as the
 * screen does, until the limit ends it. Returns what happened, and when.
 */
async function runToLimit(minutes, { failAtEnd = 0 } = {}) {
  const clock = fakeClock();
  clockRef = clock;
  const rec = fakeRecorders(clock);
  const sink = fakeSink();
  const pr = new PieceRecorder({
    mime: "video/webm",
    sink,
    makeRecorder: rec.make,
    now: () => clock.now,
    pieceMs: 30_000,
    clock,
    onChange: () => {},
  });
  let state = liveReducer(
    liveReducer(liveReducer(INITIAL, { t: "begin" }), { t: "consent_result", answer: "saved" }),
    { t: "start" },
  );
  state = liveReducer(state, { t: "transport", event: { type: "started" } });
  const transport = {
    closed: false,
    close() {
      transport.closed = true;
    },
  };
  const reports = [];
  pr.start();
  let endedAt = null;
  while (endedAt === null) {
    await clock.advance(500);
    if (limitReached(minutes, 0, clock.now)) {
      endedAt = clock.now;
      // Pieces not yet sent at the end meet a flaky network: they must still arrive.
      sink.failing = failAtEnd;
      state = liveReducer(state, { t: "time_up" });
      endAtTimeLimit({
        report: () => reports.push(["timer_reached", clock.now]),
        closeTransport: () => transport.close(),
        stopRecording: () => pr.stop(),
      });
    }
  }
  return { clock, sink, pr, state, transport, reports, endedAt };
}

test("the limit is reached exactly at 30:00 for 1800 s and 60:00 for 3600 s, not a moment before", () => {
  for (const [minutes, seconds] of [
    [30, 1800],
    [60, 3600],
  ]) {
    assert.equal(
      limitReached(minutes, 0, (seconds - 0.5) * 1000),
      false,
      `${minutes}: just before`,
    );
    assert.equal(limitReached(minutes, 0, seconds * 1000), true, `${minutes}: exactly at`);
    assert.equal(secondsLeft(minutes, 0, (seconds - 90) * 1000), 90);
    assert.equal(secondsLeft(minutes, 0, (seconds + 10) * 1000), 0, "never below 0");
  }
  assert.equal(secondsLeft(30, null, 1_000_000), null, "not started: no countdown");
  assert.equal(limitReached(30, null, 1_000_000), false);
});

for (const [minutes, label] of [
  [30, "30:00"],
  [60, "60:00"],
]) {
  test(`a ${minutes}-minute interview ends for the candidate at ${label}: interviewer stopped, recording stopped, ending shown`, async () => {
    const { state, transport, reports, endedAt, pr } = await runToLimit(minutes);
    assert.equal(endedAt, minutes * 60_000, `ended at ${label}`);
    assert.deepEqual(reports, [["timer_reached", minutes * 60_000]], "reported once, at the limit");
    assert.equal(transport.closed, true, "the interviewer is stopped");
    assert.deepEqual(
      [state.screen, state.ending, state.endCause, state.timeUp],
      ["saving", "timed_out", { kind: "time_limit" }, true],
    );
    assert.equal(pr.finished, false, "the video is still being saved");
  });
}

test("pieces not yet sent at the end keep uploading after it, through a flaky network, until every one is saved", async () => {
  const { clock, sink, pr, state, endedAt } = await runToLimit(30, { failAtEnd: 2 });
  await clock.advance(5 * 60_000);
  const after = sink.calls.filter((c) => c[2] > endedAt);
  assert.ok(
    after.some((c) => c[0] === "upload-failed"),
    "a failure after the end",
  );
  assert.ok(
    after.some((c) => c[0] === "upload"),
    "and an upload after it",
  );
  // Every piece of the 30 minutes (60 of 30 seconds, plus the one the rotation
  // at 30:00 had just begun), each confirmed once, in order, the last marked last.
  const confirms = sink.calls.filter((c) => c[0] === "confirm");
  assert.ok(confirms.length >= 60, `${confirms.length} pieces`);
  assert.deepEqual(
    confirms.map((c) => c[1]),
    Array.from({ length: confirms.length }, (_, i) => i),
  );
  assert.deepEqual(
    confirms.map((c) => c[3]),
    confirms.map((_, i) => i === confirms.length - 1),
  );
  assert.equal(pr.drained, true);
  assert.equal(pr.finished, true);
  assert.equal(liveReducer(state, { t: "video_saved" }).screen, "done", "then the ending screen");
});

test("time up after the interview already ended changes nothing; before it started it only marks the time", () => {
  const ended = liveReducer(
    { ...INITIAL, screen: "interview" },
    { t: "transport", event: { type: "ended", endReason: "completed", graceful: true } },
  );
  const after = liveReducer(ended, { t: "time_up" });
  assert.deepEqual([after.ending, after.endCause.kind], ["completed", "session_complete"]);
  assert.equal(liveReducer({ ...INITIAL, screen: "check" }, { t: "time_up" }).screen, "check");
});

test("the screen wires it: the limit check, the hard stop, and nothing reported for its own closed connection", () => {
  const flow = readFileSync(new URL("./live-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /limitReached\(p\.minutes, startedAtRef\.current, now\)/);
  assert.match(
    flow,
    /endAtTimeLimit\(\{\s*report: \(\) => server\.event\("timer_reached"\),\s*closeTransport: \(\) => transportRef\.current\?\.close\(\),\s*stopRecording,\s*\}\)/,
  );
  assert.match(
    flow,
    /if \(limitHitRef\.current\) return;\s*dispatch\(\{ t: "transport", event \}\);/,
  );
});
