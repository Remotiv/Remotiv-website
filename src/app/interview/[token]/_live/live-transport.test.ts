/**
 * AVI commit 10: the live conversation behind VoxAgentTransport. MockVoxAgent
 * plays every script on a fake clock (nothing waits), into a fake audio
 * output that records what was played and when it was flushed. Plus the PCM
 * helpers the real transport will use.
 *
 *   node --test "src/app/interview/?token?/_live/live-transport.test.ts"   (?token? matches [token]: brackets would be read as a glob)
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { createTransport, TransportUnavailableError } = await import("./transport.ts");
const { MockVoxAgent, FINISH_LINE, REPEAT_LEAD, LISTEN_MS, mockScript } = await import(
  "./mock-voxagent.ts"
);
const { MOCK_SCRIPT_IDS } = await import("../../../../lib/interviews/live-provider/types.ts");
const audio = await import("./audio-io.ts");

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let next = 0;
  const queue = [];
  return {
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
        await Promise.resolve();
      }
      now = end;
    },
    get pending() {
      return queue.length;
    },
  };
}

function fakeAudio() {
  const log = [];
  return {
    log,
    play(samples, rate) {
      log.push(["play", samples.length, rate]);
    },
    flush() {
      log.push(["flush"]);
    },
  };
}

/** Run a script to its end, collecting every event. */
async function run(script, during = async () => {}) {
  const clock = fakeClock();
  const out = fakeAudio();
  const t = new MockVoxAgent(script, { interviewerName: "Maya", clock });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: out });
  await during(t, clock, events);
  await clock.advance(10 * 60_000);
  return { events, out, clock, t };
}
const kinds = (events) =>
  events.map((e) =>
    e.type === "agent" ? `agent:${e.state}` : e.type === "agent_text" ? "text" : e.type,
  );

/* ── every script ends as written ─────────────────────────────── */

test("every script starts, speaks, listens and ends exactly once, with the end the provider would send", async () => {
  const want = {
    completed: { type: "ended", endReason: "completed", graceful: true },
    interruption: { type: "ended", endReason: "completed", graceful: true },
    candidate_ends: { type: "ended", endReason: "completed", graceful: true },
    timed_out: { type: "ended", endReason: "timed_out", graceful: false },
    provider_error: { type: "error", code: "provider_error" },
    connection_lost: { type: "dropped" },
  };
  for (const id of MOCK_SCRIPT_IDS) {
    const { events, clock } = await run(id);
    assert.deepEqual(events[0], { type: "started" }, id);
    const last = events.at(-1);
    assert.deepEqual(last, want[id], id);
    const ends = events.filter((e) => ["ended", "dropped", "error"].includes(e.type));
    assert.equal(ends.length, 1, `${id}: one end`);
    assert.ok(
      kinds(events).includes("agent:speaking") && kinds(events).includes("agent:listening"),
      id,
    );
    assert.equal(clock.pending, 0, `${id}: nothing left running`);
  }
});

test("captions: every spoken line is sent as text, and the interviewer's name comes from the session", async () => {
  const { events } = await run("completed");
  const lines = events.filter((e) => e.type === "agent_text").map((e) => e.text);
  assert.match(lines[0], /^Hi, I'm Maya\./);
  // Each automatic interruption adds two lines: the known line and the question again.
  const steps = mockScript("completed", "Maya");
  const said = steps.filter((s) => "say" in s).length;
  const cutOff = steps.filter((s) => "interruptAtMs" in s).length;
  assert.equal(lines.length, said + 2 * cutOff);
});

test("the completed script: three questions, a follow-up, an interruption and the question again, the closing line, then a completed end", async () => {
  const { events } = await run("completed");
  const texts = events.filter((e) => e.type === "agent_text").map((e) => e.text);
  const questions = mockScript("completed", "Maya").filter((s) => s.question);
  assert.equal(questions.length, 4, "three main questions and one follow-up");
  for (const q of questions) assert.ok(texts.includes(q.say), q.say);
  const at = texts.indexOf(FINISH_LINE);
  assert.ok(at > 0, "the interruption line is said");
  assert.equal(texts[at + 1], texts[at - 1], "then the cut-off question again, in full");
  assert.equal(events.filter((e) => e.type === "interrupted").length, 1);
  assert.match(texts.at(-1), /^That's everything I wanted to ask\./, "the closing line is last");
  assert.deepEqual(events.at(-1), { type: "ended", endReason: "completed", graceful: true });
  assert.equal(
    events.filter((e) => e.type === "agent" && e.state === "listening").length,
    5,
    "four answers and the moment of the interruption",
  );
});

test("the mock cannot hear: an answer ends after LISTEN_MS, not before, unless Answer finished is pressed", async () => {
  assert.equal(LISTEN_MS, 15_000);
  const clock = fakeClock();
  const t = new MockVoxAgent("completed", { interviewerName: "Maya", clock });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: fakeAudio() });
  const state = () => events.filter((e) => e.type === "agent").at(-1)?.state;
  while (state() !== "listening") await clock.advance(10);
  await clock.advance(LISTEN_MS - 20);
  assert.equal(state(), "listening", "still waiting just before LISTEN_MS");
  await clock.advance(20);
  assert.equal(state(), "thinking", "moves on at LISTEN_MS");
});

test("Ask to repeat while listening: the line, then the last question again, then listening again; while speaking it does nothing", async () => {
  const clock = fakeClock();
  const t = new MockVoxAgent("candidate_ends", { interviewerName: "Maya", clock });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: fakeAudio() });
  const state = () => events.filter((e) => e.type === "agent").at(-1)?.state;
  const texts = () => events.filter((e) => e.type === "agent_text").map((e) => e.text);
  const q1 = mockScript("candidate_ends", "Maya")[1].say;
  while (state() !== "listening") await clock.advance(10);
  t.signal("repeat");
  while (texts().at(-1) !== q1 || state() !== "listening") await clock.advance(10);
  assert.deepEqual(texts().slice(-2), [REPEAT_LEAD, q1]);
  // Asked again: the same, a second time.
  t.signal("repeat");
  await clock.advance(1);
  assert.equal(texts().at(-1), REPEAT_LEAD);
  assert.equal(state(), "speaking");
  // While she is speaking, it does nothing.
  const said = texts().length;
  t.signal("repeat");
  await clock.advance(1);
  assert.equal(texts().length, said);
  while (texts().at(-1) !== q1 || state() !== "listening") await clock.advance(10);
  assert.equal(texts().filter((x) => x === REPEAT_LEAD).length, 2);
});

test("interruption: her audio is flushed at once, then the known line, then the question again in full", async () => {
  const { events, out } = await run("interruption");
  const k = kinds(events);
  const at = k.indexOf("interrupted");
  assert.ok(at > 0, "interrupted");
  const texts = events.filter((e) => e.type === "agent_text").map((e) => e.text);
  const q1 = texts[1];
  assert.deepEqual(
    texts.slice(1, 4),
    [q1, FINISH_LINE, q1],
    "cut off, the line, the question again",
  );
  // The flush comes right after the cut-off question started playing, before anything else plays.
  const flushAt = out.log.findIndex((x) => x[0] === "flush");
  assert.equal(out.log[flushAt - 1][0], "play");
  assert.equal(out.log.filter((x) => x[0] === "play").length, texts.length);
  assert.equal(k[at + 1], "agent:listening", "the candidate is heard");
});

test("the line said after an interruption is the one the importer accepts (D9, F11)", async () => {
  // live-ingest.ts REPEAT_LEAD_INS holds the approved phrases; the mock must say one of them.
  const ingest = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../../../lib/interviews/live-ingest.ts", import.meta.url), "utf8"),
  );
  const leadIns = ingest.slice(
    ingest.indexOf("REPEAT_LEAD_INS"),
    ingest.indexOf("];", ingest.indexOf("REPEAT_LEAD_INS")),
  );
  assert.ok(leadIns.includes(`"${FINISH_LINE}"`), "FINISH_LINE is one of the approved lead-ins");
});

test("a cut-in signal mid-question interrupts; mid-answer it does nothing; answer_done ends a listen early", async () => {
  // candidate_ends: no automatic interruption, so every one counted here is the signal's.
  const { events } = await run("candidate_ends", async (t, clock, ev) => {
    await clock.advance(1000); // greeting playing
    t.signal("cut_in");
    await clock.advance(1);
    assert.equal(ev.filter((e) => e.type === "interrupted").length, 1);
    // Into the first answer.
    while (
      !(
        ev.at(-1)?.type === "agent" &&
        ev.at(-1).state === "listening" &&
        ev.filter((e) => e.type === "agent_text").length >= 4
      )
    ) {
      await clock.advance(250);
    }
    t.signal("cut_in");
    t.signal("answer_done");
    await clock.advance(1);
    assert.equal(ev.at(-1).state, "thinking", "answer_done moved on at once");
  });
  assert.equal(
    events.filter((e) => e.type === "interrupted").length,
    1,
    "the cut-in while listening did nothing",
  );
});

/* ── End, drop, close ─────────────────────────────────────────── */

test("End: the provider ends the session as the candidate's own (candidate_left, not graceful)", async () => {
  const { events, out } = await run("candidate_ends", async (t, clock) => {
    await clock.advance(15_000);
    t.end();
  });
  assert.deepEqual(events.at(-1), { type: "ended", endReason: "candidate_left", graceful: false });
  assert.equal(events.filter((e) => e.type === "ended").length, 1);
  assert.equal(out.log.at(-1)[0], "flush", "her voice stops when End is pressed");
});

test("drop: closes with dropped and nothing after; close(): silent, nothing more is emitted", async () => {
  const dropped = await run("completed", async (t, clock) => {
    await clock.advance(3000);
    t.signal("drop");
  });
  assert.deepEqual(dropped.events.at(-1), { type: "dropped" });
  const closed = await run("completed", async (t, clock, ev) => {
    await clock.advance(3000);
    const before = ev.length;
    t.close();
    await clock.advance(60_000);
    assert.equal(ev.length, before);
  });
  assert.ok(closed.events.length > 0);
});

/* ── the adapter's line ───────────────────────────────────────── */

test("createTransport: the mock for a mock ticket; no browser end-of-turn detection; no real VoxAgent yet", () => {
  const t = createTransport(
    { mode: "mock", script: "completed", turnDetection: "server" },
    { interviewerName: "Maya" },
  );
  assert.ok(t instanceof MockVoxAgent);
  assert.throws(
    () =>
      createTransport(
        { mode: "mock", script: "completed", turnDetection: "client" },
        { interviewerName: "Maya" },
      ),
    (e) => e instanceof TransportUnavailableError && e.code === "turn_detection",
  );
  assert.throws(
    () =>
      createTransport(
        {
          mode: "voxagent",
          wsUrl: "wss://x",
          wsToken: "t",
          upstreamHz: 16000,
          downstreamHz: 24000,
          turnDetection: "server",
        },
        { interviewerName: "Maya" },
      ),
    (e) => e instanceof TransportUnavailableError && e.code === "provider",
  );
});

/* ── PCM ──────────────────────────────────────────────────────── */

test("PCM: s16le both ways, clipped; downsample 48 kHz to 16 kHz by averaging", () => {
  const f = new Float32Array([0, 1, -1, 0.5, 2, -2]);
  assert.deepEqual([...audio.floatToInt16(f)], [0, 32767, -32768, 16384, 32767, -32768]);
  const back = audio.int16ToFloat(new Int16Array([0, 32767, -32768]));
  assert.deepEqual([...back], [0, 1, -1]);
  const down = audio.downsample(new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6]), 48_000, 16_000);
  assert.equal(down.length, 2);
  assert.ok(Math.abs(down[0] - 0.3) < 1e-6 && Math.abs(down[1] - 0.6) < 1e-6);
  assert.throws(() => audio.downsample(new Float32Array(4), 16_000, 24_000));
  assert.equal(audio.UPSTREAM_HZ, 16_000);
  assert.equal(audio.DOWNSTREAM_HZ, 24_000);
});

test("playback: chunks back to back; a flush (an interruption) plays the next chunk at once", () => {
  const c = new audio.PlaybackClock();
  assert.equal(c.schedule(10, 2), 10);
  assert.equal(c.schedule(10.5, 1), 12, "queued after the first");
  assert.equal(c.queued(11), 2);
  c.flush();
  assert.equal(c.queued(11), 0);
  assert.equal(c.schedule(11, 1), 11, "after a flush, now");
});

test("the mock voice is 24 kHz and as long as its line, within bounds", () => {
  const short = audio.synthVoice("Hi.");
  const long = audio.synthVoice("x".repeat(1000));
  assert.equal(audio.durationOf(short, 24_000), 1.2);
  assert.equal(audio.durationOf(long, 24_000), 9);
});
