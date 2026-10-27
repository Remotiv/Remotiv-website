/**
 * AVI commit 10 demo: the mock interviewer's spoken clips
 * (dev-assets/mock-voice, generated from mock-lines.ts). The words match the
 * captions exactly, the clips are 24 kHz mono s16le speech, MockVoxAgent
 * plays them through the real audio output (so an interruption's flush is
 * the real one), and only the preview ever loads them.
 *
 *   node --test "src/app/interview/?token?/_live/live-mock-voice.test.ts"   (?token? matches [token]: brackets would be read as a glob)
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { MOCK_LINES, MOCK_INTERVIEWER, greetingLine } = await import("./mock-lines.ts");
const { MockVoxAgent, mockScript, FINISH_LINE, REPEAT_LEAD, CUT_IN_MS, MOCK_SCRIPT_VERSION } =
  await import("./mock-voxagent.ts");
const { synthVoice } = await import("./audio-io.ts");
const { MOCK_SCRIPT_IDS } = await import("../../../../lib/interviews/live-provider/types.ts");
const { GET } = await import("../../preview-live/voice/[clip]/route.ts");
const { loadPreviewVoice } = await import("../../preview-live/mock-voice.ts");

const CLIPS = new URL("../../../../../dev-assets/mock-voice/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", CLIPS), "utf8"));
const clip = (id) => {
  const b = readFileSync(new URL(`${id}.pcm`, CLIPS));
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
};

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
        await Promise.resolve();
      }
      now = end;
    },
  };
}

/** Records what is played (the samples themselves) and when it is flushed. */
function fakeAudio(clock) {
  const log = [];
  return {
    log,
    play(samples, rate) {
      log.push({ at: clock.now, kind: "play", samples, rate });
    },
    flush() {
      log.push({ at: clock.now, kind: "flush" });
    },
  };
}

const voice = () => new Map(Object.entries(MOCK_LINES).map(([id, text]) => [text, clip(id)]));

/* ── the words match the captions ─────────────────────────────── */

test("every line any script says, for the demo's interviewer, has a spoken clip of exactly those words", () => {
  const texts = new Set(Object.values(MOCK_LINES));
  for (const id of MOCK_SCRIPT_IDS) {
    for (const step of mockScript(id, MOCK_INTERVIEWER)) {
      if ("say" in step) assert.ok(texts.has(step.say), `${id}: ${step.say}`);
    }
  }
  assert.ok(
    texts.has(FINISH_LINE) && texts.has(REPEAT_LEAD),
    "the interruption line and the repeat lead",
  );
  assert.equal(MOCK_LINES.greeting, greetingLine(MOCK_INTERVIEWER));
});

test("the clips were generated from these exact words: the manifest matches mock-lines.ts line for line", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.clips).map(([id, c]) => [id, c.text])),
    { ...MOCK_LINES },
  );
  assert.deepEqual(
    [manifest.voice, manifest.sampleRate, manifest.encoding, manifest.channels],
    ["Samantha", 24_000, "s16le", 1],
  );
});

test("every clip is 24 kHz mono s16le speech: the recorded size, a length that fits its words, not silent, not clipped", () => {
  let total = 0;
  for (const [id, text] of Object.entries(MOCK_LINES)) {
    const bytes = statSync(new URL(`${id}.pcm`, CLIPS)).size;
    total += bytes;
    assert.equal(bytes, manifest.clips[id].bytes, id);
    assert.equal(bytes % 2, 0, `${id}: whole 16-bit samples`);
    const samples = clip(id);
    const seconds = samples.length / 24_000;
    // Speech runs at roughly 40 to 110 ms a character.
    assert.ok(
      seconds > text.length * 0.035 && seconds < text.length * 0.11 + 0.6,
      `${id}: ${seconds}s`,
    );
    let sum = 0;
    let peak = 0;
    for (const v of samples) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sum / samples.length);
    assert.ok(rms > 300, `${id}: audible (rms ${Math.round(rms)})`);
    assert.ok(peak < 32767, `${id}: not clipped`);
  }
  assert.equal(total, 1_891_418, "the total size reported");
});

/* ── played through the real path ─────────────────────────────── */

test("MockVoxAgent plays the clip for each line, the very samples, at 24 kHz, and moves on when it ends", async () => {
  const clock = fakeClock();
  const out = fakeAudio(clock);
  const v = voice();
  const t = new MockVoxAgent("completed", {
    interviewerName: MOCK_INTERVIEWER,
    clock,
    voice: async () => v,
  });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: out });
  await clock.advance(400);
  const first = out.log[0];
  assert.equal(first.samples, v.get(MOCK_LINES.greeting), "the greeting clip itself");
  assert.equal(first.rate, 24_000);
  const greetingMs = (first.samples.length / 24_000) * 1000;
  await clock.advance(greetingMs - 1);
  assert.equal(out.log.length, 1, "still speaking until the clip ends");
  await clock.advance(1);
  assert.equal(out.log[1].samples, v.get(MOCK_LINES.q1), "then the first question's clip");
  assert.deepEqual(
    events.filter((e) => e.type === "agent_text").map((e) => e.text),
    [MOCK_LINES.greeting, MOCK_LINES.q1],
  );
});

test("interrupted: the audio is flushed at that moment, then the line's clip, then the question's clip again", async () => {
  const clock = fakeClock();
  const out = fakeAudio(clock);
  const v = voice();
  const t = new MockVoxAgent("interruption", {
    interviewerName: MOCK_INTERVIEWER,
    clock,
    voice: async () => v,
  });
  await t.connect({ mic: null, audioOut: out });
  await clock.advance(60_000);
  const plays = out.log.filter((x) => x.kind === "play");
  const flush = out.log.find((x) => x.kind === "flush");
  const q1 = plays.find((x) => x.samples === v.get(MOCK_LINES.q1));
  assert.equal(
    flush.at - q1.at,
    CUT_IN_MS,
    "cut off 1.2 seconds into the question, before its clip ended",
  );
  assert.equal(CUT_IN_MS, 1_200);
  assert.ok(flush.at - q1.at < (q1.samples.length / 24_000) * 1000);
  const after = plays.filter((x) => x.at > flush.at).map((x) => x.samples);
  assert.equal(after[0], v.get(FINISH_LINE));
  assert.equal(after[1], v.get(MOCK_LINES.q1), "the real spoken question again");
});

test("Ask to repeat plays the repeat line's clip and then the question's own clip", async () => {
  const clock = fakeClock();
  const out = fakeAudio(clock);
  const v = voice();
  const t = new MockVoxAgent("candidate_ends", {
    interviewerName: MOCK_INTERVIEWER,
    clock,
    voice: async () => v,
  });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: out });
  const listening = () => events.filter((e) => e.type === "agent").at(-1)?.state === "listening";
  while (!listening()) await clock.advance(50);
  const before = out.log.length;
  t.signal("repeat");
  while (out.log.length < before + 2) await clock.advance(50);
  assert.deepEqual(
    out.log.slice(before).map((x) => x.samples),
    [v.get(REPEAT_LEAD), v.get(MOCK_LINES.q1)],
  );
});

test("a line with no clip (another interviewer's name, or a failed load) falls back to the tone; the interview still runs", async () => {
  const clock = fakeClock();
  const out = fakeAudio(clock);
  const t = new MockVoxAgent("completed", {
    interviewerName: "Maya",
    clock,
    voice: async () => voice(),
  });
  await t.connect({ mic: null, audioOut: out });
  await clock.advance(400);
  assert.deepEqual(
    [...out.log[0].samples.slice(0, 50)],
    [...synthVoice(greetingLine("Maya")).slice(0, 50)],
  );

  const failing = new MockVoxAgent("completed", {
    interviewerName: MOCK_INTERVIEWER,
    clock: fakeClock(),
    voice: async () => {
      throw new Error("offline");
    },
  });
  const events = [];
  failing.subscribe((e) => events.push(e));
  await failing.connect({ mic: null, audioOut: fakeAudio(clock) });
  assert.equal(events.length, 0, "connect resolved; the conversation starts on the clock as usual");
});

/* ── preview only ─────────────────────────────────────────────── */

test("the clip route: a known id is served as raw PCM; any other name is 404; a production build is always 404", async () => {
  const get = (id) =>
    GET(new Request(`http://x/interview/preview-live/voice/${id}`), {
      params: Promise.resolve({ clip: id }),
    });
  const ok = await get("q1");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/octet-stream");
  const body = new Uint8Array(await ok.arrayBuffer());
  assert.equal(body.length, manifest.clips.q1.bytes);
  for (const bad of ["../../package", "q1.pcm", "manifest", "generate", "constructor"]) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal((await get("q1")).status, 404);
  } finally {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
});

test("the preview's loader keys each clip by its exact words, and leaves out one that fails", async () => {
  const fake = async (url) => {
    const id = url.split("/").pop();
    if (id === "closing") return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    if (id === "q2") return { ok: true, arrayBuffer: async () => new ArrayBuffer(3) };
    return { ok: true, arrayBuffer: async () => new Int16Array([1, 2, 3]).buffer };
  };
  const v = await loadPreviewVoice(fake);
  assert.deepEqual([...v.get(MOCK_LINES.q1)], [1, 2, 3]);
  assert.equal(v.has(MOCK_LINES.closing), false, "a failed fetch: tone");
  assert.equal(v.has(MOCK_LINES.q2), false, "half a sample: tone");
});

test("the real candidate page never loads the clips; only the preview passes a voice", () => {
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  for (const f of ["../page.tsx", "./live-flow.tsx", "./live-server.ts", "./screens.tsx"]) {
    // No import of the preview's clips or loader (a comment may name the preview).
    assert.doesNotMatch(src(f), /from ["'][^"']*(preview-live|mock-voice)[^"']*["']/, f);
    assert.doesNotMatch(src(f), /loadPreviewVoice|\/voice\//, f);
  }
  // LiveInterviewFlow (the real page's) passes no voice.
  const flow = src("./live-flow.tsx");
  const real = flow.slice(
    flow.indexOf("export function LiveInterviewFlow"),
    flow.indexOf("export function LiveFlowCore"),
  );
  assert.doesNotMatch(real, /mockVoice/);
  const preview = src("../../preview-live/_preview-live.tsx");
  assert.match(preview, /mockVoice=\{voice\}/, "the preview passes its voice");
  assert.match(
    preview,
    /loading \?\?= loadPreviewVoice\(\)/,
    "loaded once, from the preview's loader",
  );
  // The clips live outside src/ and public/: never in a bundle, never served as a static file.
  assert.ok(statSync(new URL("q1.pcm", CLIPS)).isFile());
  assert.throws(() => statSync(new URL("../../../../../public/mock-voice", import.meta.url)));
});

test("the cut-in always lands while the question is playing: clamped inside a short clip, never after it ends", async () => {
  const run = async (clipMs) => {
    const clock = fakeClock();
    const out = fakeAudio(clock);
    const v = voice();
    v.set(MOCK_LINES.q1, new Int16Array(Math.round((clipMs / 1000) * 24_000)));
    const t = new MockVoxAgent("interruption", {
      interviewerName: MOCK_INTERVIEWER,
      clock,
      voice: async () => v,
    });
    const events = [];
    t.subscribe((e) => events.push(e));
    await t.connect({ mic: null, audioOut: out });
    await clock.advance(120_000);
    const q1 = out.log.find((x) => x.samples === v.get(MOCK_LINES.q1));
    const flush = out.log.find((x) => x.kind === "flush");
    return { events, cutAfter: flush ? flush.at - q1.at : null };
  };
  // A 1-second question: cut 0.4 s before its end, at 0.6 s.
  assert.equal((await run(1000)).cutAfter, 600);
  // A question shorter than 0.4 s: no cut at all, and no stray one later while she listens.
  const tiny = await run(300);
  assert.equal(tiny.cutAfter, null);
  assert.equal(tiny.events.filter((e) => e.type === "interrupted").length, 0);
  assert.deepEqual(tiny.events.at(-1), { type: "ended", endReason: "completed", graceful: true });
});

test("each demo signal says whether it did something: repeat only while listening, cut-in only while speaking", async () => {
  const clock = fakeClock();
  const t = new MockVoxAgent("candidate_ends", {
    interviewerName: MOCK_INTERVIEWER,
    clock,
    voice: async () => voice(),
  });
  const events = [];
  t.subscribe((e) => events.push(e));
  assert.equal(t.signal("repeat"), false, "not running yet");
  await t.connect({ mic: null, audioOut: fakeAudio(clock) });
  await clock.advance(500);
  const state = () => events.filter((e) => e.type === "agent").at(-1)?.state;
  assert.equal(state(), "speaking");
  assert.equal(t.signal("repeat"), false, "repeat while she speaks: not sent");
  assert.equal(t.signal("answer_done"), false, "answer finished while she speaks: not sent");
  while (state() !== "listening") await clock.advance(50);
  assert.equal(t.signal("cut_in"), false, "cut in while she listens: not sent");
  assert.equal(t.signal("repeat"), true, "repeat while she listens: sent");
  while (state() !== "listening") await clock.advance(50);
  assert.equal(t.signal("answer_done"), true);
  assert.equal(t.signal("drop"), true);
  assert.equal(t.signal("drop"), false, "over: nothing more");
});

test("the demo panel says plainly the mock can't hear, labels each button Simulate, notes every press, and shows the script version", () => {
  const src = readFileSync(
    new URL("../../preview-live/_preview-live.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /Demo controls \(the mock can't hear you\)/);
  for (const label of [
    "Simulate: candidate asks to repeat",
    "Simulate: candidate cuts in",
    "Simulate: answer finished",
    "Simulate: connection drop",
  ]) {
    assert.ok(src.includes(`"${label}"`), label);
  }
  assert.match(src, /data-demo-note/);
  assert.match(src, /interrupted \(the script's cut-in\)/);
  assert.match(src, /\{MOCK_SCRIPT_VERSION\}/);
  assert.match(MOCK_SCRIPT_VERSION, /^mock-scripts \d+/);
});
