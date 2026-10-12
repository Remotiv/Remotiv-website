import { createHash } from "node:crypto";
import { escapeHtml } from "@/lib/email/candidate/render";
import { sendEmail } from "@/lib/email/send";
import type { BackgroundJob } from "@/lib/jobs-queue";
import { resolveHref } from "@/lib/notifications/company";
import { TerminalJobError } from "@/lib/queue/failure-class";
import { isRecallId } from "@/lib/recall/client";
import { createServiceClient } from "@/lib/supabase/server";
import { deterministicUuid } from "./bots";
import {
  interviewTypeLabel,
  RECORDING_ALERT_EMAIL_TIMEOUT_MS,
  RECORDING_BOT_NAME,
  RECORDING_LOBBY_ALERT_DELAY_MS,
  type RecordingAlertKind,
  SCHEDULE_TIME_FAILURE_CODES,
} from "./constants";

/**
 * Host alerts for the recording bot: "admit the recorder" when it has waited
 * in the Google Meet lobby for two minutes, and "your interview is not being
 * recorded" when it could not record or could not even be scheduled.
 * Recording steps 3 and 3b.
 *
 * ── Who is told ──────────────────────────────────────────────
 *
 * Only the host of that final interview, and only when every link checks out:
 * the bot row is live, its booking is a booked final round for that interview,
 * the interview is active, the interview's host is the booking's host, and that
 * member is active in the same company. Anything unverifiable sends nothing;
 * there is no fallback address. The candidate's first name is read through a
 * company-filtered query.
 *
 * ── The claim ────────────────────────────────────────────────
 *
 * lobby_alert_sent_at / failure_alert_sent_at is set in ONE conditional UPDATE
 * that only succeeds while it is null, so two jobs racing for a bot cannot both
 * go on. Everything after the claim is done by its holder only.
 *
 * ── Email: retried, never duplicated within 24 hours ─────────
 *
 * Every send carries a Resend idempotency key built from the bot row, the
 * alert kind and a digest of the exact subject and body, so the key always
 * accompanies an identical payload. For 24 hours Resend answers a repeat with
 * the first response and sends nothing. A send waits at most 15 seconds;
 * Resend's SDK cannot abort, so a timed-out request may still go out, which
 * is why the key matters. A refused or timed-out send releases the claim and
 * the queue retries, up to 5 attempts. If the stored facts behind the email
 * change between attempts (a renamed candidate, a different reason), the
 * digest changes and that corrected email is sent: at most one per distinct
 * text.
 *
 * ── Bell: at most one per alert, by primary key ──────────────
 *
 * The bell row's id is derived from the bot row and the alert kind, so the
 * database refuses a second one (23505, read as "already there"). An insert
 * that errors is checked by reading that id back: found counts as delivered,
 * missing as failed, and an unreadable answer as unconfirmed, which is never
 * retried blindly.
 *
 * ── When the email fails ─────────────────────────────────────
 *
 *   not the last attempt  release the claim and retry. If the release
 *                         reports an error, ownership is checked with a
 *                         second conditional write: still ours means the
 *                         release never landed, so the bell goes now and the
 *                         claim stands; not ours means it did land, so retry;
 *                         unanswerable means stop without a bell.
 *   the last attempt      send the bell and keep the claim.
 *
 * A bell that definitely failed with no email delivered gives the claim back
 * and throws, so a retry (or the reconcile, within its cap) can try again.
 *
 * Not guaranteed: a crash between the claim and the sends loses that alert; a
 * host with no verifiable identity is never told; nothing here is exactly once.
 */

type AlertKind = RecordingAlertKind;

/** Fixed sentences only: Recall's own text never reaches an email. */
const FAILURE_REASONS: Readonly<Record<string, string>> = {
  timeout_exceeded_waiting_room: "It was not admitted from the waiting room in time.",
  call_ended_by_platform_waiting_room_timeout:
    "Google Meet closed its waiting room before it was admitted.",
  bot_kicked_from_waiting_room: "It was removed from the waiting room.",
  google_meet_bot_blocked: "Google Meet did not let it join the call.",
  google_meet_knocking_disabled: "The meeting settings did not let it ask to join.",
};

/** The one reason line per schedule-time cause (step 3b), keyed on last_event_code. */
const SCHEDULE_TIME_REASONS: Readonly<
  Record<(typeof SCHEDULE_TIME_FAILURE_CODES)[number], string>
> = {
  no_meeting_url: "The calendar event has no Google Meet link.",
  too_late_to_schedule: "It was booked too close to the start time to schedule the recorder.",
  create_failed: "The recording service could not schedule the recorder.",
  vendor_metadata_mismatch: "The recording service could not schedule the recorder.",
};

type Service = ReturnType<typeof createServiceClient>;

export type AlertDeps = {
  service: Service;
  sendEmail: (
    payload: { to: string; subject: string; html: string },
    options?: { idempotencyKey?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  now: () => number;
  /** How long to wait for the email provider. Defaults to 15 seconds. */
  emailTimeoutMs?: number;
};

/** Where this run sits in the job's retries. */
export type AlertAttempt = { finalAttempt: boolean };

export type AlertOutcome =
  | "sent"
  | "sent_bell_only"
  | "bell_after_email_failure"
  | "email_sent_bell_failed"
  | "bell_unconfirmed"
  | "already_sent"
  | "gone"
  | "not_live"
  | "not_waiting"
  | "not_active"
  | "host_mismatch"
  | "host_unverified";

type AlertRow = {
  id: string;
  company_id: string;
  final_interview_id: string;
  application_id: string;
  booking_id: string;
  status: string;
  provider_recording_id: string | null;
  superseded_at: string | null;
  last_event_code: string | null;
  last_event_sub_code: string | null;
  last_event_at: string | null;
  lobby_alert_sent_at: string | null;
  failure_alert_sent_at: string | null;
};

const ALERT_ROW_COLUMNS =
  "id, company_id, final_interview_id, application_id, booking_id, status, provider_recording_id, superseded_at, last_event_code, last_event_sub_code, last_event_at, lobby_alert_sent_at, failure_alert_sent_at";

const STAMP: Record<AlertKind, "lobby_alert_sent_at" | "failure_alert_sent_at"> = {
  lobby: "lobby_alert_sent_at",
  failure: "failure_alert_sent_at",
};

function dbError(what: string, error: { code?: string } | null | undefined): Error {
  return new Error(`${what} failed (${error?.code ?? "db"})`);
}

/** "Final interview" reads "final interview" mid-sentence; CTO and custom names keep their case. */
function inSentence(type: string, label: string): string {
  return ["final", "hiring_manager", "technical"].includes(type)
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}

export function isScheduleTimeFailure(code: string | null | undefined): boolean {
  return (SCHEDULE_TIME_FAILURE_CODES as readonly string[]).includes(code ?? "");
}

/**
 * Whether the stored facts PROVE the bot was in the call: a recording id
 * arrived, or it is in the call now. A fatal or finished row's earlier status
 * is not kept, so anything else is unproven and gets no partial-recording line.
 */
export function provablyJoined(row: Pick<AlertRow, "provider_recording_id" | "status">): boolean {
  return (
    row.provider_recording_id !== null || row.status === "in_call" || row.status === "recording"
  );
}

export function lobbyEmail(label: string, firstName: string): { subject: string; html: string } {
  return {
    subject: `Admit ${RECORDING_BOT_NAME} to record your interview`,
    html: `<p>${escapeHtml(RECORDING_BOT_NAME)} is waiting to join your ${escapeHtml(label)} with ${escapeHtml(firstName)}. Admit it in Google Meet so the interview can be recorded.</p>`,
  };
}

/** The bot joined or tried to, and could not record. */
export function failureEmail(
  label: string,
  firstName: string,
  reason: string | null,
  joined: boolean,
): { subject: string; html: string } {
  return {
    subject: `Your ${label} is not being recorded`,
    html: [
      `<p>${escapeHtml(RECORDING_BOT_NAME)} could not record your ${escapeHtml(label)} with ${escapeHtml(firstName)}.${reason ? ` ${escapeHtml(reason)}` : ""}</p>`,
      `<p>The interview itself is not affected and can go ahead as planned.${joined ? " If any part of it was recorded before this happened, that part is kept." : ""}</p>`,
    ].join(""),
  };
}

/** The recorder could not be scheduled at all, so it never joined. */
export function scheduleFailureEmail(
  label: string,
  firstName: string,
  code: (typeof SCHEDULE_TIME_FAILURE_CODES)[number],
): { subject: string; html: string } {
  return {
    subject: `Your ${label} is not being recorded`,
    html: [
      `<p>${escapeHtml(RECORDING_BOT_NAME)} will not be able to join your ${escapeHtml(label)} with ${escapeHtml(firstName)}, so it will not be recorded automatically. ${escapeHtml(SCHEDULE_TIME_REASONS[code])}</p>`,
      "<p>The interview itself is not affected.</p>",
    ].join(""),
  };
}

/** One key per bot row, alert kind and exact email text. */
export function emailIdempotencyKey(
  botRowId: string,
  kind: AlertKind,
  message: { subject: string; html: string },
): string {
  const digest = createHash("sha256")
    .update(`${message.subject}\n${message.html}`)
    .digest("hex")
    .slice(0, 16);
  return `remotiv-final-alert-${kind}-${botRowId}-${digest}`;
}

/** The bell row's id: one per bot row and alert kind, so a second insert is refused. */
export function bellNotificationId(botRowId: string, kind: AlertKind): string {
  return deterministicUuid(`final-bot-alert-bell:${botRowId}:${kind}`);
}

function defaultDeps(): AlertDeps {
  return { service: createServiceClient(), sendEmail, now: Date.now };
}

/** The host's own address: the member row, then their sign-in address. Never a company inbox. */
async function hostAddress(
  service: Service,
  host: { email: string | null; user_id: string | null },
): Promise<string | null> {
  const direct = (host.email ?? "").trim();
  if (direct) return direct;
  if (!host.user_id) return null;
  const { data } = await service.auth.admin.getUserById(host.user_id);
  return (data?.user?.email ?? "").trim() || null;
}

/** The send, waited on for at most the time limit. A timeout counts as refused. */
async function sendWithLimit(
  deps: AlertDeps,
  payload: { to: string; subject: string; html: string },
  idempotencyKey: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false }),
      deps.emailTimeoutMs ?? RECORDING_ALERT_EMAIL_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      deps.sendEmail(payload, { idempotencyKey }).catch(() => ({ ok: false })),
      limit,
    ]);
    return result.ok;
  } finally {
    clearTimeout(timer);
  }
}

type BellInput = {
  row: AlertRow;
  kind: AlertKind;
  /** The bot row's company: the host, the applicant and the bell all belong to it. */
  companyId: string;
  hostId: string;
  jobId: string;
  title: string;
  body: string;
};

/** Insert this alert's one bell row, and say whether it is there. */
async function insertBell(
  deps: AlertDeps,
  input: BellInput,
): Promise<"inserted" | "failed" | "unknown"> {
  const id = bellNotificationId(input.row.id, input.kind);
  const type = input.kind === "lobby" ? "final_recording_lobby" : "final_recording_failed";
  const { error } = await deps.service.from("notifications_company").insert({
    id,
    company_id: input.companyId,
    member_id: input.hostId,
    type,
    title: input.title,
    body: input.body,
    job_id: input.jobId,
    application_id: input.row.application_id,
    href: resolveHref({ type, applicationId: input.row.application_id }),
  });
  if (!error) return "inserted";
  if (error.code === "23505") return "inserted"; // this alert's bell is already there
  // The write may have landed even though the answer did not: look.
  const { data, error: readErr } = await deps.service
    .from("notifications_company")
    .select("id")
    .eq("id", id)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (readErr) return "unknown";
  return data ? "inserted" : "failed";
}

/**
 * Give the claim back after a refused email. "released" when it is free (the
 * write landed, or ownership shows someone else holds it), "still_ours" when
 * the release never landed, "unknown" when neither could be confirmed.
 */
async function releaseClaim(
  deps: AlertDeps,
  row: AlertRow,
  stamp: "lobby_alert_sent_at" | "failure_alert_sent_at",
  claimedAt: string,
): Promise<"released" | "still_ours" | "unknown"> {
  const { error } = await deps.service
    .from("final_interview_bots")
    .update({ [stamp]: null })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq(stamp, claimedAt);
  if (!error) return "released";
  // The release reported an error. Re-writing our own value only matches if
  // the claim is still exactly ours, so it reads ownership without changing it.
  const { data, error: checkErr } = await deps.service
    .from("final_interview_bots")
    .update({ [stamp]: claimedAt })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .eq(stamp, claimedAt)
    .select("id");
  if (checkErr) return "unknown";
  return ((data ?? []) as unknown[]).length > 0 ? "still_ours" : "released";
}

/** One alert for one bot row. Exported with injectable deps for tests. */
export async function runFinalBotAlert(
  deps: AlertDeps,
  payload: Record<string, unknown>,
  attempt: AlertAttempt = { finalAttempt: false },
): Promise<AlertOutcome> {
  const botRowId = payload.botRowId;
  const kind = payload.kind;
  if (!isRecallId(botRowId) || (kind !== "lobby" && kind !== "failure")) {
    throw new TerminalJobError("deterministic", "final_bot_lobby_check payload is malformed");
  }
  const stamp = STAMP[kind];
  const now = deps.now();

  const { data: rowData, error: rowErr } = await deps.service
    .from("final_interview_bots")
    .select(ALERT_ROW_COLUMNS)
    .eq("id", botRowId)
    .maybeSingle();
  if (rowErr) throw dbError("bot row read", rowErr);
  const row = rowData as AlertRow | null;
  if (!row) return "gone";
  if (row.superseded_at || row.status === "deleted" || row.status === "superseded") {
    return "not_live";
  }
  if (row[stamp]) return "already_sent";

  if (kind === "lobby") {
    if (row.status !== "waiting_room") return "not_waiting";
    const waitedMs = now - Date.parse(row.last_event_at ?? "");
    if (!(waitedMs >= RECORDING_LOBBY_ALERT_DELAY_MS)) {
      // Early only through clock skew: the queue's backoff brings it back.
      throw new Error("lobby check ran before the bot had waited two minutes; retrying");
    }
  }

  const [bookingRes, fiRes] = await Promise.all([
    deps.service
      .from("interview_bookings")
      .select("id, status, purpose, final_interview_id, host_member_id")
      .eq("id", row.booking_id)
      .eq("company_id", row.company_id)
      .maybeSingle(),
    deps.service
      .from("final_interviews")
      .select("id, status, host_member_id, interview_type, custom_label, job_id")
      .eq("id", row.final_interview_id)
      .eq("company_id", row.company_id)
      .maybeSingle(),
  ]);
  if (bookingRes.error) throw dbError("booking read", bookingRes.error);
  if (fiRes.error) throw dbError("final interview read", fiRes.error);
  const booking = bookingRes.data as {
    status: string;
    purpose: string;
    final_interview_id: string | null;
    host_member_id: string;
  } | null;
  const fi = fiRes.data as {
    status: string;
    host_member_id: string;
    interview_type: string;
    custom_label: string | null;
    job_id: string;
  } | null;
  if (
    booking?.status !== "booked" ||
    booking.purpose !== "final" ||
    booking.final_interview_id !== row.final_interview_id ||
    fi?.status !== "active"
  ) {
    return "not_active";
  }
  if (fi.host_member_id !== booking.host_member_id) return "host_mismatch";

  const [hostRes, appRes] = await Promise.all([
    deps.service
      .from("company_members")
      .select("id, email, user_id")
      .eq("id", fi.host_member_id)
      .eq("company_id", row.company_id)
      .eq("status", "active")
      .maybeSingle(),
    deps.service
      .from("job_applications")
      .select("first_name")
      .eq("id", row.application_id)
      .eq("company_id_snapshot", row.company_id)
      .maybeSingle(),
  ]);
  if (hostRes.error) throw dbError("host read", hostRes.error);
  if (appRes.error) throw dbError("application read", appRes.error);
  const host = hostRes.data as { id: string; email: string | null; user_id: string | null } | null;
  if (!host) return "host_unverified";
  const address = await hostAddress(deps.service, host);
  const firstName =
    ((appRes.data as { first_name: string | null } | null)?.first_name ?? "").trim() ||
    "the candidate";
  const label = inSentence(
    fi.interview_type,
    interviewTypeLabel(fi.interview_type, fi.custom_label),
  );

  // The claim. One conditional UPDATE: only one job can move the stamp off null.
  const claimedAt = new Date(now).toISOString();
  let claim = deps.service
    .from("final_interview_bots")
    .update({ [stamp]: claimedAt })
    .eq("id", row.id)
    .eq("company_id", row.company_id)
    .is(stamp, null)
    .is("superseded_at", null)
    .not("status", "in", '("deleted","superseded")');
  if (kind === "lobby") claim = claim.eq("status", "waiting_room");
  const { data: claimed, error: claimErr } = await claim.select("id");
  if (claimErr) throw dbError("alert claim", claimErr);
  if (((claimed ?? []) as unknown[]).length === 0) return "already_sent";

  const scheduleCode = isScheduleTimeFailure(row.last_event_code)
    ? (row.last_event_code as (typeof SCHEDULE_TIME_FAILURE_CODES)[number])
    : null;
  const message =
    kind === "lobby"
      ? lobbyEmail(label, firstName)
      : scheduleCode
        ? scheduleFailureEmail(label, firstName, scheduleCode)
        : failureEmail(
            label,
            firstName,
            FAILURE_REASONS[row.last_event_sub_code ?? ""] ?? null,
            provablyJoined(row),
          );
  const bell: BellInput = {
    row,
    kind,
    companyId: row.company_id,
    hostId: host.id,
    jobId: fi.job_id,
    title: message.subject,
    body:
      kind === "lobby"
        ? "Admit it in Google Meet so the interview can be recorded."
        : "The interview itself is not affected.",
  };

  let emailed: boolean | null = null; // null: the host has no address
  if (address) {
    emailed = await sendWithLimit(
      deps,
      { to: address, subject: message.subject, html: message.html },
      emailIdempotencyKey(row.id, kind, message),
    );
    if (!emailed && !attempt.finalAttempt) {
      const release = await releaseClaim(deps, row, stamp, claimedAt);
      if (release === "released") {
        throw new Error(`${kind} alert email was not accepted; retrying`);
      }
      if (release === "unknown") {
        // Cannot tell whether the claim is still ours: a bell now could be a
        // second one if another job has claimed since. Stop without it.
        console.error(
          `[final-bot-alert] ${row.id}: ${kind} claim unverifiable after a failed send`,
        );
        throw new Error(`${kind} alert claim could not be verified after a failed send`);
      }
      // still_ours: the release never landed, so no retry will run. Bell now.
    }
  }

  const bellResult = await insertBell(deps, bell);
  if (bellResult === "unknown") {
    // Never retried blindly: the claim stands and nothing is resent.
    console.error(`[final-bot-alert] ${row.id}: ${kind} bell unconfirmed`);
    return "bell_unconfirmed";
  }
  if (bellResult === "failed") {
    if (emailed) {
      console.error(`[final-bot-alert] ${row.id}: ${kind} emailed but the bell insert failed`);
      return "email_sent_bell_failed";
    }
    // Nothing reached the host: give the claim back so a retry can try again.
    await releaseClaim(deps, row, stamp, claimedAt);
    throw new Error(`${kind} alert bell insert failed and no email was delivered; retrying`);
  }

  const outcome: AlertOutcome =
    emailed === true ? "sent" : emailed === false ? "bell_after_email_failure" : "sent_bell_only";
  console.log(`[final-bot-alert] ${row.id}: ${kind} alert ${outcome}`);
  return outcome;
}

export async function handleFinalBotAlert(job: BackgroundJob): Promise<void> {
  // The queue buries the job once attempts reach max_attempts (planFailure),
  // so this run is the last when one more failure would do that.
  const finalAttempt = job.attempts + 1 >= job.max_attempts;
  await runFinalBotAlert(defaultDeps(), (job.payload ?? {}) as Record<string, unknown>, {
    finalAttempt,
  });
}
