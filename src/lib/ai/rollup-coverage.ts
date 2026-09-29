/**
 * What the session rollup is told about the answers it was NOT given.
 *
 * Before v8 the rollup saw only the scored answers, numbered 1..n by their
 * place in that subset, with nothing saying how many questions the interview
 * had. On one answer it wrote about a pattern "throughout the interview". On
 * five of eight it wrote as if it had read all eight, and the code then
 * appended "Based on 5 of 8 answers" after prose that said otherwise - two
 * statements in one card that disagree. This module builds the header that
 * closes that gap, and the coverage sentence that agrees with it.
 *
 * ── Why the reason is a CODE and never the stored error text ─────
 *
 * The rollup prompt fences candidate text between BEGIN/END markers and tells
 * the model everything outside them is trusted. A skip reason travels OUTSIDE
 * the fence. Today every skip reason is a fixed string or a count (words,
 * seconds, characters) - none carries a transcript - but that is true by
 * inspection of five call sites, and one future `skipAnswer(err.message)`
 * with a provider error that echoes the transcript would put candidate words
 * into the rollup through an unfenced path. So the handler passes a SkipCause,
 * this module maps it to a phrase written here, and the free-text `error`
 * column never reaches the model at all. Adding a cause means adding a phrase
 * below; there is no way to send text that is not in this file.
 */

export type SkipCause =
  /** The question is in the snapshot but the candidate recorded nothing (optional question). */
  | "not_answered"
  | "no_transcript"
  | "transcription_failed"
  | "recording_purged"
  /** assessTranscript: under the word floor. */
  | "too_little_speech"
  /** assessTranscript: the transcriber's own no-speech judgement. */
  | "no_speech_detected"
  /** assessTranscript: words per second and coverage both near zero on long audio. */
  | "no_usable_speech"
  /** scoreAnswer's character floor. */
  | "transcript_too_short"
  /** The model call or its verification failed; the row is `failed`, not `skipped`. */
  | "scoring_failed";

/**
 * Model-facing wording per cause. Fixed text only. Nothing here may be
 * interpolated from a row - see the module comment.
 */
export const SKIP_PHRASES: Readonly<Record<SkipCause, string>> = {
  not_answered: "not answered",
  no_transcript: "no transcript",
  transcription_failed: "transcription failed",
  recording_purged: "recording deleted before transcription",
  too_little_speech: "too little speech to assess",
  no_speech_detected: "no speech detected",
  no_usable_speech: "no usable speech",
  transcript_too_short: "too little speech to assess",
  scoring_failed: "scoring failed",
};

export type UnscoredAnswer = { position: number; cause: SkipCause };

export type RollupCoverage = {
  /** Questions in the interview, from questions_snapshot. */
  questionsAsked: number;
  /** Answer rows recorded - the page's "answered" count. */
  answersRecorded: number;
  /** Answers with a score, i.e. the blocks the model is given. */
  answersScored: number;
  unscored: UnscoredAnswer[];
};

/**
 * The first lines of the rollup's user message. Written in the plainest shape
 * so the count is impossible to miss: the model's instructions key off it.
 */
export function buildCoverageHeader(c: RollupCoverage): string {
  const q = c.questionsAsked;
  const lines = [
    `Interview of ${q} question${q === 1 ? "" : "s"}. ${c.answersRecorded} answered, ${c.answersScored} scored.`,
  ];
  if (c.unscored.length > 0) {
    const items = [...c.unscored]
      .sort((a, b) => a.position - b.position)
      .map((u) => `question ${u.position} (${SKIP_PHRASES[u.cause]})`);
    lines.push(`Not scored: ${items.join(", ")}.`);
  }
  lines.push(
    c.answersScored === 1
      ? "You are given ONE scored answer. There is no cross-answer comparison to make."
      : `You are given ${c.answersScored} scored answers. Only those. Do not describe the ones listed as not scored.`,
  );
  return lines.join("\n");
}

/**
 * Appended to the stored summary in code, so the disclosure survives a model
 * that ignored the header. Denominator is questions ASKED, to agree with the
 * "N of M answered" the review page prints from the same snapshot. Empty when
 * every question was scored.
 */
export function coverageSentence(c: RollupCoverage): string {
  if (c.answersScored >= c.questionsAsked) return "";
  return ` Based on ${c.answersScored} of ${c.questionsAsked} question${c.questionsAsked === 1 ? "" : "s"} - see the individual answers for why the rest were not scored.`;
}

/** The summary length the prompt asks for, enforced rather than trusted. */
export function summarySentenceLimit(answersScored: number): number {
  return answersScored === 1 ? 2 : 5;
}
