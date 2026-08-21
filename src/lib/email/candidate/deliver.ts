import "server-only";
import { Resend } from "resend";
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
      body: row.body,
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
): Promise<{ ok: true; logId: string } | { ok: false; duplicate: boolean; message: string }> {
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
    return { ok: false, duplicate, message };
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
       */
      kind: "cap" | "not_configured" | "provider" | "duplicate" | "log";
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
export async function deliverEmail(
  service: Service,
  input: {
    companyId: string;
    applicationId: string;
    event: LoggedEvent;
    to: string;
    /** Plain text. */
    subject: string;
    /** Full document, already through buildCandidateHtml. */
    html: string;
    companyName: string;
    /** Omitted from the message entirely when null — never defaulted. */
    replyTo: string | null;
    /** Recorded alongside a cap/opt-out decision, never sent to the candidate. */
    note?: string;
    /** Author of a manual message. Automatic mail leaves this null. */
    sentByName?: string | null;
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
      message: `Remotiv's daily email limit of ${cap} has been reached. This message hasn't been sent — try again tomorrow.`,
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
    if (written.duplicate) {
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
    await service
      .from("communication_logs")
      .update({ status: "failed", error: "RESEND_API_KEY not configured." })
      .eq("id", logId);
    return {
      ok: false,
      kind: "not_configured",
      message: "Email isn't configured on this environment.",
      logId,
    };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@remotiv.work";

  const { data: sent, error } = await client.emails.send({
    from: `${senderName(input.companyName)} <${fromEmail}>`,
    to: input.to,
    subject: input.subject,
    html: input.html,
    // Omitted entirely when unset — an explicit `replyTo: undefined` is not
    // the same request to Resend as no reply-to header.
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  });

  if (error) {
    await service
      .from("communication_logs")
      .update({ status: "failed", error: error.message ?? "Resend error" })
      .eq("id", logId);
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
