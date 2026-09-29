/**
 * The assessability rule, against the six live answers' numbers and the edges
 * around each threshold.
 *
 *   node --test src/lib/interviews/assessable.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTranscript, countWords, LOW_CONFIDENCE_WORDS, MIN_WORDS } from "./assessable.ts";

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
/** One segment per ~3s of speech, a natural Whisper shape. */
const speech = (seconds, noSpeech) => {
  const out = [];
  for (let t = 0; t < seconds; t += 3) {
    out.push({
      start: t,
      end: Math.min(t + 3, seconds),
      ...(noSpeech === undefined ? {} : { noSpeech }),
    });
  }
  return out;
};
const scoreable = (n) => ({ ok: true, confidenceCap: "low", notes: [`short answer: ${n} words`] });

test("the six live answers: historical rows are judged on words alone", () => {
  // No provider duration, no segments (five of six) - only the floor and the cap apply.
  const legacy = (n) =>
    assessTranscript({
      transcript: words(n),
      providerDurationSeconds: null,
      browserDurationSeconds: 120,
      segments: null,
    });
  assert.deepEqual(legacy(3), { ok: false, reason: "Too little speech to assess (3 words)." }); // …7ac3
  assert.deepEqual(legacy(13), scoreable(13)); // …717d
  assert.deepEqual(legacy(17), scoreable(17)); // …4f78
  assert.deepEqual(legacy(9), scoreable(9)); // …035f
  assert.deepEqual(legacy(10), scoreable(10)); // …53f6
  // …a03b: 136 words, 61s, nine segments covering 97% - no provider duration stored yet.
  assert.deepEqual(
    assessTranscript({
      transcript: words(136),
      providerDurationSeconds: null,
      browserDurationSeconds: 61,
      segments: speech(59),
    }),
    { ok: true, confidenceCap: null, notes: [] },
  );
});

test("the browser timer can never skip an answer", () => {
  // A weak-but-real answer with an inflated browser duration and no provider data.
  const r = assessTranscript({
    transcript: words(12),
    providerDurationSeconds: null,
    browserDurationSeconds: 600,
    segments: null,
  });
  assert.equal(r.ok, true);
  // Even with provider data present, an absurd browser figure only lowers confidence.
  const r2 = assessTranscript({
    transcript: words(40),
    providerDurationSeconds: 20,
    browserDurationSeconds: 600,
    segments: speech(19),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.confidenceCap, "low");
  assert.match(r2.notes.join(" "), /duration mismatch: browser 600s, audio 20s/);
});

test("density gate: a long, near-silent recording measured by the provider is skipped", () => {
  // 13 words over 120 s of audio, with two 3 s speech segments: rate 0.11, coverage 5%.
  const r = assessTranscript({
    transcript: words(13),
    providerDurationSeconds: 120,
    browserDurationSeconds: 120,
    segments: [
      { start: 10, end: 13 },
      { start: 90, end: 93 },
    ],
  });
  assert.deepEqual(r, {
    ok: false,
    reason: "No usable speech - 13 words across 120 seconds of audio.",
  });
});

test("density gate needs BOTH signals: low rate with high coverage is a slow speaker, not silence", () => {
  const r = assessTranscript({
    transcript: words(13),
    providerDurationSeconds: 120,
    browserDurationSeconds: 120,
    segments: speech(110),
  });
  assert.equal(r.ok, true);
  assert.equal(r.confidenceCap, "low");
});

test("density gate does not run on short audio or without segments", () => {
  assert.equal(
    assessTranscript({
      transcript: words(9),
      providerDurationSeconds: 25,
      browserDurationSeconds: 25,
      segments: [{ start: 0, end: 2 }],
    }).ok,
    true,
  );
  assert.equal(
    assessTranscript({
      transcript: words(9),
      providerDurationSeconds: 120,
      browserDurationSeconds: 120,
      segments: [],
    }).ok,
    true,
  );
});

test("noSpeech gate: only segments that carry a finite value count, and missing is not zero", () => {
  // Every segment flagged as silence, almost no speech kept → skipped.
  const silent = assessTranscript({
    transcript: words(10),
    providerDurationSeconds: 60,
    browserDurationSeconds: 60,
    segments: [
      { start: 0, end: 2, noSpeech: 0.9 },
      { start: 30, end: 32, noSpeech: 0.8 },
    ],
  });
  assert.deepEqual(silent, {
    ok: false,
    reason: "The transcriber found almost no speech in this recording.",
  });
  // The remaining cases use 25 s of audio so the density gate (30 s+) stays out
  // of the way and only the noSpeech rule is under test.
  // Same segments with NO noSpeech field: the rule does not apply.
  const unknown = assessTranscript({
    transcript: words(10),
    providerDurationSeconds: 25,
    browserDurationSeconds: 25,
    segments: [
      { start: 0, end: 2 },
      { start: 20, end: 22 },
    ],
  });
  assert.equal(unknown.ok, true);
  // Mixed: one flagged, one missing - the mean is over the one observation only,
  // and the unflagged segment counts as speech.
  const mixed = assessTranscript({
    transcript: words(10),
    providerDurationSeconds: 60,
    browserDurationSeconds: 60,
    segments: [
      { start: 0, end: 2, noSpeech: 0.9 },
      { start: 30, end: 50 },
    ],
  });
  // Mean is 0.9 (> 0.6) but the unflagged 20 s segment keeps speech above 5 s,
  // and coverage (20/60) is above the density floor → scoreable.
  assert.equal(mixed.ok, true);
  // NaN / non-numeric noSpeech is ignored, not treated as 0 or as silence.
  const junk = assessTranscript({
    transcript: words(10),
    providerDurationSeconds: 25,
    browserDurationSeconds: 25,
    segments: [
      { start: 0, end: 2, noSpeech: Number.NaN },
      { start: 20, end: 22, noSpeech: "high" },
    ],
  });
  assert.equal(junk.ok, true);
});

test("when silence and density would both fire, the transcriber's own judgement is the reason given", () => {
  const r = assessTranscript({
    transcript: words(10),
    providerDurationSeconds: 60,
    browserDurationSeconds: 60,
    segments: [
      { start: 0, end: 2, noSpeech: 0.95 },
      { start: 30, end: 32, noSpeech: 0.9 },
    ],
  });
  assert.deepEqual(r, {
    ok: false,
    reason: "The transcriber found almost no speech in this recording.",
  });
});

test("a short but legitimate answer stays scoreable with low confidence; a full answer is untouched", () => {
  const short = assessTranscript({
    transcript: words(17),
    providerDurationSeconds: 7,
    browserDurationSeconds: 7,
    segments: speech(7),
  });
  assert.deepEqual(short, scoreable(17));
  const full = assessTranscript({
    transcript: words(LOW_CONFIDENCE_WORDS),
    providerDurationSeconds: 30,
    browserDurationSeconds: 31,
    segments: speech(29),
  });
  assert.deepEqual(full, { ok: true, confidenceCap: null, notes: [] });
});

test("word floor edges", () => {
  assert.equal(countWords("  a  b\nc "), 3);
  const bare = (n) =>
    assessTranscript({
      transcript: words(n),
      providerDurationSeconds: null,
      browserDurationSeconds: null,
      segments: null,
    });
  assert.equal(bare(MIN_WORDS - 1).ok, false);
  assert.equal(bare(MIN_WORDS).ok, true);
  assert.equal(
    assessTranscript({
      transcript: "",
      providerDurationSeconds: 60,
      browserDurationSeconds: 60,
      segments: speech(60),
    }).ok,
    false,
  );
});
