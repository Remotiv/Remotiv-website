/**
 * The hard stop at the interview's chosen length (#49, 25 Nov): 30 or 60
 * minutes, frozen at invite (live_settings.max_session_seconds), counted on the
 * conversation's own clock from the moment it started.
 *
 * At the limit the call ends for the candidate: the interviewer stops (the
 * connection is closed), the recording stops, and with it the camera and the
 * microphone; every video piece not yet sent keeps uploading. The server's
 * backstop, the limit plus END_GRACE_MS (live-events.ts), stays as the
 * technical clean-up for a call this page never ended.
 *
 * Pure apart from the callbacks it is given, so it runs under a fake clock.
 */

/** Seconds left on the limit, never below 0. Null before the conversation started. */
export function secondsLeft(
  limitMinutes: number,
  startedAtMs: number | null,
  nowMs: number,
): number | null {
  if (startedAtMs === null) return null;
  return Math.max(0, limitMinutes * 60 - (nowMs - startedAtMs) / 1000);
}

/** Whether the limit has been reached: exactly at it counts. */
export function limitReached(
  limitMinutes: number,
  startedAtMs: number | null,
  nowMs: number,
): boolean {
  const left = secondsLeft(limitMinutes, startedAtMs, nowMs);
  return left !== null && left <= 0;
}

export type TimeLimitStop = {
  /** Ends the conversation: the interviewer stops, and nothing more is sent or heard. */
  closeTransport: () => void;
  /** Stops the recording; pieces already recorded keep uploading. */
  stopRecording: () => void;
  /** Tells the server the limit was reached on this screen (recorded only). */
  report: () => void;
};

/**
 * Ends the call for the candidate at the limit. The report goes first, so the
 * server hears why before the connection closes; the recording stops last, so
 * nothing said up to the limit is cut from the video.
 */
export function endAtTimeLimit(stop: TimeLimitStop): void {
  stop.report();
  stop.closeTransport();
  stop.stopRecording();
}
