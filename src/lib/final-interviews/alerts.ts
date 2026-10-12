import { escapeHtml } from "@/lib/email/candidate/render";
import { sendEmail } from "@/lib/email/send";
import type { BackgroundJob } from "@/lib/jobs-queue";
import { notifyCompanyMember } from "@/lib/notifications/company";
import { TerminalJobError } from "@/lib/queue/failure-class";
import { isRecallId } from "@/lib/recall/client";
import { createServiceClient } from "@/lib/supabase/server";
import {
  interviewTypeLabel,
  RECORDING_BOT_NAME,
  RECORDING_LOBBY_ALERT_DELAY_MS,
  type RecordingAlertKind,
} from "./constants";

/**
 * Host alerts for the recording bot: "admit the recorder" when it has waited
 * in the Google Meet lobby for two minutes, and "your interview is not being
 * recorded" when it could not record. Recording step 3.
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
 * ── Once, not twice ──────────────────────────────────────────
 *
 * The alert is claimed by setting lobby_alert_sent_at or failure_alert_sent_at
 * in ONE conditional UPDATE that only succeeds while the column is null, so two
 * jobs racing for the same bot cannot both win. The claim comes before the
 * send. If the email provider refuses, the claim is released (only if it is
 * still ours) and the job is retried; so a refused email is retried and an
 * accepted one is never repeated. A crash between the claim and the send loses
 * that alert: at most once, by design, because a duplicate "admit the recorder"
 * email is worse than the bell entry alone, and the schema has no outbox to do
 * better. With no address for the host, the bell alone is the delivery and the
 * claim stands.
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

type Service = ReturnType<typeof createServiceClient>;

export type AlertDeps = {
  service: Service;
  sendEmail: (payload: { to: string; subject: string; html: string }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  notifyMember: typeof notifyCompanyMember;
  now: () => number;
};

export type AlertOutcome =
  | "sent"
  | "sent_bell_only"
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
  superseded_at: string | null;
  last_event_code: string | null;
  last_event_sub_code: string | null;
  last_event_at: string | null;
  lobby_alert_sent_at: string | null;
  failure_alert_sent_at: string | null;
};

const ALERT_ROW_COLUMNS =
  "id, company_id, final_interview_id, application_id, booking_id, status, superseded_at, last_event_code, last_event_sub_code, last_event_at, lobby_alert_sent_at, failure_alert_sent_at";

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

export function lobbyEmail(label: string, firstName: string): { subject: string; html: string } {
  return {
    subject: `Admit ${RECORDING_BOT_NAME} to record your interview`,
    html: `<p>${escapeHtml(RECORDING_BOT_NAME)} is waiting to join your ${escapeHtml(label)} with ${escapeHtml(firstName)}. Admit it in Google Meet so the interview can be recorded.</p>`,
  };
}

export function failureEmail(
  label: string,
  firstName: string,
  reason: string | null,
): { subject: string; html: string } {
  return {
    subject: `Your ${label} is not being recorded`,
    html: [
      `<p>${escapeHtml(RECORDING_BOT_NAME)} could not record your ${escapeHtml(label)} with ${escapeHtml(firstName)}.${reason ? ` ${escapeHtml(reason)}` : ""}</p>`,
      "<p>The interview itself is not affected and can go ahead as planned. If any part of it was recorded before this happened, that part is kept.</p>",
    ].join(""),
  };
}

function defaultDeps(): AlertDeps {
  return {
    service: createServiceClient(),
    sendEmail,
    notifyMember: notifyCompanyMember,
    now: Date.now,
  };
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

/** One alert for one bot row. Exported with injectable deps for tests. */
export async function runFinalBotAlert(
  deps: AlertDeps,
  payload: Record<string, unknown>,
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

  const reason =
    kind === "failure" ? (FAILURE_REASONS[row.last_event_sub_code ?? ""] ?? null) : null;
  const message =
    kind === "lobby" ? lobbyEmail(label, firstName) : failureEmail(label, firstName, reason);

  if (address) {
    const sent = await deps.sendEmail({
      to: address,
      subject: message.subject,
      html: message.html,
    });
    if (!sent.ok) {
      // Give the claim back, but only if it is still the one this job wrote.
      const { error: releaseErr } = await deps.service
        .from("final_interview_bots")
        .update({ [stamp]: null })
        .eq("id", row.id)
        .eq("company_id", row.company_id)
        .eq(stamp, claimedAt);
      if (releaseErr)
        console.error(`[final-bot-alert] ${row.id}: ${kind} claim kept after a failed send`);
      throw new Error(`${kind} alert email was not accepted; retrying`);
    }
  }

  await deps.notifyMember({
    companyId: row.company_id,
    memberId: host.id,
    type: kind === "lobby" ? "final_recording_lobby" : "final_recording_failed",
    title: message.subject,
    body:
      kind === "lobby"
        ? "Admit it in Google Meet so the interview can be recorded."
        : "The interview itself is not affected.",
    jobId: fi.job_id,
    applicationId: row.application_id,
  });
  const outcome: AlertOutcome = address ? "sent" : "sent_bell_only";
  console.log(`[final-bot-alert] ${row.id}: ${kind} alert ${outcome}`);
  return outcome;
}

export async function handleFinalBotAlert(job: BackgroundJob): Promise<void> {
  await runFinalBotAlert(defaultDeps(), (job.payload ?? {}) as Record<string, unknown>);
}
