/**
 * The demo's "Real Sarah voice (Arham's session)" script: the replay built
 * from a session JSON, played through MockVoxAgent, and served by two
 * development-only routes from a folder outside the repository.
 *
 * The real session folder is never needed: a throwaway folder in the system
 * temp directory holds the committed sanitised fixture (same structure and
 * clip names) and generated WAVs.
 *
 *   node --test src/app/interview/preview-live/arham-replay.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = { "server-only": "" };
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { buildReplayScript, clipIdOf, readWav, isPlaybackFormat } = await import(
  "./arham-replay.ts"
);
const { arhamReplayAvailable, ARHAM_SESSION_ENV } = await import("./arham-session.ts");
const { GET: getScript } = await import("./arham/script/route.ts");
const { GET: getClip } = await import("./arham/clip/[clip]/route.ts");
const { MockVoxAgent, CUT_IN_MS, FINISH_LINE } = await import("../[token]/_live/mock-voxagent.ts");

const SESSION = JSON.parse(
  readFileSync(
    new URL(
      "../../../lib/interviews/live-provider/__fixtures__/sample-export-ftest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const INTERVIEWER = SESSION.turns.filter((t) => t.role === "interviewer");
const QUESTION_3 = SESSION.turns[14];
const LINE = SESSION.turns[16];
const REPEAT = SESSION.turns[17];

/** A WAV file: 16-bit mono PCM at `rate`, `ms` long, a soft tone so it is not silent. */
function wav(rate, ms) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 7)), 44 + i * 2);
  return b;
}

/** A session folder like Arham's, in the temp directory: session.json and every interviewer clip. */
function sessionFolder() {
  const dir = mkdtempSync(join(tmpdir(), "arham-test-"));
  writeFileSync(join(dir, "session.json"), JSON.stringify(SESSION));
  for (const t of INTERVIEWER) writeFileSync(join(dir, t.audio_file), wav(24_000, 200));
  // A candidate clip and a clip no turn names, as in the real folder: never served.
  writeFileSync(join(dir, "candidate_turn_000.wav"), wav(16_000, 200));
  writeFileSync(join(dir, "interviewer_turn_044.wav"), wav(24_000, 200));
  return dir;
}

async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const clip = (id) =>
  getClip(new Request(`http://x/c/${id}`), { params: Promise.resolve({ clip: id }) });

/* ── the script ───────────────────────────────────────────────── */

test("the replay follows the session JSON: each of Sarah's turns with her own clip and the JSON's words; each answer is listening", () => {
  const { steps, clips } = buildReplayScript(SESSION);
  const said = steps.filter((s) => "say" in s);
  assert.equal(said.length, INTERVIEWER.length, "every interviewer turn, in order");
  assert.deepEqual(
    said.map((s) => [s.say, s.clip]),
    INTERVIEWER.map((t) => [t.text, t.audio_file.replace(/\.wav$/, "")]),
  );
  assert.deepEqual(
    clips,
    INTERVIEWER.map((t) => clipIdOf(t.audio_file)),
  );
  assert.ok(
    clips.every((c) => /^interviewer_turn_\d{3}$/.test(c)),
    "never a candidate clip",
  );
  const answers = SESSION.turns.filter((t) => t.role === "candidate" && t.turn_type === "answer");
  assert.equal(steps.filter((s) => "listen" in s).length, answers.length);
  // Questions (and only they) can be repeated on request.
  assert.deepEqual(
    said.filter((s) => s.question).map((s) => s.clip),
    INTERVIEWER.filter((t) => ["base_question", "follow_up", "repeat"].includes(t.turn_type)).map(
      (t) => clipIdOf(t.audio_file),
    ),
  );
  // The session's own ending, as sent.
  assert.deepEqual(steps.at(-1), { end: "in_progress", graceful: false });
});

test("the interruption: the question the session's line cut off is cut at 1.2 s, then the session's own line and repeat clips", () => {
  const { steps } = buildReplayScript(SESSION);
  const said = steps.filter((s) => "say" in s);
  const cutAt = said.findIndex((s) => s.interruptAtMs !== undefined);
  assert.deepEqual(
    [said[cutAt].clip, said[cutAt].interruptAtMs, said[cutAt].cutContinues],
    [clipIdOf(QUESTION_3.audio_file), CUT_IN_MS, true],
  );
  assert.equal(said.filter((s) => s.interruptAtMs !== undefined).length, 1, "only that question");
  assert.deepEqual(
    [said[cutAt + 1].clip, said[cutAt + 1].say, said[cutAt + 2].clip, said[cutAt + 2].say],
    [clipIdOf(LINE.audio_file), LINE.text, clipIdOf(REPEAT.audio_file), REPEAT.text],
  );
  // The candidate's interruption turn is no step: it is the cut-in itself.
  assert.equal(steps.filter((s) => "listen" in s).length, 19);
});

test("not a session: no script; a clip name is only ever an interviewer_turn_NNN.wav", () => {
  assert.equal(buildReplayScript(null), null);
  assert.equal(buildReplayScript({ turns: [] }), null);
  assert.equal(clipIdOf("interviewer_turn_007.wav"), "interviewer_turn_007");
  for (const bad of [
    "candidate_turn_000.wav",
    "../interviewer_turn_000.wav",
    "interviewer_turn_7.wav",
    "x.wav",
    3,
  ]) {
    assert.equal(clipIdOf(bad), null, String(bad));
  }
});

/* ── played through the mock ──────────────────────────────────── */

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
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
    },
  };
}

test("MockVoxAgent plays the replay: each turn's own clip in order, the real cut at 1.2 s with no stock line added, the session's end", async () => {
  const { steps, clips } = buildReplayScript(SESSION);
  const voice = new Map(clips.map((id) => [id, new Int16Array(24_000 * 2)]));
  const clock = fakeClock();
  const played = [];
  const audio = {
    play: (samples) => played.push({ at: clock.now, samples }),
    flush: () => played.push({ at: clock.now, flush: true }),
  };
  const t = new MockVoxAgent("completed", {
    interviewerName: "Sarah",
    clock,
    voice: async () => voice,
    steps: async () => steps,
  });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: audio });
  await clock.advance(30 * 60_000);
  const plays = played.filter((p) => p.samples);
  assert.deepEqual(
    plays.map((p) => p.samples),
    clips.map((id) => voice.get(id)),
    "each recorded turn, once, in order",
  );
  const flush = played.find((p) => p.flush);
  const q3 = plays.find((p) => p.samples === voice.get(clipIdOf(QUESTION_3.audio_file)));
  assert.equal(flush.at - q3.at, CUT_IN_MS, "cut 1.2 s into her real question");
  const texts = events.filter((e) => e.type === "agent_text").map((e) => e.text);
  assert.equal(
    texts.filter((x) => x === FINISH_LINE).length,
    1,
    "her own line once, never a second stock one",
  );
  assert.deepEqual(events.at(-1), { type: "ended", endReason: "in_progress", graceful: false });
});

test("Ask to repeat during the replay plays the question's own recorded clip again", async () => {
  const { steps, clips } = buildReplayScript(SESSION);
  const voice = new Map(clips.map((id) => [id, new Int16Array(2_400)]));
  const clock = fakeClock();
  const played = [];
  const t = new MockVoxAgent("completed", {
    interviewerName: "Sarah",
    clock,
    voice: async () => voice,
    steps: async () => steps,
  });
  const events = [];
  t.subscribe((e) => events.push(e));
  await t.connect({ mic: null, audioOut: { play: (s) => played.push(s), flush() {} } });
  while (!(events.filter((e) => e.type === "agent").at(-1)?.state === "listening"))
    await clock.advance(20);
  const q1 = voice.get(clipIdOf(SESSION.turns[1].audio_file));
  assert.equal(t.signal("repeat"), true);
  while (
    played.at(-1) !== q1 ||
    events.filter((e) => e.type === "agent").at(-1)?.state !== "listening"
  ) {
    await clock.advance(20);
  }
  assert.equal(played.filter((s) => s === q1).length, 2, "the first question's own clip, again");
});

/* ── the WAV reader ───────────────────────────────────────────── */

test("readWav: the PCM samples and the format; only 24 kHz mono 16-bit is played as is", () => {
  const w = readWav(new Uint8Array(wav(24_000, 100)));
  assert.deepEqual(
    [w.format, w.channels, w.rate, w.bits, w.data.length],
    [1, 1, 24_000, 16, 4_800],
  );
  assert.equal(isPlaybackFormat(w), true);
  assert.equal(isPlaybackFormat(readWav(new Uint8Array(wav(16_000, 100)))), false);
  assert.equal(readWav(new Uint8Array(Buffer.from("not a wav file at all"))), null);
});

/* ── served in development only, from outside the repository ──── */

test("unset, missing, or production: no replay offered, and both routes answer 404", async () => {
  const dir = sessionFolder();
  try {
    for (const env of [
      { [ARHAM_SESSION_ENV]: undefined },
      { [ARHAM_SESSION_ENV]: join(dir, "nope") },
      { [ARHAM_SESSION_ENV]: "relative/path" },
      { [ARHAM_SESSION_ENV]: dir, NODE_ENV: "production" },
    ]) {
      await withEnv(env, async () => {
        assert.equal(arhamReplayAvailable(), false, JSON.stringify(env));
        assert.equal((await getScript()).status, 404);
        assert.equal((await clip("interviewer_turn_000")).status, 404);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: the script, and only the clips the session names, as raw PCM; candidate audio and other names are 404", async () => {
  const dir = sessionFolder();
  try {
    await withEnv({ [ARHAM_SESSION_ENV]: dir }, async () => {
      assert.equal(arhamReplayAvailable(), true);
      const script = await (await getScript()).json();
      assert.equal(script.clips.length, INTERVIEWER.length);
      const ok = await clip("interviewer_turn_000");
      assert.equal(ok.status, 200);
      assert.equal(
        (await ok.arrayBuffer()).byteLength,
        24_000 * 0.2 * 2,
        "the samples, no WAV header",
      );
      for (const bad of [
        "candidate_turn_000",
        "interviewer_turn_044",
        "interviewer_turn_999",
        "..%2Fsession",
        "session",
      ]) {
        assert.equal((await clip(bad)).status, 404, bad);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clip in another format is converted (afconvert) into a cache in the temp folder, never the repository", {
  skip: !existsSync("/usr/bin/afconvert"),
}, async () => {
  const dir = sessionFolder();
  writeFileSync(join(dir, INTERVIEWER[0].audio_file), wav(16_000, 500));
  try {
    await withEnv({ [ARHAM_SESSION_ENV]: dir }, async () => {
      const res = await clip(clipIdOf(INTERVIEWER[0].audio_file));
      assert.equal(res.status, 200);
      const bytes = (await res.arrayBuffer()).byteLength;
      assert.ok(Math.abs(bytes - 24_000 * 0.5 * 2) <= 4, `resampled to 24 kHz (${bytes} bytes)`);
    });
    const cacheRoot = join(tmpdir(), "remotiv-preview-arham");
    assert.ok(existsSync(cacheRoot), "the cache is in the temp folder");
    const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    assert.ok(!cacheRoot.startsWith(repo), "outside the repository");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing from a session folder is in the repository: no .wav tracked, no turn clip anywhere, .pcm only the Samantha clips", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
  assert.deepEqual(
    tracked.filter((f) => /\.wav$/i.test(f)),
    [],
    "no WAV is tracked",
  );
  assert.deepEqual(
    tracked.filter((f) => /(interviewer|candidate)_turn_\d+/.test(f)),
    [],
    "no session clip is tracked",
  );
  assert.ok(
    tracked.filter((f) => f.endsWith(".pcm")).every((f) => f.startsWith("dev-assets/mock-voice/")),
    "the only PCM in the repository is the generated Samantha set",
  );
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
  }).split("\n");
  assert.deepEqual(
    untracked.filter((f) => /\.(wav|pcm)$/i.test(f)),
    [],
    "and none waiting to be added",
  );
});

test("the preview offers the replay only when the server found the folder; the candidate page never sees any of it", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(page, /arhamReplay=\{arhamReplayAvailable\(\)\}/);
  const preview = readFileSync(new URL("./_preview-live.tsx", import.meta.url), "utf8");
  assert.match(
    preview,
    /const scripts = arhamReplay \? \[\.\.\.SCRIPTS, ARHAM_REPLAY\] : SCRIPTS;/,
  );
  for (const f of ["../[token]/page.tsx", "../[token]/_live/live-flow.tsx"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /arham/i, f);
  }
});
