/**
 * The codes the candidate screen reports about a live interview (migration
 * 050, live_session_events). Shared by the screen and the event route, so
 * both use one list; the database checks the same list again.
 *
 * No server-only import and nothing secret: the candidate page imports this.
 */

export const LIVE_EVENT_KINDS = [
  "conversation_started",
  "end_pressed",
  "provider_complete",
  "provider_error",
  "connection_lost",
  "tab_closed",
  "timer_reached",
  "video_saved",
] as const;
export type LiveEventKind = (typeof LIVE_EVENT_KINDS)[number];

/** provider_complete's detail: the provider's end_reason, as a code. */
export const PROVIDER_END_DETAILS = [
  "completed",
  "completed_not_graceful",
  "candidate_left",
  "timed_out",
  "other",
] as const;
export type ProviderEndDetail = (typeof PROVIDER_END_DETAILS)[number];

export function isLiveEventKind(value: unknown): value is LiveEventKind {
  return (LIVE_EVENT_KINDS as readonly unknown[]).includes(value);
}

/**
 * The provider's end_reason and completed_gracefully as one code. Completed
 * needs both, as the importer does (parse-export.ts, F15); this code is a
 * reviewer's note and never decides the outcome.
 */
export function providerEndDetail(endReason: unknown, graceful: unknown): ProviderEndDetail {
  const reason = typeof endReason === "string" ? endReason.trim().toLowerCase() : "";
  if (reason === "completed") return graceful === true ? "completed" : "completed_not_graceful";
  if (reason === "candidate_left" || reason === "candidate_ended") return "candidate_left";
  if (reason === "timed_out" || reason === "time_limit" || reason === "timeout") {
    return "timed_out";
  }
  return "other";
}

/** The detail a kind must carry: null for all but provider_complete and provider_error. */
export function validEventDetail(kind: LiveEventKind, detail: unknown): boolean {
  if (kind === "provider_complete") {
    return (PROVIDER_END_DETAILS as readonly unknown[]).includes(detail);
  }
  if (kind === "provider_error") return detail === "error";
  return detail === null || detail === undefined;
}

/**
 * Whether a report stamps the interview's end (live_ended_at, live-events.ts).
 * Only the provider's session_complete does; a closed tab, a dropped
 * connection, End pressed alone, an error or the time limit never do.
 */
export function endsInterview(kind: LiveEventKind): boolean {
  return kind === "provider_complete";
}
