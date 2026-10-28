/**
 * B4: whether a candidate turn's audio could hold an answer (turn-speech.ts),
 * measured from the audio itself, for a transcript that came back empty.
 *
 *   node --test src/lib/interviews/turn-speech.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  turnSpeech,
  mayHoldAnswer,
  readPcm16Wav,
  speechMs,
  SOUND_RMS,
  SHORT_CLIP_MS,
  MIN_SOUND_SHORT_MS,
  MIN_SOUND_MS,
  MIN_RUN_MS,
} = await import("./turn-speech.ts");

const RATE = 16_000;
/** RMS level in dBFS as a sine's peak, as a fraction of full scale. */
const peak = (db) => 10 ** (db / 20) * Math.SQRT2;

/**
 * A PCM WAV, `ms` long at 16 kHz: a 220 Hz tone at `db` (RMS, dBFS) for
 * `soundMs` from `fromMs`, `hissDb` of hiss under everything, and a one-sample
 * full-scale click at each of `clicksAt` (ms).
 */
function wav(
  ms,
  { soundMs = 0, fromMs = 0, db = -20, hissDb = null, clicksAt = [], channels = 1, bits = 16 } = {},
) {
  const frames = Math.round((RATE * ms) / 1000);
  const width = bits / 8;
  const data = frames * channels * width;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const tag = (at, t) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = t.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(34, bits, true);
  tag(36, "data");
  view.setUint32(40, data, true);
  if (bits !== 16) return bytes;
  const from = Math.round((RATE * fromMs) / 1000);
  const to = from + Math.round((RATE * soundMs) / 1000);
  const clicks = new Set(clicksAt.map((c) => Math.round((RATE * c) / 1000)));
  const hiss = hissDb === null ? 0 : 10 ** (hissDb / 20);
  for (let f = 0; f < frames; f++) {
    let v = f >= from && f < to ? peak(db) * Math.sin((2 * Math.PI * 220 * f) / RATE) : 0;
    v += hiss * (f % 2 === 0 ? 1 : -1);
    if (clicks.has(f)) v = 1;
    for (let c = 0; c < channels; c++) {
      view.setInt16(
        44 + (f * channels + c) * 2,
        Math.round(Math.max(-1, Math.min(1, v)) * 32767),
        true,
      );
    }
  }
  return bytes;
}

const held = (bytes) => mayHoldAnswer(turnSpeech(bytes));

test("B4 rules: about -50 dBFS, 150 ms under 2 s and 250 ms over, stretches of 60 ms or more", () => {
  assert.equal(SOUND_RMS, 0.00316);
  assert.ok(Math.abs(20 * Math.log10(SOUND_RMS) + 50) < 0.01);
  assert.deepEqual(
    [SHORT_CLIP_MS, MIN_SOUND_SHORT_MS, MIN_SOUND_MS, MIN_RUN_MS],
    [2_000, 150, 250, 60],
  );
});

test("B4: a 1.5-second spoken 'yes' is held, whatever its length", () => {
  const yes = wav(1_500, { soundMs: 350, fromMs: 500 });
  assert.equal(turnSpeech(yes), "sound");
  assert.equal(held(yes), true);
  // A short clip needs only 150 ms; the same 160 ms in a long clip is not enough.
  assert.equal(turnSpeech(wav(900, { soundMs: 160, fromMs: 300 })), "sound");
  assert.equal(turnSpeech(wav(20_000, { soundMs: 160, fromMs: 5_000 })), "silent");
});

test("B4: quiet speech at -45 dBFS is held; a 20-second answer is held", () => {
  assert.equal(turnSpeech(wav(20_000, { soundMs: 3_000, db: -45 })), "sound");
  assert.equal(turnSpeech(wav(1_500, { soundMs: 400, db: -45 })), "sound");
  assert.equal(turnSpeech(wav(20_000, { soundMs: 15_000 })), "sound");
  assert.equal(turnSpeech(wav(20_000, { soundMs: 3_000, channels: 2 })), "sound");
  // Quiet speech over hiss is still speech.
  assert.equal(turnSpeech(wav(20_000, { soundMs: 3_000, db: -45, hissDb: -60 })), "sound");
});

test("B4: genuine silence, short and long, is silent: skipped", () => {
  for (const ms of [300, 1_200, 1_900, 2_500, 20_000]) {
    assert.equal(turnSpeech(wav(ms)), "silent", `${ms} ms`);
    assert.equal(held(wav(ms)), false, `${ms} ms`);
  }
});

test("B4: background hiss below the threshold is silent", () => {
  for (const hissDb of [-70, -60, -55, -52]) {
    assert.equal(turnSpeech(wav(20_000, { hissDb })), "silent", `${hissDb} dBFS hiss`);
    assert.equal(turnSpeech(wav(1_500, { hissDb })), "silent", `${hissDb} dBFS, short`);
  }
  // Speech below the threshold is not detected: -55 dBFS reads as silence.
  assert.equal(turnSpeech(wav(20_000, { soundMs: 3_000, db: -55 })), "silent");
});

test("B4: a single click, scattered clicks and a brief spike are not speech", () => {
  assert.equal(turnSpeech(wav(20_000, { clicksAt: [5_000] })), "silent");
  assert.equal(turnSpeech(wav(1_500, { clicksAt: [700] })), "silent");
  const many = Array.from({ length: 40 }, (_, i) => 250 + i * 480);
  assert.equal(turnSpeech(wav(20_000, { clicksAt: many })), "silent", "40 clicks, apart");
  // A 40 ms burst is a spike, and two-frame bursts never count, however many.
  assert.equal(turnSpeech(wav(1_500, { soundMs: 40, fromMs: 600 })), "silent");
  const frames = Array.from({ length: 1_000 }, (_, i) => i % 50 < 2);
  assert.equal(speechMs(frames), 0);
  // A word with one quiet frame inside it is one stretch.
  assert.equal(speechMs([true, true, false, true, true, true]), 100);
});

test("B4: unreadable audio is held, short or long", () => {
  const webm = new TextEncoder().encode("\u001aEß£ not a wav at all");
  assert.equal(turnSpeech(webm), "unknown");
  assert.equal(held(webm), true);
  assert.equal(turnSpeech(wav(1_000, { bits: 24 })), "unknown", "24-bit is not read");
  assert.equal(held(new Uint8Array(0)), true);
});

test("the WAV reader: 16-bit PCM only", () => {
  const plain = readPcm16Wav(wav(1_000, { channels: 2 }));
  assert.deepEqual([plain.rate, plain.channels, plain.samples.length], [16_000, 2, 32_000]);
  assert.equal(readPcm16Wav(wav(1_000, { bits: 24 })), null);
  assert.equal(readPcm16Wav(new TextEncoder().encode("RIFF....WAVEfmt nope")), null);
});
