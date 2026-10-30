/**
 * Whether a live interview's call has begun (F10).
 *
 * The start route writes provider_session_id, started_at and status 'started'
 * in one update (live-start.ts), and live_ended_at is stamped only after that,
 * so any of the three means the candidate's call began. It is not proof the
 * call finished: one in progress or crashed is ended later by the time-cap
 * backstop (live-events.ts stampOverdueLiveEnds).
 *
 * Once it has begun, the interview is never expired (expiry.ts) and never
 * replaced by a new link (applicants/interview-actions.ts): a restart comes
 * only through the restart decision.
 *
 * Pure, with no server import, so the applicant drawer can use it too.
 */

export type LiveCallFields = {
  kind: string | null;
  started_at: string | null;
  provider_session_id: string | null;
  live_ended_at: string | null;
};

export function liveCallBegan(s: LiveCallFields): boolean {
  return (
    s.kind === "live" &&
    (s.live_ended_at !== null || s.provider_session_id !== null || s.started_at !== null)
  );
}

/**
 * The drawer's view of the same fact. Its session summary carries status and
 * startedAt but not the provider id or the end stamp, and for a live session
 * those come together: nothing sets status 'started' or started_at on one
 * except the start route, which writes them with the provider id. The server
 * check (liveCallBegan) is the one that refuses; this only hides the button.
 */
export function liveSummaryCallBegan(s: {
  kind: string;
  status: string;
  startedAt: string | null;
}): boolean {
  return s.kind === "live" && (s.status === "started" || s.startedAt !== null);
}
