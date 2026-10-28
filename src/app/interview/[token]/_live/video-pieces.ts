import { type Clock, realClock } from "./clock";

/**
 * The candidate's camera video in pieces (10a: live-video.ts, migration 044),
 * recorded while the conversation runs.
 *
 * ── A piece ──────────────────────────────────────────────────
 *
 * About thirty seconds (PIECE_MS; 044 allows three minutes), each a complete
 * file: the recorder is stopped and a new one started per piece. A closed tab
 * loses at most the piece being recorded. A 30-minute interview is about 60
 * pieces, well under 044's 200. Piece N is reserved
 * when it STARTS recording (the upload URL is asked for then), and uploaded
 * and confirmed once it stops, with where it started on the conversation's
 * clock and how long it is.
 *
 * ── Never lost quietly ───────────────────────────────────────
 *
 * Uploads run one at a time in the background, so they compete as little as
 * possible with the live audio. A failed reserve, upload or confirm is tried
 * again, for as long as the page is open, its file kept in memory: there is
 * no last try and no button to press. After FAILED_AFTER tries in a row a
 * piece shows as "failed", and is still retried.
 *
 * ── Unless the server says no for good ───────────────────────
 *
 * Only a temporary failure is retried: no answer (the network), 408, 429 or
 * 5xx. Any other 4xx (the upload window closed, the link not found, consent
 * refused, a bad piece) is the server's final answer for that piece: it is
 * "refused", its file let go, and never tried again. Two answers are read
 * with care so a stored file is never given up on:
 *   - a refused storage upload still goes to confirm: storage is
 *     create-only, so after a lost answer the file is already there, and
 *     confirm checks what is stored;
 *   - confirm's "not_uploaded" after an upload that went through is
 *     temporary (it asks for the upload again); after a refused upload it is
 *     final.
 * When only refused pieces are left, the recorder is finished: the screen
 * moves on and says calmly that some video could not be saved.
 *
 * One backoff for the whole queue (RETRY_MS, growing to 30 s), so a long
 * outage costs one try every 30 s, not one per piece: about 3 requests per
 * piece plus 20 tries per 10 minutes, under the routes' 120 per 10 minutes.
 * It goes back to the start only once nothing is failing. A failed piece goes
 * to the back of the queue, so one the server keeps refusing never holds up
 * the others (the review timeline orders pieces by time, not by save order).
 *
 * The end screen holds until every piece is saved (drained), and the page
 * warns before it is closed while one is not. Ending the interview never cuts
 * a piece off: the last one is stopped, then uploaded like the others.
 */

export const PIECE_MS = 30_000;
/** 044's limit per piece. */
const PIECE_MAX_MS = 180_000;
/** The wait after each failed try in a row; the last one repeats for as long as the page is open. */
export const RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
/** Failed tries in a row after which a piece shows as "failed" (and is still retried). */
export const FAILED_AFTER = 3;

/** The wait after the Nth failed try in a row (N from 1). */
export function retryDelay(failures: number): number {
  return RETRY_MS[Math.min(Math.max(failures, 1), RETRY_MS.length) - 1];
}

export type PieceMime = "video/webm" | "video/mp4";

/** A reserve, upload or confirm the server answered with something other than success. */
export class PieceHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(step: "reserve" | "upload" | "confirm", status: number, code: string | null = null) {
    super(`${step} failed (${status})`);
    this.status = status;
    this.code = code;
  }
}

/** The server's final no: a 4xx other than 408 and 429. No answer at all is the network. */
export function isPermanent(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const refusedBy = (e: unknown) => e instanceof PieceHttpError && isPermanent(e.status);

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

export type PieceState = "recording" | "waiting" | "uploading" | "saved" | "failed" | "refused";
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
  failures: number;
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
  private readonly pending: Piece[] = [];
  private pumping = false;
  /** Failed tries in a row across the queue: the backoff. */
  private failures = 0;
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

  /** Nothing left to try: every piece saved or refused for good, and nothing still recording. */
  get finished(): boolean {
    return (
      this.stopped &&
      !this.recorder &&
      this.pieces.every((p) => p.state === "saved" || p.state === "refused")
    );
  }

  /** Pieces that staying on the page can still save. */
  get unsaved(): number {
    return this.pieces.filter((p) => p.state !== "saved" && p.state !== "refused").length;
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
      failures: 0,
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
    this.pending.push(piece);
    this.changed();
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    for (let piece = this.pending.shift(); piece; piece = this.pending.shift()) {
      if ((await this.upload(piece)) !== "retry") {
        if (!this.pending.some((p) => p.failures > 0)) this.failures = 0;
        continue;
      }
      piece.failures += 1;
      this.failures += 1;
      piece.state = piece.failures >= FAILED_AFTER ? "failed" : "waiting";
      this.pending.push(piece);
      this.changed();
      await new Promise<void>((resolve) =>
        this.clock.setTimeout(resolve, retryDelay(this.failures)),
      );
    }
    this.pumping = false;
  }

  /** One try at reserving, uploading and confirming a piece. */
  private async upload(piece: Piece): Promise<"saved" | "retry" | "refused"> {
    const blob = piece.blob;
    if (!blob) return "saved";
    if (piece.state !== "failed") piece.state = "uploading";
    this.changed();
    try {
      await piece.reserved;
      const reserved = await this.opts.sink.reserve(piece.index, this.opts.mime);
      if (!("alreadyConfirmed" in reserved)) {
        const sent = await this.opts.sink.upload(reserved.url, blob, this.opts.mime).then(
          () => true,
          (e) => {
            if (refusedBy(e)) return false;
            throw e;
          },
        );
        try {
          await this.opts.sink.confirm({
            index: piece.index,
            mime: this.opts.mime,
            startedAtMs: piece.startedAtMs,
            durationMs: piece.durationMs,
            last: piece.last,
          });
        } catch (e) {
          if (sent && e instanceof PieceHttpError && e.code === "not_uploaded") {
            throw new Error("not stored yet");
          }
          throw e;
        }
      }
      piece.state = "saved";
      piece.blob = null;
      this.changed();
      return "saved";
    } catch (e) {
      if (!refusedBy(e)) return "retry";
      piece.state = "refused";
      piece.blob = null;
      this.changed();
      return "refused";
    }
  }

  private changed(): void {
    this.opts.onChange?.(this.view());
  }
}
