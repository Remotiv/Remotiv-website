/**
 * Candidate-facing messaging: shared shapes.
 *
 * A plain module — imported by a "use server" file, a route handler and the
 * queue worker, none of which may share a module that exports non-async values
 * unless it lives outside the server-action boundary.
 */

/**
 * Matches message_templates_event_check exactly.
 *
 * NOT communication_logs, despite what this comment used to claim. That table's
 * `event` is plain `text` with no CHECK at all, so it accepts values this union
 * does not — see LOG_ONLY_EVENTS. The distinction matters in one direction:
 * adding a value HERE without the matching ALTER on message_templates_event_check
 * breaks template saving the first time a company edits it.
 */
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

/**
 * Events written to communication_logs that have no template row.
 *
 * `interview_reminder` is composed in code (src/lib/interviews/reminder.ts)
 * rather than from message_templates, so it must NOT join MESSAGE_EVENTS: that
 * union drives the Settings editor and message_templates_event_check would
 * reject the row the moment a company tried to override the wording.
 *
 * `booking_confirmed` joins it for the same reason: it is composed in
 * src/lib/calendar/notify.ts, has no template row, and must not reach
 * message_templates_event_check.
 *
 * `booking_link` is here because of a bug worth recording. It first reused
 * `interview`, on the reasoning that a booking link IS the interview step and
 * a company that had customised its interview wording should not be bypassed.
 * That was wrong for a reason nothing in the type system could show: there is
 * a UNIQUE constraint on communication_logs (application_id, event, channel),
 * so an invitation and a booking link sharing one event value COLLIDE — the
 * second send violates it. An interview invitation and a booking link are two
 * different messages at the same stage, and they need two different values.
 *
 * ⚠ communication_logs.event IS CHECK-CONSTRAINED. This comment used to say it
 * was unconstrained — that was true when written and is not any more, and the
 * stale reassurance is why `booking_confirmed` was added here without the
 * matching ALTER and now fails at insert time with SQLSTATE 23514.
 *
 * ADDING A VALUE HERE IS NOT ENOUGH. Two constraints must be checked:
 *   · message_templates_event_check — only if the value joins MESSAGE_EVENTS.
 *   · the CHECK on communication_logs.event — for EVERY value, including
 *     log-only ones. Verify against the live database, not against this file.
 *
 * ONE EVENT PER MESSAGE, always. There is a UNIQUE index on
 * (application_id, event, channel) WHERE sent_by_name IS NULL, so two
 * different automatic messages sharing an event value COLLIDE — the second one
 * is refused and silently never sends.
 *
 * That has now happened twice. `booking_link` reused `interview`; then the
 * reschedule and cancellation notices reused `booking_confirmed`, which the
 * confirmation email had already consumed. Both times the symptom was "no
 * email arrives" with a successful-looking action. If you are adding a
 * candidate-facing message, it needs its OWN value here — reusing a near-miss
 * is never the cheap option it looks like.
 *
 * Accepted as of 2026-08-22 (event check widened and verified): the eight
 * MESSAGE_EVENTS plus interview_reminder, booking_link, booking_confirmed,
 * booking_rescheduled, booking_cancelled.
 */
export const LOG_ONLY_EVENTS = [
  "interview_reminder",
  "booking_confirmed",
  "booking_link",
  "booking_rescheduled",
  "booking_cancelled",
] as const;
export type LogOnlyEvent = (typeof LOG_ONLY_EVENTS)[number];

/** Anything that may legally appear in communication_logs.event. */
export type LoggedEvent = MessageEvent | LogOnlyEvent;

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
