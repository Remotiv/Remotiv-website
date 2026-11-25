/**
 * The interview was closed under the candidate while it ran (#54): the
 * applicant's delete began, the session was cancelled, its delete_after came
 * due, or its row is gone. The server answers the screen's next piece reserve
 * or confirm with interview_closed (or not_found), at most about PIECE_MS
 * after the close, and the screen ends the interview on its own side, whatever
 * the provider does: its connection may stay open there, but nothing more is
 * sent to it or heard from it.
 *
 * Pure apart from the callbacks it is given, so it runs under a fake clock.
 */

export type ClosedStop = {
  /** Closes the provider connection on this side: Sarah stops, nothing is sent or heard. */
  closeTransport: () => void;
  /** Stops the camera and the microphone. */
  stopMedia: () => void;
  /** Shows "This interview has been closed". */
  show: () => void;
};

/**
 * Ends the interview here. The recorder has already let every unsaved piece go
 * (PieceRecorder.abandon) by the time this runs; the connection closes first,
 * so Sarah stops at once, then the camera and microphone, then the screen.
 */
export function endClosedInterview(stop: ClosedStop): void {
  stop.closeTransport();
  stop.stopMedia();
  stop.show();
}
