import type { Clock } from "./clock";
import type { PieceSink } from "./video-pieces";

/**
 * The interview was closed under the candidate while it ran (#54): the
 * applicant's delete began, the session was cancelled, its delete_after came
 * due, or its row is gone. The server answers the screen's next piece reserve
 * or confirm with interview_closed (or not_found), at most about PIECE_MS
 * after the close, and the screen ends the interview on its own side, whatever
 * the provider does: its connection may stay open there, but nothing more is
 * sent to it or heard from it.
 *
 * ── Without video pieces (#55 part 2) ────────────────────────
 *
 * If the camera or the recorder stops mid-call, no piece request goes out,
 * so ClosedWatch asks the status route (token only, read-only) once
 * CLOSED_CHECK_MS has passed with no request to Remotiv at all. Every piece
 * reserve and confirm, and every status check, counts as a request
 * (watchedSink), so while pieces flow the status route is never asked, and in
 * the worst case (the recorder stops just after a request) the next check
 * goes out CLOSED_CHECK_MS after that request: the screen learns within
 * 30 seconds, plus one answer.
 *
 * Pure apart from the callbacks it is given, so it runs under a fake clock.
 */

export type ClosedStop = {
  /** Closes the provider connection on this side: Sarah stops, nothing is sent or heard. */
  closeTransport: () => void;
  /** Stops the recorder and lets every unsaved piece go (PieceRecorder.abandon). */
  stopRecording: () => void;
  /** Stops the camera and the microphone. */
  stopMedia: () => void;
  /** Shows "This interview has been closed". */
  show: () => void;
};

/**
 * Ends the interview here. The connection closes first, so Sarah stops at
 * once, then the recorder (nothing more is recorded or sent), the camera and
 * microphone, and the screen.
 */
export function endClosedInterview(stop: ClosedStop): void {
  stop.closeTransport();
  stop.stopRecording();
  stop.stopMedia();
  stop.show();
}

/** The longest the screen goes without a request to Remotiv while the interview runs. */
export const CLOSED_CHECK_MS = 30_000;

export type StatusAnswer = "open" | "closed" | "unknown";

export type ClosedWatchOptions = {
  clock: Clock;
  /** Milliseconds, on any steady clock. */
  now: () => number;
  /** The status route (LiveServer.status). */
  check: () => Promise<StatusAnswer>;
  /** Called once, when the check answers closed. */
  onClosed: () => void;
  idleMs?: number;
};

/**
 * Asks the status route only when no request has gone to Remotiv for
 * CLOSED_CHECK_MS. noteRequest is called for every piece reserve and confirm
 * (watchedSink), and the check counts as one itself.
 */
export class ClosedWatch {
  private last = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly idle: number;
  private readonly opts: ClosedWatchOptions;

  constructor(opts: ClosedWatchOptions) {
    this.opts = opts;
    this.idle = opts.idleMs ?? CLOSED_CHECK_MS;
  }

  /** From the moment the conversation starts. */
  start(): void {
    this.noteRequest();
  }

  /** A request just went to Remotiv: the next check is idle ms from now, if nothing else goes first. */
  noteRequest(): void {
    if (this.stopped) return;
    this.last = this.opts.now();
    this.arm(this.idle);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.opts.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    if (this.timer !== null) this.opts.clock.clearTimeout(this.timer);
    // Due, then one more turn: a piece request due at the same moment (the
    // recorder rotates on the same 30 seconds) goes first and is the check.
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = this.opts.clock.setTimeout(() => this.due(), 0);
    }, ms);
  }

  private due(): void {
    this.timer = null;
    if (this.stopped) return;
    const idleFor = this.opts.now() - this.last;
    if (idleFor < this.idle) {
      this.arm(this.idle - idleFor);
      return;
    }
    this.noteRequest();
    this.opts.check().then(
      (answer) => {
        if (answer !== "closed" || this.stopped) return;
        this.stop();
        this.opts.onClosed();
      },
      () => {},
    );
  }
}

/** The piece sink, with every reserve and confirm counted as a request to Remotiv. */
export function watchedSink(sink: PieceSink, watch: Pick<ClosedWatch, "noteRequest">): PieceSink {
  return {
    reserve: (index, mime) => {
      watch.noteRequest();
      return sink.reserve(index, mime);
    },
    upload: (url, blob, mime) => sink.upload(url, blob, mime),
    confirm: (piece) => {
      watch.noteRequest();
      return sink.confirm(piece);
    },
  };
}
