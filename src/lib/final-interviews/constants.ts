/**
 * Final Human Interview: the fixed vocabulary.
 *
 * Client-safe on purpose: no server imports, so the drawer card (step 3b) and
 * the candidate booking page can read the same labels, durations and notice
 * text the server enforces. Every vocabulary here matches a CHECK in migration
 * 038 or 040.
 */

export const INTERVIEW_TYPES = [
  "final",
  "cto",
  "ceo",
  "hiring_manager",
  "technical",
  "custom",
] as const;
export type InterviewType = (typeof INTERVIEW_TYPES)[number];

/** Display labels. `custom` has none: it uses the row's custom_label. */
export const INTERVIEW_TYPE_LABELS: Record<Exclude<InterviewType, "custom">, string> = {
  final: "Final interview",
  cto: "CTO interview",
  ceo: "CEO interview",
  hiring_manager: "Hiring manager interview",
  technical: "Technical interview",
};

export function isInterviewType(value: unknown): value is InterviewType {
  return typeof value === "string" && (INTERVIEW_TYPES as readonly string[]).includes(value);
}

/** The label a reader sees, for any stored (type, custom_label) pair. */
export function interviewTypeLabel(type: string, customLabel: string | null | undefined): string {
  if (type === "custom") return (customLabel ?? "").trim() || "Final interview";
  return INTERVIEW_TYPE_LABELS[type as Exclude<InterviewType, "custom">] ?? "Final interview";
}

/** 1 to 80 characters once trimmed, matching the CHECK on custom_label. */
export const CUSTOM_LABEL_MAX = 80;

export const FINAL_DURATIONS = [30, 45, 60] as const;
export type FinalDuration = (typeof FINAL_DURATIONS)[number];
export const DEFAULT_FINAL_DURATION: FinalDuration = 60;

export function isFinalDuration(value: unknown): value is FinalDuration {
  return typeof value === "number" && (FINAL_DURATIONS as readonly number[]).includes(value);
}

/** Extra interviewers beside the host. The host is never counted here. */
export const MAX_EXTRA_INTERVIEWERS = 5;

/**
 * The recording notice the candidate must acknowledge before booking. The
 * version is stored with the acknowledgement, so a later change to the wording
 * bumps the version and the old acknowledgements still say what was shown.
 */
export const RECORDING_NOTICE_VERSION = "v1";

export function recordingNoticeText(companyName: string): string {
  const company = companyName.trim() || "the company";
  return `This interview will be recorded. The recording will be available only to authorized members of ${company}'s hiring team and will be deleted after 6 months.`;
}

/* ── recording bot (migration 040) ──────────────────────────────── */

/** final_interview_bots.status, in migration 040's CHECK order. */
export const FINAL_BOT_STATUSES = [
  "pending",
  "scheduled",
  "waiting_room",
  "in_call",
  "recording",
  "call_ended",
  "done",
  "fatal",
  "superseded",
  "deleted",
] as const;
export type FinalBotStatus = (typeof FINAL_BOT_STATUSES)[number];

/** final_interview_bots.import_status, in migration 040's CHECK order. */
export const FINAL_BOT_IMPORT_STATUSES = [
  "none",
  "queued",
  "importing",
  "ready",
  "failed",
] as const;
export type FinalBotImportStatus = (typeof FINAL_BOT_IMPORT_STATUSES)[number];

/** The participant name candidates and interviewers see in the call. */
export const RECORDING_BOT_NAME = "Remotiv Recorder";
/** The bot is told to join this long before the interview starts. */
export const RECORDING_BOT_JOIN_LEAD_MS = 60_000;
/**
 * Recall treats a bot whose join time is more than 10 minutes away as
 * scheduled; closer than that it is an ad-hoc bot from a shared pool, which V1
 * does not use. A bot is never created with less lead than this.
 */
export const RECORDING_BOT_MIN_SCHEDULE_LEAD_MS = 10 * 60_000;
/** Recall keeps the media this long unless the import deletes it sooner. */
export const RECORDING_BOT_RETENTION_HOURS = 72;
export const RECORDING_BOT_WAITING_ROOM_TIMEOUT_S = 600;
export const RECORDING_BOT_NOONE_JOINED_TIMEOUT_S = 900;
export const RECORDING_BOT_EVERYONE_LEFT_TIMEOUT_S = 30;
export const RECORDING_BOT_RECORDING_TIMEOUT_S = 10_800;
/** metadata.integration on every bot Remotiv creates; the only marker reconciliation trusts. */
export const RECORDING_BOT_INTEGRATION = "remotiv-final-interview";

/* ── recording host alerts (recording step 3) ───────────────────── */

/** The job type for both host alerts; payload.kind says which. JOB_TYPES.FINAL_BOT_LOBBY_CHECK. */
export const FINAL_BOT_ALERT_JOB = "final_bot_lobby_check";
export type RecordingAlertKind = "lobby" | "failure";
/** How long the bot waits in the lobby before the host is told. */
export const RECORDING_LOBBY_ALERT_DELAY_MS = 2 * 60_000;
/**
 * last_event_code values a bot row is left with when the recorder could not be
 * scheduled at all (recording step 3b). Each is terminal and raises the host's
 * failure alert with the "will not be able to join" wording.
 */
export const SCHEDULE_TIME_FAILURE_CODES = [
  "no_meeting_url",
  "too_late_to_schedule",
  "create_failed",
  "vendor_metadata_mismatch",
] as const;
/** Failure-alert jobs one bot row may ever have, whoever queues them. */
export const RECORDING_FAILURE_ALERT_MAX_JOBS = 3;
/** Attempts per alert job: about 7.5 minutes of email retries at the queue's backoff. */
export const RECORDING_ALERT_MAX_ATTEMPTS = 5;
/** How long an alert waits for the email provider before counting the send as refused. */
export const RECORDING_ALERT_EMAIL_TIMEOUT_MS = 15_000;

/** Recall call_ended sub codes meaning the bot never got out of the waiting room. */
export const RECORDING_WAITING_ROOM_FAILURE_SUB_CODES: ReadonlySet<string> = new Set([
  "timeout_exceeded_waiting_room",
  "call_ended_by_platform_waiting_room_timeout",
  "bot_kicked_from_waiting_room",
]);

/* ── fixed copy ─────────────────────────────────────────────────── */

export const HOST_NEEDS_CALENDAR =
  "The host needs Google Calendar connected before they can host a final interview.";

export const ACKNOWLEDGE_RECORDING =
  "Please confirm you understand the interview will be recorded.";

export const NOT_A_BOOKING_ROLE =
  "Only an owner, admin or recruiter can send or cancel interview booking links.";
