/**
 * Final Human Interview: the fixed vocabulary.
 *
 * Client-safe on purpose: no server imports, so the drawer card (step 3b) and
 * the candidate booking page can read the same labels, durations and notice
 * text the server enforces. Every value here matches a CHECK in migration 038.
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

/* ── fixed copy ─────────────────────────────────────────────────── */

export const HOST_NEEDS_CALENDAR =
  "The host needs Google Calendar connected before they can host a final interview.";

export const ACKNOWLEDGE_RECORDING =
  "Please confirm you understand the interview will be recorded.";

export const NOT_A_BOOKING_ROLE =
  "Only an owner, admin or recruiter can send or cancel interview booking links.";
