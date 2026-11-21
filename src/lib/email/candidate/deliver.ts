import "server-only";
import { Resend } from "resend";
import {
  DELETION_IN_PROGRESS,
  deletionStartedFor,
  NOT_SENT_DELETING,
} from "@/lib/applicant-deletion";
import { redactCandidateLinks } from "@/lib/candidate-links";
import {
  alertSendFailure,
  type SendFailureInput,
  updatedOne,
} from "@/lib/notifications/send-failure";
import type { createServiceClient } from "@/lib/supabase/server";
import { EMAIL_SHELL } from "./templates";
import type { LoggedEvent, MessageStatus } from "./types";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * The one place a candidate email leaves the building.
 *
 * Extracted from the send_message handler so the composer can send the SAME
 * way rather than growing a second implementation. Everything that makes a
 * candidate email safe lives here — sender identity, reply-to resolution, the
 * daily cap, and the log-before-send guarantee — so a caller cannot skip one
 * by forgetting it existed.
 *
 * Deliberately does NOT decide idempotency or opt-out policy. Those differ by
 * caller and belong to the caller: the queue handler must never send the same
 * automatic event twice, while a recruiter writing a second message to the
 * same person is doing something entirely legitimate.
 *
 * It also does not THROW on a provider failure — it returns the outcome. The
 * queue handler rethrows so the job retries with backoff; the composer shows
 * the recruiter the real error. A throw here would force both behaviours to be
 * the same one.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Resend's free tier is 100/day. Raising it after an upgrade needs no deploy. */
const DEFAULT_DAILY_CAP = 100;

export function dailyCap(): number {
  const raw = Number.parseInt(process.env.EMAIL_DAILY_CAP ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
}

/**
 * Sender identity.
 *
 * The display name carries the COMPANY so the candidate knows who is writing;
 * the address stays on Remotiv's verified domain because that is the only
 * domain we can authenticate. "Acme Inc (via Remotiv)" is the honest form — it
 * never implies the mail left Acme's own mail server, which would be a
 * deliverability lie and, under DMARC, an undeliverable one.
 *
 * The suffix is dropped when the company IS Remotiv: "Remotiv (via Remotiv)"
 * reads like a bug to the one tenant most likely to notice.
 */
export function senderName(companyName: string): string {
  const clean = companyName.trim().replace(/[\r\n"<>]/g, "");
  if (!clean) return "Remotiv";
  return clean.toLowerCase() === "remotiv" ? "Remotiv" : `${clean} (via Remotiv)`;
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wrap rendered inner HTML in the shared shell plus the per-company footer.
 *
 * Shared so a manual message carries the same unsubscribe link and the same
 * "sent on behalf of" line as an automatic one — a candidate should not be
 * able to tell which of our code paths produced their mail.
 */
export function buildCandidateHtml(
  inner: string,
  companyName: string,
  companyId: string,
  to: string,
): string {
  const unsub = unsubscribeUrl(companyId, to);
  const footer = unsub
    ? `Sent by Remotiv on behalf of ${escapeText(companyName)}. <a href="${unsub}" style="color:#847E8C">Unsubscribe from ${escapeText(companyName)}'s updates</a>.`
    : `Sent by Remotiv on behalf of ${escapeText(companyName)}.`;
  return EMAIL_SHELL(inner, footer);
}

/**
 * Insert one communication_logs row and return its id.
 *
 * Exported because the skip paths (no template, opted out, capped) need to
 * record a decision without sending anything, and those rows must look exactly
 * like the ones this module writes.
 */
export async function writeCommunicationLog(
  service: Service,
  row: {
    companyId: string;
    applicationId: string;
    /**
     * Widened past MessageEvent for the interview reminder, which is logged but
     * has no template. Safe because communication_logs.event carries no CHECK —
     * see LOG_ONLY_EVENTS.
     */
    event: LoggedEvent;
    to: string;
    subject: string;
    /** The rendered email. Stored redacted; see the insert below. */
    body: string;
    status: MessageStatus;
    /** Free-text column. Carries failure text, and on a sent row, a note. */
    error?: string;
    /** Display name of the person who wrote it. Null for automatic mail. */
    sentByName?: string | null;
  },
): Promise<string> {
  const { data, error } = await service
    .from("communication_logs")
    .insert({
      company_id: row.companyId,
      application_id: row.applicationId,
      event: row.event,
      channel: "email",
      to_address: row.to,
      subject: row.subject,
      // Redacted HERE, on the only insert, so no caller can store a live
      // interview or booking link by passing the rendered email straight in.
      body: redactCandidateLinks(row.body),
      status: row.status,
      error: row.error ?? null,
      sent_by_name: row.sentByName ?? null,
      ...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    /*
     * The SQLSTATE travels on the Error, not only inside the message.
     * PostgREST puts the code in `error.code` and the human text in
     * `error.message`, and the two do not overlap — a caller sniffing the
     * message for "23505" finds nothing. tryWriteLog reads `.code`.
     */
    const failure = Object.assign(new Error(`communication_log insert failed: ${error?.message}`), {
      code: error?.code,
    });
    throw failure;
  }
  return (data as { id: string }).id;
}

/** Postgres unique_violation. Raised by communication_logs_application_event_channel_uniq. */
const UNIQUE_VIOLATION = "23505";

/** #16: what the sender is told when the applicant is being deleted. */
const DELETING_MESSAGE = "This applicant is being deleted, so nothing was sent.";
/** #16: the marker could not be read just before sending; nothing was sent. */
const MARKER_UNREAD = "Not sent: could not confirm this applicant is not being deleted.";

/**
 * writeCommunicationLog, without the throw.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * deliverEmail's contract, stated at the top of this file, is that it does NOT
 * throw — it returns the outcome so the queue handler can rethrow for retry
 * while a recruiter-facing caller shows a message. The log insert broke that
 * contract silently: `writeCommunicationLog` throws, deliverEmail never caught
 * it, and the exception went straight past every caller's error handling.
 *
 * It surfaced as "Couldn't send — please try again." in the applicant drawer,
 * which is the least useful thing that could have been said about a
 * `communication_logs_application_event_channel_uniq` violation — a condition
 * with a precise, actionable explanation.
 *
 * The unique violation is separated from every other failure because they mean
 * different things to a caller. A duplicate is a REFUSAL — this exact message
 * has already been sent to this person — and is not retryable. Anything else
 * is an infrastructure failure and might be.
 */
async function tryWriteLog(
  service: Service,
  row: Parameters<typeof writeCommunicationLog>[1],
): Promise<
  | { ok: true; logId: string }
  | { ok: false; duplicate: boolean; deleting: boolean; message: string }
> {
  try {
    return { ok: true, logId: await writeCommunicationLog(service, row) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    /*
     * Primarily the SQLSTATE. The message check is a fallback for a future
     * client that surfaces the code differently — and it is a FALLBACK, not
     * the test: an earlier draft of this function checked only the message,
     * which never matches, so every duplicate would have been misreported as
     * an infrastructure failure and told the recruiter to try again.
     */
    const duplicate = code === UNIQUE_VIOLATION || message.includes(UNIQUE_VIOLATION);
    // 071's guard: a queued row for an applicant being deleted is refused (#16).
    return { ok: false, duplicate, deleting: code === DELETION_IN_PROGRESS, message };
  }
}

export type DeliveryOutcome =
  | { ok: true; logId: string; providerId: string | null }
  | {
      ok: false;
      /**
       * 'cap', 'not_configured' and 'duplicate' are our decisions; 'provider'
       * is Resend's; 'log' is the database refusing to record the attempt.
       *
       * 'duplicate' means this application already has a row for this event and
       * channel — the message has been sent before. It is a refusal, not a
       * fault, and is the ONE kind a caller should phrase rather than retry.
       *
       * 'deleting' (#16): the applicant is being deleted, so nothing is sent,
       * now or later. A refusal too, never retried.
       */
      kind: "cap" | "not_configured" | "provider" | "duplicate" | "log" | "deleting";
      message: string;
      logId: string | null;
    };

/**
 * Count today's sends against the cap.
 *
 * Account-wide, NOT per company: the ceiling belongs to Resend's plan, which
 * every tenant draws from. Scoping it per company would let ten companies send
 * a thousand between them and meet the real limit as an opaque provider error
 * — exactly what counting first is meant to avoid.
 *
 * Only 'sent' rows count. Skipped and cancelled messages never touched the
 * quota.
 */
export async function countSentToday(service: Service): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count } = await service
    .from("communication_logs")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());
  return count ?? 0;
}

/**
 * Send one already-rendered candidate email and record what happened.
 *
 * Order is load-bearing: cap check, then the log row, THEN Resend. The row
 * exists as 'queued' before the provider is called, so a crash mid-send leaves
 * evidence rather than silence — and a row that reads 'sent' can only have
 * been written after Resend accepted the message.
 */
/**
 * The failure bell's input for a row this file has just marked failed. One
 * builder for both failed branches, so they cannot drift apart. The bell is
 * best-effort by construction (alertSendFailure never throws), so the two
 * return values below are exactly what they were before it existed.
 */
function failedSend(
  input: { companyId: string; applicationId: string; event: string; actorMemberId?: string | null },
  logId: string,
): SendFailureInput {
  return {
    logId,
    companyId: input.companyId,
    applicationId: input.applicationId,
    event: input.event,
    channel: "email",
    actorMemberId: input.actorMemberId ?? null,
  };
}

/**
 * The Resend idempotency key of the email a log row records (#59): the same on
 * the first send and on every Retry, so Resend sends a message for this row at
 * most once in 24 hours whoever asks, and refuses a Retry whose message is not
 * byte for byte the first one (invalid_idempotent_request).
 */
export function candidateEmailKey(logId: string): string {
  return `comm-log:${logId}`;
}

/**
 * The request Resend gets, built in ONE place for the first send and the
 * Retry: an idempotency key with a different body is refused, so the two must
 * not be able to drift.
 */
function resendRequest(input: {
  to: string;
  subject: string;
  html: string;
  companyName: string;
  replyTo: string | null;
}) {
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@remotiv.work";
  return {
    from: `${senderName(input.companyName)} <${fromEmail}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    // Omitted entirely when unset — an explicit `replyTo: undefined` is not
    // the same request to Resend as no reply-to header.
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
}

/**
 * The queue's retry of an automatic email whose first attempt FAILED (#56,
 * QA #40 M-3).
 *
 * The retry used to insert into the same unique key (application, event,
 * channel), get `duplicate`, and complete: one transient Resend error and the
 * candidate never got the message, while the job reported success. Now the
 * failed row itself is retried, through resendFailedEmail, the #59 path:
 *   - claimed first (claim_failed_email_log, 067): only a 'failed' row from
 *     the last 24 hours, one claimer at a time; a row left 'queued' by a send
 *     that never answered is never retried, since its email may have arrived;
 *   - sent with the FIRST attempt's idempotency key (candidateEmailKey of the
 *     same row), and with the message the sender rebuilds from the same job
 *     payload and the same facts, so it is the same request. A first attempt
 *     that did reach Resend is answered from Resend's own record and is not
 *     delivered again; a message that changed meanwhile is refused by Resend
 *     and not sent (`mismatch`).
 * Never twice. Returns null when there is no failed row to retry (it was sent,
 * is still queued, or is too old): the caller's `duplicate` stands.
 */
async function retryFailedAutomatic(
  service: Service,
  input: {
    companyId: string;
    applicationId: string;
    event: LoggedEvent;
    to: string;
    subject: string;
    html: string;
    companyName: string;
    replyTo: string | null;
  },
): Promise<DeliveryOutcome | null> {
  const { data: failedRow, error } = await service
    .from("communication_logs")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("application_id", input.applicationId)
    .eq("event", input.event)
    .eq("channel", "email")
    .is("sent_by_name", null)
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // The retry cannot see the row: refuse like a fault, so the queue tries again.
    return {
      ok: false,
      kind: "log",
      message: "The earlier attempt couldn't be read, so it wasn't retried.",
      logId: null,
    };
  }
  const logId = (failedRow as { id: string } | null)?.id;
  if (!logId) return null;

  const outcome = await resendFailedEmail(service, {
    logId,
    companyId: input.companyId,
    to: input.to,
    subject: input.subject,
    html: input.html,
    companyName: input.companyName,
    replyTo: input.replyTo,
  });
  switch (outcome.kind) {
    case "sent":
      return { ok: true, logId, providerId: null };
    case "not_retried":
      return null;
    case "deleting":
      return { ok: false, kind: "deleting", message: DELETING_MESSAGE, logId };
    case "mismatch":
      return {
        ok: false,
        kind: "duplicate",
        message: "Not sent again: this message no longer matches the first one.",
        logId,
      };
    case "failed":
      return { ok: false, kind: "provider", message: outcome.message, logId };
    case "not_configured":
      return {
        ok: false,
        kind: "not_configured",
        message: "Email isn't configured on this environment.",
        logId,
      };
    case "cap":
      return {
        ok: false,
        kind: "cap",
        message: "Remotiv's daily email limit has been reached. This message hasn't been sent.",
        logId,
      };
  }
}

export async function deliverEmail(
  service: Service,
  input: {
    companyId: string;
    applicationId: string;
    event: LoggedEvent;
    to: string;
    /** Plain text. */
    subject: string;
    /**
     * Full document, already through buildCandidateHtml. Sent as is; the copy
     * kept in communication_logs has its interview and booking tokens removed
     * (redactCandidateLinks) so the log cannot be used to open either link.
     */
    html: string;
    companyName: string;
    /** Omitted from the message entirely when null — never defaulted. */
    replyTo: string | null;
    /** Recorded alongside a cap/opt-out decision, never sent to the candidate. */
    note?: string;
    /** Author of a manual message. Automatic mail leaves this null. */
    sentByName?: string | null;
    /**
     * The member whose action this send is, for the failure bell (#71A): they
     * saw the error on screen, so they are left out of the fan-out. Automatic
     * mail and callers that cannot name one leave it null.
     */
    actorMemberId?: string | null;
  },
): Promise<DeliveryOutcome> {
  const cap = dailyCap();
  const sentToday = await countSentToday(service);
  if (sentToday >= cap) {
    console.error(
      `[email] DAILY CAP REACHED — ${sentToday}/${cap} sent today. ` +
        `Not sending ${input.event} for application ${input.applicationId}. ` +
        `Raise EMAIL_DAILY_CAP after upgrading the Resend plan.`,
    );
    const capped = await tryWriteLog(service, {
      companyId: input.companyId,
      applicationId: input.applicationId,
      event: input.event,
      to: input.to,
      subject: input.subject,
      body: input.html,
      status: "skipped",
      error: `Daily send cap of ${cap} reached.`,
      sentByName: input.sentByName ?? null,
    });
    // Failing to RECORD the cap decision does not change the decision: nothing
    // is being sent either way, and 'cap' is still the honest reason.
    const logId = capped.ok ? capped.logId : null;
    return {
      ok: false,
      kind: "cap",
      message: `Remotiv's daily email limit of ${cap} has been reached. This message hasn't been sent - try again tomorrow.`,
      logId,
    };
  }

  /*
   * The log row is written BEFORE the provider is called, so a crash mid-send
   * leaves evidence. That ordering also makes this the first thing that can
   * refuse — and it must refuse by RETURNING, never by throwing.
   */
  const written = await tryWriteLog(service, {
    companyId: input.companyId,
    applicationId: input.applicationId,
    event: input.event,
    to: input.to,
    subject: input.subject,
    body: input.html,
    status: "queued",
    error: input.note,
    sentByName: input.sentByName ?? null,
  });

  if (!written.ok) {
    if (written.deleting) {
      return { ok: false, kind: "deleting", message: DELETING_MESSAGE, logId: null };
    }
    if (written.duplicate) {
      // An automatic message whose earlier attempt FAILED is retried on that
      // same row (#56 M-3); see retryFailedAutomatic.
      const retried = input.sentByName ? null : await retryFailedAutomatic(service, input);
      if (retried) return retried;
      /*
       * This application already has a row for this event and channel. Nothing
       * is sent, deliberately: the constraint exists so one candidate cannot
       * receive the same pipeline message twice, and sending anyway with no log
       * would defeat the constraint AND lose the audit trail.
       */
      return {
        ok: false,
        kind: "duplicate",
        message: "This candidate has already been sent this message.",
        logId: null,
      };
    }
    console.error("[email] communication_log insert failed:", written.message);
    return {
      ok: false,
      kind: "log",
      message: "The message couldn't be recorded, so it wasn't sent.",
      logId: null,
    };
  }

  const logId = written.logId;
  const client = getResend();
  if (!client) {
    // The row back (.select), so the bell rings only for a mark that landed.
    const { data: marked } = await service
      .from("communication_logs")
      .update({ status: "failed", error: "RESEND_API_KEY not configured." })
      .eq("id", logId)
      .select("id");
    if (updatedOne(marked)) await alertSendFailure(service, failedSend(input, logId));
    return {
      ok: false,
      kind: "not_configured",
      message: "Email isn't configured on this environment.",
      logId,
    };
  }

  // #16: the applicant's delete may have started since this row was written
  // (a claim made before the Close, sent after it). Read the marker now,
  // immediately before the provider call. An email Resend has already
  // accepted cannot be recalled; this is the last point anything can stop it.
  const marker = await deletionStartedFor(service, {
    applicationId: input.applicationId,
    companyId: input.companyId,
  });
  if (marker !== "clear") {
    await service
      .from("communication_logs")
      .update({
        status: marker === "deleting" ? "skipped" : "failed",
        error: marker === "deleting" ? NOT_SENT_DELETING : MARKER_UNREAD,
      })
      .eq("id", logId)
      .eq("company_id", input.companyId)
      .eq("status", "queued");
    return marker === "deleting"
      ? { ok: false, kind: "deleting", message: DELETING_MESSAGE, logId }
      : { ok: false, kind: "log", message: MARKER_UNREAD, logId };
  }

  const { data: sent, error } = await client.emails.send(resendRequest(input), {
    idempotencyKey: candidateEmailKey(logId),
  });

  if (error) {
    // The row back (.select), so the bell rings only for a mark that landed.
    const { data: marked } = await service
      .from("communication_logs")
      .update({ status: "failed", error: error.message ?? "Resend error" })
      .eq("id", logId)
      .select("id");
    if (updatedOne(marked)) await alertSendFailure(service, failedSend(input, logId));
    return {
      ok: false,
      kind: "provider",
      message: error.message ?? "The email provider rejected the message.",
      logId,
    };
  }

  await service
    .from("communication_logs")
    .update({
      status: "sent",
      provider_id: sent?.id ?? null,
      sent_at: new Date().toISOString(),
      // A note survives; a stale failure from a previous attempt must not.
      error: input.note ?? null,
    })
    .eq("id", logId);

  return { ok: true, logId, providerId: sent?.id ?? null };
}

export type ResendOutcome =
  | { kind: "sent" }
  /** The claim refused (claim_failed_email_log, migration 067): nothing sent. */
  | { kind: "not_retried"; reason: "wrong_status" | "too_old" | "missing" }
  /** #16: the applicant is being deleted; refused at the claim or just before the send. */
  | { kind: "deleting" }
  /** Resend refused the key: this message is not the first one, so it was not sent again. */
  | { kind: "mismatch" }
  | { kind: "failed"; message: string }
  | { kind: "not_configured" }
  | { kind: "cap" };

/** Resend's answers to a reused key whose request differs, or is still in flight. */
const IDEMPOTENCY_REFUSALS = new Set([
  "invalid_idempotent_request",
  "concurrent_idempotent_requests",
]);

/**
 * Retry ONE failed candidate email (#59): the cancellation notice's Retry.
 *
 * Never sends twice:
 *   1. the row is CLAIMED by id first (claim_failed_email_log, migration 067):
 *      only a 'failed' row from the last 24 hours, one claimer at a time, by
 *      the database's clock. A row left 'queued' by a send that never answered
 *      is never retried (its email may have arrived);
 *   2. the send carries the FIRST send's idempotency key, and the caller
 *      rebuilds the message with the same builder from the same facts, so a
 *      first send that did reach Resend is answered from Resend's record, not
 *      sent again; a message that changed meanwhile is refused (mismatch);
 *   3. the sent / failed write is guarded on the claim's own stamp, so a
 *      stale Retry can never overwrite a newer outcome.
 */
export async function resendFailedEmail(
  service: Service,
  input: {
    logId: string;
    companyId: string;
    to: string;
    subject: string;
    html: string;
    companyName: string;
    replyTo: string | null;
  },
): Promise<ResendOutcome> {
  const client = getResend();
  if (!client) return { kind: "not_configured" };
  if ((await countSentToday(service)) >= dailyCap()) return { kind: "cap" };

  const { data, error: claimError } = await service.rpc("claim_failed_email_log", {
    p_id: input.logId,
    p_company_id: input.companyId,
  });
  if (claimError?.code === DELETION_IN_PROGRESS) return { kind: "deleting" };
  if (claimError) return { kind: "failed", message: "The email could not be claimed." };
  const row = (Array.isArray(data) ? data[0] : data) as {
    out_outcome?: string;
    out_attempt_started_at?: string | null;
  } | null;
  const outcome = row?.out_outcome;
  if (outcome !== "claimed" || !row?.out_attempt_started_at) {
    const reason = outcome === "too_old" || outcome === "missing" ? outcome : "wrong_status";
    return { kind: "not_retried", reason };
  }
  const stamp = row.out_attempt_started_at;

  // #16: immediately before the provider call, as in deliverEmail. The row's
  // own applicant, read on this company; a row with none was orphaned by a
  // finished delete.
  const { data: logRow } = await service
    .from("communication_logs")
    .select("application_id")
    .eq("id", input.logId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  const appId = (logRow as { application_id: string | null } | null)?.application_id ?? null;
  const marker = appId
    ? await deletionStartedFor(service, { applicationId: appId, companyId: input.companyId })
    : "deleting";
  if (marker !== "clear") {
    await service
      .from("communication_logs")
      .update({
        status: marker === "deleting" ? "skipped" : "failed",
        error: marker === "deleting" ? NOT_SENT_DELETING : MARKER_UNREAD,
      })
      .eq("id", input.logId)
      .eq("company_id", input.companyId)
      .eq("attempt_started_at", stamp);
    return marker === "deleting"
      ? { kind: "deleting" }
      : { kind: "failed", message: MARKER_UNREAD };
  }

  const { data: sent, error } = await client.emails.send(resendRequest(input), {
    idempotencyKey: candidateEmailKey(input.logId),
  });
  // Both writes are guarded on THIS claim's stamp: a Retry that lost its claim
  // can never overwrite a newer outcome.
  if (error) {
    const mismatch = IDEMPOTENCY_REFUSALS.has(error.name);
    await service
      .from("communication_logs")
      .update({
        status: "failed",
        error: mismatch
          ? "Not sent again: this message no longer matches the first one."
          : (error.message ?? "Resend error"),
      })
      .eq("id", input.logId)
      .eq("company_id", input.companyId)
      .eq("attempt_started_at", stamp);
    return mismatch
      ? { kind: "mismatch" }
      : { kind: "failed", message: error.message ?? "Resend error" };
  }
  await service
    .from("communication_logs")
    .update({
      status: "sent",
      provider_id: sent?.id ?? null,
      sent_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", input.logId)
    .eq("company_id", input.companyId)
    .eq("attempt_started_at", stamp);
  return { kind: "sent" };
}
