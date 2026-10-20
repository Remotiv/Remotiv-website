/**
 * The camera video of an AI Video Interview as a timeline, for the review
 * page: its confirmed pieces in order, the gaps between them, and where a
 * moment of the conversation falls in them. Pure; the client player uses it
 * too.
 *
 * Every time is milliseconds on the conversation clock: a piece's started_ms
 * (since the interview server's "conversation started" message, measured by
 * the candidate screen) and a turn's offset_ms share it, so a quote's moment
 * maps to a piece and a point in it. The two clocks are measured by different
 * machines, so a jump can land a fraction of a second off; fine for finding
 * a moment.
 *
 * The video carries the candidate's camera and microphone only. Sarah's voice
 * is not in it; her lines play from her turn audio.
 */

/** A gap shorter than this between two pieces is the recorder restarting, not missing video. */
export const GAP_TOLERANCE_MS = 2000;

export type VideoPieceRow = {
  piece_index: number;
  status: string;
  started_ms: number | null;
  duration_ms: number | null;
  is_last: boolean;
  media_path: string | null;
};

export type LiveVideoPiece = {
  index: number;
  startedMs: number;
  durationMs: number;
  hasVideo: boolean;
};
/** toMs null: missing from fromMs to the end. */
export type LiveVideoGap = { fromMs: number; toMs: number | null };

export type LiveReviewVideo = {
  /** Any piece was ever started. */
  recorded: boolean;
  /** Confirmed pieces, in time order. */
  pieces: LiveVideoPiece[];
  gaps: LiveVideoGap[];
  /** Piece numbers started but never saved, or skipped. */
  missingPieces: number[];
  /** The last piece is saved and nothing is missing. */
  complete: boolean;
  /** Retention deleted the video. */
  purged: boolean;
};

/** The timeline of a session's pieces. Paths are read only to know a file exists; none is returned. */
export function videoTimeline(rows: readonly VideoPieceRow[]): LiveReviewVideo {
  const confirmed = rows
    .filter((r) => r.status === "confirmed" && r.started_ms !== null && r.duration_ms !== null)
    .sort((a, b) => (a.started_ms as number) - (b.started_ms as number));
  const pieces: LiveVideoPiece[] = confirmed.map((r) => ({
    index: r.piece_index,
    startedMs: r.started_ms as number,
    durationMs: r.duration_ms as number,
    hasVideo: r.media_path !== null,
  }));
  const maxIndex = rows.reduce((m, r) => Math.max(m, r.piece_index), -1);
  const saved = new Set(confirmed.map((r) => r.piece_index));
  const missingPieces: number[] = [];
  for (let i = 0; i <= maxIndex; i++) if (!saved.has(i)) missingPieces.push(i);
  const complete = confirmed.some((r) => r.is_last) && missingPieces.length === 0;

  const gaps: LiveVideoGap[] = [];
  let cursor = 0;
  for (const p of pieces) {
    if (p.startedMs - cursor > GAP_TOLERANCE_MS) gaps.push({ fromMs: cursor, toMs: p.startedMs });
    cursor = Math.max(cursor, p.startedMs + p.durationMs);
  }
  if (rows.length > 0 && !complete) gaps.push({ fromMs: cursor, toMs: null });

  return {
    recorded: rows.length > 0,
    pieces,
    gaps,
    missingPieces,
    complete,
    purged: rows.some((r) => r.media_path === null),
  };
}

/** Which piece holds a moment, and how far into it; null when the moment falls in a gap. */
export function videoPositionAt(
  atMs: number,
  pieces: readonly LiveVideoPiece[],
): { index: number; offsetSeconds: number } | null {
  const p = pieces.find(
    (x) => x.hasVideo && atMs >= x.startedMs && atMs < x.startedMs + x.durationMs,
  );
  return p ? { index: p.index, offsetSeconds: (atMs - p.startedMs) / 1000 } : null;
}

/** mm:ss on the conversation clock. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
