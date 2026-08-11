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
 * 2. Join every segment into ONE haystack, remembering the character offset at
 *    which each segment begins.
 * 3. Find the quote's offset in that haystack and map it back to the segment
 *    that offset falls inside — the segment where the quote actually BEGINS.
 *
 * Straddling is the normal case, not the exception: Whisper splits on silence,
 * so most sentences a model quotes cross at least one boundary. Measured on a
 * real 57-second answer, five of six quotes straddled. An earlier version
 * searched a sliding window of joined segments and returned the WINDOW's start
 * — which, since the window began at segment zero, sent almost every quote to
 * 0:00 while looking entirely correct.
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

export function findQuoteStart(
  quote: string,
  segments: TranscriptSegment[] | null | undefined,
): number | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const needle = normalise(quote.replace(/^["'`]+|["'`]+$/g, ""));
  if (needle.length < MIN_MATCH_CHARS) return null;

  /*
   * Build the haystack and the offset index together, so `starts[i]` is the
   * character position at which segment i begins. A single space joins them —
   * the same separator `normalise` collapses runs of whitespace to, so the
   * haystack reads exactly as the concatenated transcript does and a quote
   * spanning a boundary matches without special handling.
   */
  let haystack = "";
  const starts: number[] = [];
  for (const seg of segments) {
    const text = normalise(seg.text);
    if (haystack) haystack += " ";
    starts.push(haystack.length);
    haystack += text;
  }

  const at = haystack.indexOf(needle);
  if (at < 0) return null;

  /*
   * Map the offset back to the segment CONTAINING it: the last segment whose
   * start is at or before the match. That is where the reviewer should begin
   * listening — the moment the quoted words start, whether or not they finish
   * inside the same segment.
   */
  let found = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= at) found = i;
    else break;
  }
  return segments[found].start;
}

/** Seconds → `m:ss`, the form the seek chip shows. */
export function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
