import type { FinalRecordingSummary } from "./types";

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
/**
 * Recall keeps the media this long unless the import deletes it sooner. A
 * fallback only: the import deletes Recall's copy as soon as Remotiv's is
 * verified, and seven days leaves room for retries spread hours apart.
 */
export const RECORDING_BOT_RETENTION_HOURS = 168;
export const RECORDING_BOT_WAITING_ROOM_TIMEOUT_S = 600;
export const RECORDING_BOT_NOONE_JOINED_TIMEOUT_S = 900;
export const RECORDING_BOT_EVERYONE_LEFT_TIMEOUT_S = 30;
export const RECORDING_BOT_RECORDING_TIMEOUT_S = 10_800;
/** metadata.integration on every bot Remotiv creates; the only marker reconciliation trusts. */
export const RECORDING_BOT_INTEGRATION = "remotiv-final-interview";

/* ── recording host alerts (recording step 3) ───────────────────── */

/** The job type for both host alerts; payload.kind says which. JOB_TYPES.FINAL_BOT_LOBBY_CHECK. */
export const FINAL_BOT_ALERT_JOB = "final_bot_lobby_check";
/** "import_failed" is recording step 4's: the recording could not be copied into Remotiv. */
export type RecordingAlertKind = "lobby" | "failure" | "import_failed";
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

/**
 * Why the recorder could not record, one fixed sentence per Recall sub code.
 * Recall's own text never reaches a person. Shared by the host's failure email
 * (alerts.ts) and the Final interviews card (recording step 5), so the two
 * always say the same thing.
 */
export const RECORDING_FAILURE_REASONS: Readonly<Record<string, string>> = {
  timeout_exceeded_waiting_room: "It was not admitted from the waiting room in time.",
  call_ended_by_platform_waiting_room_timeout:
    "Google Meet closed its waiting room before it was admitted.",
  bot_kicked_from_waiting_room: "It was removed from the waiting room.",
  google_meet_bot_blocked: "Google Meet did not let it join the call.",
  google_meet_knocking_disabled: "The meeting settings did not let it ask to join.",
};

/** The one reason line per schedule-time cause (step 3b), keyed on last_event_code. */
export const RECORDING_SCHEDULE_FAILURE_REASONS: Readonly<
  Record<(typeof SCHEDULE_TIME_FAILURE_CODES)[number], string>
> = {
  no_meeting_url: "The calendar event has no Google Meet link.",
  too_late_to_schedule: "It was booked too close to the start time to schedule the recorder.",
  create_failed: "The recording service could not schedule the recorder.",
  vendor_metadata_mismatch: "The recording service could not schedule the recorder.",
};

export function isScheduleTimeFailure(code: string | null | undefined): boolean {
  return (SCHEDULE_TIME_FAILURE_CODES as readonly string[]).includes(code ?? "");
}

/** The reason line the host's failure email gives for a fatal bot row, or null. */
export function recordingFailureReason(row: {
  last_event_code: string | null;
  last_event_sub_code: string | null;
}): string | null {
  if (isScheduleTimeFailure(row.last_event_code)) {
    return RECORDING_SCHEDULE_FAILURE_REASONS[
      row.last_event_code as (typeof SCHEDULE_TIME_FAILURE_CODES)[number]
    ];
  }
  return RECORDING_FAILURE_REASONS[row.last_event_sub_code ?? ""] ?? null;
}

/* ── recording import (recording step 4) ────────────────────────── */

/** JOB_TYPES.FINAL_RECORDING_IMPORT; payload { botId: <bot row id> }. */
export const FINAL_RECORDING_IMPORT_JOB = "final_recording_import";
/** The private bucket recordings are copied into. Created by hand, with its policies. */
export const FINAL_RECORDING_BUCKET = "final-interview-recordings";
/** Bytes per multipart part, and so the most one import holds in memory at once. */
export const RECORDING_IMPORT_PART_BYTES = 8 * 1024 * 1024;
/** final_interview_recordings.size_bytes CHECK: 2 GiB. */
export const RECORDING_MAX_BYTES = 2_147_483_648;
/** Import jobs one bot row may ever have, whoever queues them. */
export const RECORDING_IMPORT_MAX_JOBS = 3;
/** Attempts per import job. A budget hand-back (JobYield) is not an attempt. */
export const RECORDING_IMPORT_MAX_ATTEMPTS = 5;
/** The reconcile waits this long after an import job ends before queueing the next. */
export const RECORDING_IMPORT_RETRY_GAP_MS = 6 * 60 * 60_000;
/**
 * The figure the recording-ready bell states. Left at 6 until the wording step
 * (6b) aligns the bell, the candidate notice and the privacy page with
 * RECORDING_RETENTION_MONTHS. Nothing deletes on this number.
 */
export const RECORDING_KEEP_MONTHS = 6;
/**
 * Recording step 6a: a copied recording is deleted this many CALENDAR months
 * after its interview's scheduled start (the booking it was recorded in). A
 * date past the end of the target month lands on that month's last day.
 */
export const RECORDING_RETENTION_MONTHS = 3;
/** JOB_TYPES.FINAL_RECORDING_PURGE: retention, then the orphan sweep. Daily. */
export const FINAL_RECORDING_PURGE_JOB = "final_recording_purge";
/** An unreferenced object or upload must be this old before the sweep removes it. */
export const RECORDING_ORPHAN_GRACE_MS = 24 * 60 * 60_000;
/**
 * How long a playback URL lives (recording step 5). Three hours, so a long
 * interview stays seekable to the end without the player losing its source.
 */
export const FINAL_RECORDING_PLAYBACK_TTL_SECONDS = 3 * 60 * 60;
/** uploaded_by_name on rows the import writes (migration 040). */
export const RECORDING_IMPORT_UPLOADER = "Remotiv automatic import";

/** final_interview_bots.import_error values the import writes. Fixed codes only. */
export const RECORDING_IMPORT_ERRORS = {
  tooLarge: "too_large",
  empty: "empty_recording",
  notMp4: "not_mp4",
  sizeMismatch: "size_mismatch",
  recordingFailed: "recording_failed",
  gone: "recording_gone",
  noVideo: "no_video",
  ownerMismatch: "owner_mismatch",
  duplicate: "duplicate_recording",
  retriesExhausted: "retries_exhausted",
} as const;

/** Import failures that do not alert the host: the interview already has a ready recording. */
export const RECORDING_IMPORT_SILENT_ERRORS: ReadonlySet<string> = new Set([
  RECORDING_IMPORT_ERRORS.duplicate,
]);

/* ── recording status on the card (recording step 5) ─────────────── */

/**
 * After the call ends with no recording id, the card says "saving" for this
 * long, since recording.done can trail the bot's own events. After it, the
 * call is known to have ended without a recording (nobody joined, say).
 */
export const RECORDING_ENDED_GRACE_MS = 60 * 60_000;
export const RECORDING_ENDED_WITHOUT_MEDIA = "The call ended without a recording.";

/** The bot-row columns the card's status is derived from. */
export type RecordingBotFacts = {
  booking_id: string;
  status: string;
  join_at: string;
  import_status: string;
  last_event_code: string | null;
  last_event_sub_code: string | null;
  last_event_at: string | null;
  provider_recording_id: string | null;
  superseded_at: string | null;
};

/** A recording row's columns the card needs, in any status. Never its storage path. */
export type RecordingRowFacts = {
  id: string;
  source: string;
  vendor_recording_id: string | null;
  status: string;
  uploaded_at: string | null;
  created_at: string;
  /** Set when a person deleted it; null when the retention purge did. */
  deleted_by: string | null;
};

const NO_RECORDING: FinalRecordingSummary = {
  state: "none",
  joinAt: null,
  reason: null,
  recordingId: null,
  recordedAt: null,
  origin: null,
  fromEarlierBooking: false,
};

/** The summary for an interview whose recording facts could not be read. */
export const RECORDING_UNAVAILABLE: FinalRecordingSummary = {
  ...NO_RECORDING,
  state: "unavailable",
};

/**
 * One interview's recording status. A ready recording always wins: after a
 * reschedule the new booking's bot is still shown only until a recording is
 * ready, and a recording from an earlier booking says so. Otherwise the live
 * (not superseded) bot of the CURRENT booking decides; other bots are only
 * used to tell where a ready recording came from.
 */
export function deriveRecordingSummary(input: {
  currentBookingId: string | null;
  /** Every bot row of this interview, live and superseded. */
  bots: readonly RecordingBotFacts[];
  /** Every recording row of this interview, any status. At most one is ready (migration 038). */
  recordings: readonly RecordingRowFacts[];
  /** Booking id to its scheduled start, for dating a recording. */
  bookingStarts: ReadonlyMap<string, string | null>;
  nowMs: number;
}): FinalRecordingSummary {
  const { currentBookingId, bots, recordings } = input;
  const ready = recordings.find((r) => r.status === "ready");

  if (ready) {
    if (ready.source !== "recall_bot") {
      return {
        ...NO_RECORDING,
        state: "ready",
        recordingId: ready.id,
        recordedAt: ready.uploaded_at ?? ready.created_at,
        origin: "upload",
      };
    }
    const maker = ready.vendor_recording_id
      ? bots.find((b) => b.provider_recording_id === ready.vendor_recording_id)
      : undefined;
    return {
      ...NO_RECORDING,
      state: "ready",
      recordingId: ready.id,
      recordedAt:
        (maker ? input.bookingStarts.get(maker.booking_id) : null) ??
        ready.uploaded_at ??
        ready.created_at,
      origin: "recorder",
      fromEarlierBooking: maker !== undefined && maker.booking_id !== currentBookingId,
    };
  }

  const live = currentBookingId
    ? bots.find(
        (b) =>
          b.booking_id === currentBookingId &&
          b.superseded_at === null &&
          b.status !== "superseded" &&
          b.status !== "deleted",
      )
    : undefined;
  if (!live) return NO_RECORDING;

  if (live.import_status === "failed") return { ...NO_RECORDING, state: "save_failed" };
  if (live.status === "fatal") {
    return { ...NO_RECORDING, state: "not_recorded", reason: recordingFailureReason(live) };
  }
  if (live.import_status === "ready") {
    // The import marks the bot ready only after its recording row is ready
    // (import.ts), and nothing turns a ready row back. So a non-ready row here
    // is either the retention purge (expected) or an inconsistency, which is
    // shown as such, never hidden.
    const row = live.provider_recording_id
      ? recordings.find((r) => r.vendor_recording_id === live.provider_recording_id)
      : undefined;
    if (row?.status === "deleted" && row.deleted_by === null) {
      return { ...NO_RECORDING, state: "deleted" };
    }
    return { ...NO_RECORDING, state: "gone" };
  }
  if (live.import_status === "queued" || live.import_status === "importing") {
    return { ...NO_RECORDING, state: "saving" };
  }
  switch (live.status) {
    case "pending":
    case "scheduled":
      return { ...NO_RECORDING, state: "scheduled", joinAt: live.join_at };
    case "waiting_room":
      return { ...NO_RECORDING, state: "waiting" };
    case "in_call":
      return { ...NO_RECORDING, state: "in_call" };
    case "recording":
      return { ...NO_RECORDING, state: "recording" };
    case "call_ended":
    case "done": {
      if (live.provider_recording_id) return { ...NO_RECORDING, state: "saving" };
      const endedAt = Date.parse(live.last_event_at ?? "");
      if (Number.isFinite(endedAt) && input.nowMs - endedAt > RECORDING_ENDED_GRACE_MS) {
        return { ...NO_RECORDING, state: "not_recorded", reason: RECORDING_ENDED_WITHOUT_MEDIA };
      }
      return { ...NO_RECORDING, state: "saving" };
    }
    default:
      return NO_RECORDING;
  }
}

export type RecordingStatusLine = {
  /** info: neutral; warn: needs the host (amber); bad: failed (red); ready: watchable. */
  tone: "info" | "warn" | "bad" | "ready";
  text: string;
  detail: string | null;
};

/** Where a ready recording came from and when, so an earlier booking's is never mistaken for this one. */
function readyDetail(
  summary: FinalRecordingSummary,
  formatTime: (iso: string) => string,
): string | null {
  const when = summary.recordedAt ? formatTime(summary.recordedAt) : null;
  if (summary.origin === "upload") return when ? `Uploaded ${when}` : null;
  if (summary.fromEarlierBooking) {
    return when ? `From an earlier booking, recorded ${when}` : "From an earlier booking";
  }
  return when ? `Recorded ${when}` : null;
}

/**
 * The card's words for a summary, or null when it shows nothing (state none).
 * The text carries the meaning on its own; the tone only colours it.
 */
export function recordingStatusLine(
  summary: FinalRecordingSummary,
  formatTime: (iso: string) => string,
): RecordingStatusLine | null {
  switch (summary.state) {
    case "none":
      return null;
    case "scheduled":
      return {
        tone: "info",
        text: summary.joinAt
          ? `${RECORDING_BOT_NAME} will join at ${formatTime(summary.joinAt)}`
          : `${RECORDING_BOT_NAME} will join the call`,
        detail: null,
      };
    case "waiting":
      return {
        tone: "warn",
        text: `${RECORDING_BOT_NAME} is waiting to be admitted in Google Meet`,
        detail: null,
      };
    case "in_call":
      return { tone: "info", text: `${RECORDING_BOT_NAME} has joined the call`, detail: null };
    case "recording":
      return { tone: "info", text: "Recording in progress", detail: null };
    case "saving":
      return { tone: "info", text: "Saving recording...", detail: null };
    case "ready":
      return { tone: "ready", text: "Recording ready", detail: readyDetail(summary, formatTime) };
    case "not_recorded":
      return { tone: "bad", text: "Not being recorded", detail: summary.reason };
    case "save_failed":
      return { tone: "bad", text: "The recording could not be saved", detail: null };
    case "deleted":
      return { tone: "info", text: "Recording deleted after the retention period", detail: null };
    case "gone":
      return { tone: "warn", text: "Recording no longer available", detail: null };
    case "unavailable":
      return {
        tone: "warn",
        text: "Couldn't load the recording status. Reload to try again.",
        detail: null,
      };
  }
}

/* ── fixed copy ─────────────────────────────────────────────────── */

export const HOST_NEEDS_CALENDAR =
  "The host needs Google Calendar connected before they can host a final interview.";

export const ACKNOWLEDGE_RECORDING =
  "Please confirm you understand the interview will be recorded.";

export const NOT_A_BOOKING_ROLE =
  "Only an owner, admin or recruiter can send or cancel interview booking links.";
