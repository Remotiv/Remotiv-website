/**
 * Is there enough speech in this transcript to score?
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * Three production interviews were scored 0, 0 and 22 - each with "high"
 * confidence - on recordings whose transcripts held 13, 9 and 17 words. Two
 * were two-minute and one-minute videos with almost nothing said in them: a
 * microphone problem, not an answer. Whisper returns a few words for silence,
 * the transcribe handler marks any non-empty text `done`, and the scorer's
 * only floor was 40 characters. A candidate whose microphone failed now
 * carries a permanent, confident zero.
 *
 * ── What may and may not decide it ───────────────────────────
 *
 * `interview_answers.duration_seconds` is the BROWSER's timer, posted by the
 * candidate's page and stored unverified. It never gates anything here: a
 * candidate could inflate it to turn a weak-but-real answer into "unassessable"
 * rather than a low score. It is diagnostic only - a mismatch against the
 * provider's figure lowers confidence and is logged, and that is all it can do.
 *
 * `transcript_duration_seconds` is Whisper's own measurement of the audio,
 * stored by the transcribe handler since migration 031. It is trusted. So are
 * the stored segments and their `noSpeech` probabilities (Whisper's
 * no_speech_prob, kept since the same change). Density and silence gates run
 * on those and nothing else.
 *
 * Historical answers have none of that: no provider duration, mostly no
 * segments. For them only the two duration-free rules apply - the eight-word
 * floor and the low-confidence cap - and nothing is classified from the
 * browser clock. The three cards above are recorded in the audit addenda for
 * controlled re-scoring rather than reclassified here.
 *
 * Pure. No imports. Tested in assessable.test.ts against the six live answers'
 * numbers.
 */

export type AssessableSegment = {
  start: number;
  end: number;
  /** Whisper's no_speech_prob for the segment, 0-1. Absent on rows stored before it was kept. */
  noSpeech?: number;
};

export type AssessInput = {
  transcript: string | null | undefined;
  /** Whisper's audio length. Trusted. Null on every answer transcribed before 031. */
  providerDurationSeconds: number | null | undefined;
  /** The browser's timer. Diagnostic only - never a gate. */
  browserDurationSeconds: number | null | undefined;
  segments: AssessableSegment[] | null | undefined;
};

export type AssessOutcome =
  | {
      ok: true;
      /** "low" when the answer is scoreable but the number should not be trusted much. */
      confidenceCap: "low" | null;
      /** Why the cap applied, for the log. Empty when it did not. */
      notes: string[];
    }
  | { ok: false; reason: string };

/** Below this there is nothing to assess. Roughly where the old 40-char floor sat. */
export const MIN_WORDS = 8;
/** Below this a score exists but its confidence is forced low. */
export const LOW_CONFIDENCE_WORDS = 25;

/** Density gate: only on audio at least this long, where a rate means something. */
const DENSITY_MIN_AUDIO_SECONDS = 30;
/** Twelve words a minute. Slow, deliberate, second-language speech runs 60-90. */
const DENSITY_MIN_WORDS_PER_SECOND = 0.2;
/** And speech must also cover less than this share of the audio - two signals must agree. */
const DENSITY_MAX_SPEECH_COVERAGE = 0.25;

/** Silence gate: Whisper's own judgement, when it is stored. */
const NO_SPEECH_MEAN_THRESHOLD = 0.6;
/** ...and the segments it did keep add up to less than this much speech. */
const NO_SPEECH_MAX_SPEECH_SECONDS = 5;

/** A browser timer this far from the audio length is worth a log line and a lower badge. */
const DURATION_MISMATCH_RATIO = 2;

export function countWords(transcript: string | null | undefined): number {
  return (transcript ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Seconds of speech across the segments Whisper did not flag as silence. */
function speechSpan(segments: AssessableSegment[]): number {
  let total = 0;
  for (const s of segments) {
    if (!finite(s.start) || !finite(s.end) || s.end <= s.start) continue;
    if (finite(s.noSpeech) && s.noSpeech >= NO_SPEECH_MEAN_THRESHOLD) continue;
    total += s.end - s.start;
  }
  return total;
}

/**
 * Mean no_speech_prob over the segments that CARRY one. A missing value is not
 * a zero - it is an older row that never stored the field - so it is left out
 * of the mean, and with no usable observations at all the rule does not apply.
 */
function meanNoSpeech(segments: AssessableSegment[]): number | null {
  const values = segments.map((s) => s.noSpeech).filter(finite);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function assessTranscript(input: AssessInput): AssessOutcome {
  const words = countWords(input.transcript);

  // 1. The absolute floor. Needs no duration of any kind.
  if (words < MIN_WORDS) {
    return {
      ok: false,
      reason: `Too little speech to assess (${words} word${words === 1 ? "" : "s"}).`,
    };
  }

  const segments = Array.isArray(input.segments) ? input.segments : [];
  const audio =
    finite(input.providerDurationSeconds) && input.providerDurationSeconds > 0
      ? input.providerDurationSeconds
      : null;

  // 2. Whisper's own silence judgement, only where it was stored. Checked
  //    before density because it is the more specific signal: when both would
  //    fire, the reason should name what the transcriber said, not a ratio.
  const noSpeech = meanNoSpeech(segments);
  if (noSpeech !== null && noSpeech > NO_SPEECH_MEAN_THRESHOLD) {
    if (speechSpan(segments) < NO_SPEECH_MAX_SPEECH_SECONDS) {
      return { ok: false, reason: "The transcriber found almost no speech in this recording." };
    }
  }

  // 3. Density - provider-derived audio length AND segment coverage must agree.
  if (audio !== null && segments.length > 0 && audio >= DENSITY_MIN_AUDIO_SECONDS) {
    const rate = words / audio;
    const coverage = speechSpan(segments) / audio;
    if (rate < DENSITY_MIN_WORDS_PER_SECOND && coverage < DENSITY_MAX_SPEECH_COVERAGE) {
      return {
        ok: false,
        reason: `No usable speech - ${words} words across ${Math.round(audio)} seconds of audio.`,
      };
    }
  }

  // 4-5. Scoreable. Decide whether the number deserves its confidence.
  const notes: string[] = [];
  if (words < LOW_CONFIDENCE_WORDS) {
    notes.push(`short answer: ${words} words`);
  }
  const browser = input.browserDurationSeconds;
  if (audio !== null && finite(browser) && browser > 0) {
    const ratio = Math.max(browser / audio, audio / browser);
    if (ratio > DURATION_MISMATCH_RATIO) {
      notes.push(`duration mismatch: browser ${Math.round(browser)}s, audio ${Math.round(audio)}s`);
    }
  }

  return { ok: true, confidenceCap: notes.length > 0 ? "low" : null, notes };
}
