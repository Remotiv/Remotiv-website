import { type Clock, realClock } from "./clock";

/**
 * The candidate's camera video in pieces (10a: live-video.ts, migration 044),
 * recorded while the conversation runs.
 *
 * ── A piece ──────────────────────────────────────────────────
 *
 * About two minutes (PIECE_MS; 044 allows three), each a complete file: the
 * recorder is stopped and a new one started per piece. Piece N is reserved
 * when it STARTS recording (the upload URL is asked for then), and uploaded
 * and confirmed once it stops, with where it started on the conversation's
 * clock and how long it is.
 *
 * ── Never lost quietly ───────────────────────────────────────
 *
 * Uploads run one at a time in the background, so they compete as little as
 * possible with the live audio. A failed reserve, upload or confirm is tried
 * again with backoff (RETRY_MS), then the piece waits as "failed" with its
 * file still in memory until retryFailed(). The end screen holds until every
 * piece is saved (drained), and the page warns before it is closed while one
 * is not. Ending the interview never cuts a piece off: the last one is
 * stopped, then uploaded like the others.
 */

export const PIECE_MS = 120_000;
/** 044's limit per piece. */
const PIECE_MAX_MS = 180_000;
export const RETRY_MS = [2_000, 5_000, 10_000];

export type PieceMime = "video/webm" | "video/mp4";

export type PieceSink = {
  /** The upload URL for piece N (reserving it), or that it is already saved. */
  reserve(index: number, mime: PieceMime): Promise<{ url: string } | { alreadyConfirmed: true }>;
  upload(url: string, blob: Blob, mime: PieceMime): Promise<void>;
  confirm(piece: {
    index: number;
    mime: PieceMime;
    startedAtMs: number;
    durationMs: number;
    last: boolean;
  }): Promise<void>;
};

/** The part of MediaRecorder this uses, so tests can fake it. */
export type RecorderLike = {
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
};

export type PieceState = "recording" | "waiting" | "uploading" | "saved" | "failed";
export type PieceView = { index: number; state: PieceState; bytes: number | null };

type Piece = {
  index: number;
  startedAtMs: number;
  durationMs: number;
  last: boolean;
  state: PieceState;
  blob: Blob | null;
  bytes: number | null;
  reserved: Promise<unknown> | null;
};

/** "video/webm;codecs=vp8,opus" -> "video/webm": what 044 stores and checks. */
export function baseMime(recorderMime: string): PieceMime | null {
  const base = recorderMime.split(";")[0].trim().toLowerCase();
  return base === "video/webm" || base === "video/mp4" ? base : null;
}

export type PieceRecorderOptions = {
  mime: PieceMime;
  sink: PieceSink;
  /** A new recorder on the camera stream, one per piece. */
  makeRecorder: () => RecorderLike;
  /** Milliseconds since the conversation started (TransportEvent "started"). */
  now: () => number;
  pieceMs?: number;
  clock?: Clock;
  onChange?: (pieces: PieceView[]) => void;
};

export class PieceRecorder {
  private readonly pieces: Piece[] = [];
  private recorder: RecorderLike | null = null;
  private rotateTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly clock: Clock;
  private readonly opts: PieceRecorderOptions;

  constructor(opts: PieceRecorderOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
  }

  start(): void {
    if (this.recorder || this.stopped) return;
    this.begin(0);
  }

  /** Stop recording: the current piece becomes the last, and is uploaded like the others. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rotateTimer !== null) this.clock.clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
    this.finishCurrent(true);
  }

  view(): PieceView[] {
    return this.pieces.map((p) => ({ index: p.index, state: p.state, bytes: p.bytes }));
  }

  /** Every piece saved, and nothing still recording. */
  get drained(): boolean {
    return this.stopped && !this.recorder && this.pieces.every((p) => p.state === "saved");
  }

  get unsaved(): number {
    return this.pieces.filter((p) => p.state !== "saved").length;
  }

  /** Waits for the upload queue as it stands. */
  async settled(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  /** Try every failed piece again. */
  retryFailed(): void {
    for (const p of this.pieces) if (p.state === "failed") this.enqueue(p);
  }

  private begin(index: number): void {
    const piece: Piece = {
      index,
      startedAtMs: Math.max(0, Math.round(this.opts.now())),
      durationMs: 0,
      last: false,
      state: "recording",
      blob: null,
      bytes: null,
      reserved: null,
    };
    // Reserved as it starts (044); a failure here is retried at upload.
    piece.reserved = this.opts.sink.reserve(index, this.opts.mime).catch(() => null);
    this.pieces.push(piece);
    // Each piece's own chunks: the previous recorder's last chunk can arrive
    // after the next piece has started.
    const chunks: Blob[] = [];
    const recorder = this.opts.makeRecorder();
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      piece.blob = new Blob(chunks, { type: this.opts.mime });
      piece.bytes = piece.blob.size;
      this.enqueue(piece);
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.changed();
    this.rotateTimer = this.clock.setTimeout(() => {
      this.rotateTimer = null;
      if (this.stopped) return;
      this.finishCurrent(false);
      this.begin(index + 1);
    }, this.opts.pieceMs ?? PIECE_MS);
  }

  private finishCurrent(last: boolean): void {
    const recorder = this.recorder;
    const piece = this.pieces[this.pieces.length - 1];
    if (!recorder || !piece) return;
    this.recorder = null;
    piece.last = last;
    piece.durationMs = Math.min(
      PIECE_MAX_MS,
      Math.max(1, Math.round(this.opts.now()) - piece.startedAtMs),
    );
    // onstop arrives after the final chunk, and then queues the upload.
    recorder.stop();
  }

  private enqueue(piece: Piece): void {
    piece.state = "waiting";
    this.changed();
    this.queue = this.queue.then(() => this.upload(piece));
  }

  private async upload(piece: Piece): Promise<void> {
    const blob = piece.blob;
    if (!blob) return;
    for (let attempt = 0; ; attempt++) {
      piece.state = "uploading";
      this.changed();
      try {
        await piece.reserved;
        const reserved = await this.opts.sink.reserve(piece.index, this.opts.mime);
        if (!("alreadyConfirmed" in reserved)) {
          await this.opts.sink.upload(reserved.url, blob, this.opts.mime);
          await this.opts.sink.confirm({
            index: piece.index,
            mime: this.opts.mime,
            startedAtMs: piece.startedAtMs,
            durationMs: piece.durationMs,
            last: piece.last,
          });
        }
        piece.state = "saved";
        piece.blob = null;
        this.changed();
        return;
      } catch {
        if (attempt >= RETRY_MS.length) {
          piece.state = "failed";
          this.changed();
          return;
        }
        await new Promise<void>((resolve) => this.clock.setTimeout(resolve, RETRY_MS[attempt]));
      }
    }
  }

  private changed(): void {
    this.opts.onChange?.(this.view());
  }
}
