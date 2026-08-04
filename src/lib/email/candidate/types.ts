/**
 * Candidate-facing messaging: shared shapes.
 *
 * A plain module — imported by a "use server" file, a route handler and the
 * queue worker, none of which may share a module that exports non-async values
 * unless it lives outside the server-action boundary.
 */

/** Matches the `event` CHECK on message_templates and communication_logs. */
export const MESSAGE_EVENTS = [
  "application_received",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
  "rejected",
  "manual",
] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

/** Matches the `status` CHECK on communication_logs. */
export type MessageStatus = "queued" | "sent" | "failed" | "cancelled" | "skipped";

/**
 * Pipeline stages that trigger a candidate email, mapped to their event.
 *
 * THIS MAP IS THE ONLY SWITCH. queueStageChange looks a stage up here and
 * returns immediately when it misses, so a stage absent from this object sends
 * nothing — no other file needs to know which stages are live.
 *
 * Only `rejected` is enabled. Screening, shortlisted, interview, offer and
 * hired are commented out rather than deleted: their templates, dispatch path,
 * opt-out handling and cap all still work unchanged, so re-enabling one is
 * uncommenting its line here and nothing else.
 *
 * `applied` is absent for a different reason — the candidate already gets
 * application_received at apply time, and a second mail for the same moment
 * would be noise.
 *
 * `rejected` is enabled here but gated again per job on
 * jobs.send_rejection_email — see jobWantsRejectionEmail.
 */
export const STAGE_EVENTS: Record<string, MessageEvent> = {
  // screening: "screening",
  // shortlisted: "shortlisted",
  // interview: "interview",
  // offer: "offer",
  // hired: "hired",
  rejected: "rejected",
};

/**
 * How long a rejection sits in the queue before it sends.
 *
 * The delay IS the feature: a mis-click or a reconsidered decision can be
 * undone by moving the candidate off Rejected inside the window, and nothing
 * ever reaches them. Sending immediately would make every rejection final the
 * instant it was clicked.
 */
export const REJECTION_DELAY_MS = 2 * 24 * 60 * 60 * 1000;

/** The payload every send_message job carries. */
export type SendMessagePayload = {
  applicationId: string;
  event: MessageEvent;
  /** Present for 'manual'; every other event renders from a template. */
  subjectOverride?: string;
  bodyOverride?: string;
};
