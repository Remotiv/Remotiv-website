import type { TranscriptSegment } from "./transcribe";

/**
 * Locate an evidence quote in the transcript's timed segments.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * A scorecard whose quotes cannot be checked against the recording is a
 * downgrade: the reviewer has to trust the model's reading. Every quote gets a
 * seek button so a claim takes one click to verify, and this is the function
 * that makes the button possible.
 *
 * ── Resolution, in three steps ───────────────────────────────
 *
 * 1. Normalise both sides the same way `verifyEvidence` does — lowercase,
 *    collapse whitespace, unify smart punctuation. Whisper's segment text and
 *    the model's quote will differ in exactly those characters.
 * 2. Try each segment on its own: the common case is a quote lifted from one
 *    span.
 * 3. If no single segment contains it, walk consecutive segments and join
 *    them. A quote that STRADDLES A BOUNDARY resolves to the start of the
 *    FIRST segment it appears in — a reviewer wants the beginning of the
 *    sentence they are checking, not its midpoint.
 *
 * ── Failure returns null, never zero ─────────────────────────
 *
 * A quote that cannot be located yields no button at all. Seeking to 0:00
 * would be actively worse than nothing: it looks like a working control,
 * lands on the wrong moment, and quietly teaches the reviewer that the
 * timestamps are decorative. Segments are also absent on every row
 * transcribed before they were stored, which is the common case today — those
 * answers show quotes without buttons, and that is correct.
 */

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Below this a match proves nothing — a two-word quote appears everywhere. */
const MIN_MATCH_CHARS = 8;

/** How many consecutive segments a quote may span before we give up. */
const MAX_SPAN = 6;

export function findQuoteStart(
  quote: string,
  segments: TranscriptSegment[] | null | undefined,
): number | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const needle = normalise(quote.replace(/^["'`]+|["'`]+$/g, ""));
  if (needle.length < MIN_MATCH_CHARS) return null;

  // 1. Whole quote inside one segment — the common case.
  for (const seg of segments) {
    if (normalise(seg.text).includes(needle)) {
      return seg.start;
    }
  }

  /*
   * 2. Straddling a boundary. Join forward from each segment and stop at the
   *    first window that contains the quote, returning the START of the window
   *    — where the reviewer should begin listening.
   */
  for (let i = 0; i < segments.length; i += 1) {
    let joined = normalise(segments[i].text);
    for (let j = i + 1; j < Math.min(i + MAX_SPAN, segments.length); j += 1) {
      joined = `${joined} ${normalise(segments[j].text)}`;
      if (joined.includes(needle)) return segments[i].start;
    }
  }

  return null;
}

/** Seconds → `m:ss`, the form the seek chip shows. */
export function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
