import "server-only";
import { Resend } from "resend";
import { createServiceClient } from "@/lib/supabase/server";
import { defaultTemplate, EMAIL_SHELL } from "./templates";
import {
  buildPlaceholders,
  escapePlaceholders,
  renderTemplate,
} from "./render";
import type { MessageEvent, SendMessagePayload } from "./types";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * The send_message handler.
 *
 * Everything a candidate ever receives goes through here, so this file owns
 * idempotency, opt-outs, the daily cap and the audit row. It is called ONLY by
 * the background worker — never inline from a request, because a Resend outage
 * must not fail an application or a stage change.
 */

/** Resend's free tier is 100/day. Raising it after an upgrade needs no deploy. */
const DEFAULT_DAILY_CAP = 100;
function dailyCap(): number {
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
 * deliverability lie and, with DMARC, an undeliverable one.
 *
 * Reply-to is the company's contact email, so a candidate hitting Reply reaches
 * a human at the company rather than a Remotiv no-reply mailbox.
 */
function senderName(companyName: string): string {
  const clean = companyName.trim().replace(/[\r\n"<>]/g, "");
  return clean ? `${clean} (via Remotiv)` : "Remotiv";
}

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

type ApplicationRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  company_id_snapshot: string | null;
  pipeline_stage: string | null;
};

/** Terminal-ish log statuses: a row in one of these means "already handled". */
const ALREADY_HANDLED = ["queued", "sent", "skipped", "cancelled"];

export async function handleSendMessage(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as SendMessagePayload;
  const applicationId = payload?.applicationId;
  const event = payload?.event as MessageEvent | undefined;

  if (typeof applicationId !== "string" || !applicationId || !event) {
    throw new Error(`send_message: payload malformed (job ${job.id})`);
  }

  const service = createServiceClient();

  // ── 1. Idempotency ────────────────────────────────────────
  //
  // The FIRST thing, before any work. A log row for this (application, event)
  // means a previous attempt already got far enough to claim it, so this
  // attempt returns without sending. That covers the common case exactly: the
  // queue guarantees one worker per job row, so a retry of the same job always
  // finds the row its own earlier attempt wrote.
  //
  // 'failed' is deliberately NOT in the set — a genuine send failure SHOULD be
  // retried, and its row is updated in place rather than duplicated.
  const { data: existing } = await service
    .from("communication_logs")
    .select("id, status")
    .eq("application_id", applicationId)
    .eq("event", event)
    .in("status", ALREADY_HANDLED)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; status: string };
    // A cancelled rejection is the whole point of the 2-day window: the
    // candidate was moved off Rejected, so this job must expire quietly.
    console.log(
      `[send_message] skipping ${event} for ${applicationId} — already ${row.status}`,
    );
    return;
  }

  // ── 2. Load the application, job and company ──────────────
  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_id, job_title_snapshot, company_id_snapshot, pipeline_stage",
    )
    .eq("id", applicationId)
    .maybeSingle();

  const app = appData as ApplicationRow | null;
  if (!app) throw new Error(`send_message: application ${applicationId} not found`);

  const companyId = app.company_id_snapshot;
  if (!companyId) {
    // Remotiv-owned application. Candidate messaging is a company-product
    // feature; there is no company whose name could carry the content.
    console.log(`[send_message] skipping ${event} for ${applicationId} — no company`);
    return;
  }

  const [{ data: companyData }, { data: jobData }] = await Promise.all([
    service
      .from("companies")
      .select("id, name, candidate_reply_email")
      .eq("id", companyId)
      .maybeSingle(),
    app.job_id
      ? service.from("jobs").select("title").eq("id", app.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;
  if (!company) throw new Error(`send_message: company ${companyId} not found`);

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) {
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      to: "",
      subject: "",
      body: "",
      status: "skipped",
      error: "Application has no email address.",
    });
    return;
  }

  // ── 3. Opt-out ────────────────────────────────────────────
  //
  // Scoped per company: opting out of one company's updates must not silence
  // another's, because they are unrelated hiring processes the candidate chose
  // to enter separately.
  const { data: optOut } = await service
    .from("communication_opt_outs")
    .select("id, reason")
    .eq("company_id", companyId)
    .eq("email", to)
    .maybeSingle();

  if (optOut) {
    const reason = (optOut as { reason: string | null }).reason;
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      to,
      subject: "",
      body: "",
      status: "skipped",
      error: `Recipient opted out${reason ? `: ${reason}` : ""}.`,
    });
    return;
  }

  // ── 4. Resolve the template ───────────────────────────────
  const companyName = (company.name ?? "").trim();
  const jobTitle =
    ((jobData as { title: string | null } | null)?.title ?? "").trim() ||
    (app.job_title_snapshot ?? "").trim();

  const resolved = await resolveTemplate(service, companyId, event, payload);
  if (!resolved) {
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      to,
      subject: "",
      body: "",
      status: "skipped",
      error: `No template for event '${event}'.`,
    });
    return;
  }

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });
  // Subject is plain text; body is HTML, so its values are escaped.
  const subject = renderTemplate(resolved.subject, values);
  const inner = renderTemplate(resolved.body, escapePlaceholders(values));

  const unsub = unsubscribeUrl(companyId, to);
  const footer = unsub
    ? `Sent by Remotiv on behalf of ${escapeText(companyName)}. <a href="${unsub}" style="color:#847E8C">Unsubscribe from ${escapeText(companyName)}'s updates</a>.`
    : `Sent by Remotiv on behalf of ${escapeText(companyName)}.`;
  const html = EMAIL_SHELL(inner, footer);

  // ── 5. Daily cap ──────────────────────────────────────────
  //
  // Counted BEFORE the attempt, so we choose not to send rather than
  // discovering the ceiling as an opaque provider error. Only 'sent' rows
  // count: skipped and cancelled messages never touched Resend's quota.
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: sentToday } = await service
    .from("communication_logs")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());

  const cap = dailyCap();
  if ((sentToday ?? 0) >= cap) {
    console.error(
      `[send_message] DAILY CAP REACHED — ${sentToday}/${cap} sent today. ` +
        `Skipping ${event} for application ${applicationId}. ` +
        `Raise EMAIL_DAILY_CAP after upgrading the Resend plan.`,
    );
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      to,
      subject,
      body: html,
      status: "skipped",
      error: `Daily send cap of ${cap} reached.`,
    });
    return;
  }

  // ── 6. Log BEFORE the attempt, then send ──────────────────
  //
  // The row exists as 'queued' before Resend is called, so a crash between the
  // call and the status update leaves evidence rather than silence — and a row
  // that says 'sent' can only have been written after Resend accepted it.
  const logId = await writeLog(service, {
    companyId,
    applicationId,
    event,
    to,
    subject,
    body: html,
    status: "queued",
  });

  const client = getResend();
  if (!client) {
    await service
      .from("communication_logs")
      .update({ status: "failed", error: "RESEND_API_KEY not configured." })
      .eq("id", logId);
    throw new Error("send_message: RESEND_API_KEY not configured");
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "noreply@remotiv.work";

  // The ONLY source of a reply-to on a candidate email.
  //
  // NOT contact_email: that address is the owner's login and admin contact, and
  // putting it here publishes one person's inbox to every applicant with no way
  // to opt out.
  //
  // And no Remotiv fallback. Blank means the company chose not to take replies,
  // so the message goes out with no reply-to at all and a reply lands on the
  // noreply from-address and nowhere else. Routing those to talent@remotiv.work
  // would quietly make Remotiv the inbox for every company's candidates.
  const replyTo = (company.candidate_reply_email ?? "").trim() || undefined;

  const { data: sent, error } = await client.emails.send({
    from: `${senderName(companyName)} <${fromEmail}>`,
    to,
    subject,
    html,
    // Omitted entirely when unset — an explicit `replyTo: undefined` is not the
    // same request to Resend as no reply-to header.
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    await service
      .from("communication_logs")
      .update({ status: "failed", error: error.message ?? "Resend error" })
      .eq("id", logId);
    // Rethrown so the queue applies backoff and retries. The log row is
    // 'failed', which is excluded from the idempotency set, so a retry
    // legitimately tries again and updates this same row.
    throw new Error(`send_message: Resend rejected the message: ${error.message}`);
  }

  await service
    .from("communication_logs")
    .update({
      status: "sent",
      provider_id: sent?.id ?? null,
      sent_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", logId);
}

// ── Helpers ──────────────────────────────────────────────────

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The company's own template for this event, else Remotiv's default.
 *
 * Company templates are matched on company_id so one tenant's wording can never
 * be served to another's candidate.
 */
async function resolveTemplate(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  event: MessageEvent,
  payload: SendMessagePayload,
): Promise<{ subject: string; body: string } | null> {
  if (payload.subjectOverride || payload.bodyOverride) {
    return {
      subject: payload.subjectOverride ?? "",
      body: payload.bodyOverride ?? "",
    };
  }

  const { data } = await service
    .from("message_templates")
    .select("subject, body")
    .eq("company_id", companyId)
    .eq("event", event)
    .eq("channel", "email")
    .maybeSingle();

  const own = data as { subject: string | null; body: string | null } | null;
  if (own?.subject && own?.body) {
    return { subject: own.subject, body: own.body };
  }
  return defaultTemplate(event);
}

async function writeLog(
  service: ReturnType<typeof createServiceClient>,
  row: {
    companyId: string;
    applicationId: string;
    event: MessageEvent;
    to: string;
    subject: string;
    body: string;
    status: "queued" | "sent" | "failed" | "skipped" | "cancelled";
    error?: string;
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
      ...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`send_message: could not write communication_log: ${error?.message}`);
  }
  return (data as { id: string }).id;
}
