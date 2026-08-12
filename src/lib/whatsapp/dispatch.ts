import "server-only";
import { skipJob } from "@/lib/job-skip";
import { createServiceClient } from "@/lib/supabase/server";
import {
  resolveRecipient,
  sendTemplateMessage,
  WHATSAPP_TEMPLATES,
  type WhatsAppTemplateName,
} from "@/lib/whatsapp/send";

/**
 * The WhatsApp half of the `send_message` job.
 *
 * ── Which events reach here, and which never will ────────────
 *
 * Only `interview` and `interview_reminder`. Application-received and
 * rejection stay email-only, deliberately: a candidate rejected twice — once
 * per channel — reads as carelessness rather than thoroughness, and WhatsApp
 * is a far more intrusive place to receive that particular message. The map
 * below is the only switch; an event absent from it never sends, and no other
 * file needs to know which events are live.
 *
 * ── Mirrors the email path, deliberately ─────────────────────
 *
 * Same queue, same job type, same log-before-send discipline, same idempotency
 * shape. The one thing that differs is the channel column — and that is now
 * load-bearing on BOTH sides, because two channels writing a row for the same
 * (application, event) is exactly what would break an idempotency check that
 * did not filter on it.
 */

/** The only events that go out on WhatsApp, mapped to their Meta template. */
const EVENT_TEMPLATES: Record<string, WhatsAppTemplateName> = {
  interview: WHATSAPP_TEMPLATES.interview_invitation,
  interview_reminder: WHATSAPP_TEMPLATES.interview_reminder,
};

/** A log row in one of these means a previous attempt already claimed it. */
const ALREADY_HANDLED = ["queued", "sent", "skipped", "cancelled"];

/** Roughly how long an interview takes, for template variable {{4}}. */
const DEFAULT_MINUTES = "12";

type ApplicationRow = {
  id: string;
  first_name: string | null;
  phone: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  company_id_snapshot: string | null;
};

export type WhatsAppSendPayload = {
  applicationId: string;
  event: string;
  channel: "whatsapp";
  /** Rendered by the caller, which knows the real deadline. */
  deadline?: string;
  minutes?: string;
};

export async function handleWhatsAppMessage(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as WhatsAppSendPayload;
  const applicationId = payload?.applicationId;
  const event = payload?.event;

  if (typeof applicationId !== "string" || !applicationId || !event) {
    throw new Error(`send_message[whatsapp]: payload malformed (job ${job.id})`);
  }

  const template = EVENT_TEMPLATES[event];
  if (!template) {
    // Not an error — a deliberate product decision. See the module comment.
    skipJob("send_message[whatsapp]", job.id, `event "${event}" is email-only`);
    return;
  }

  const service = createServiceClient();

  /*
   * ── 1. Idempotency, before any work ──
   *
   * Identical to the email path's check with ONE addition: `channel`. Without
   * it, this query would find the email row for the same (application, event)
   * and skip every WhatsApp send — and the email path's own check would find
   * two rows and, because `.maybeSingle()` returns null on multiplicity, send
   * a SECOND email. The channel filter is what keeps the two independent.
   */
  const { data: existing } = await service
    .from("communication_logs")
    .select("id, status")
    .eq("application_id", applicationId)
    .eq("event", event)
    .eq("channel", "whatsapp")
    .in("status", ALREADY_HANDLED)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; status: string };
    console.log(
      `[whatsapp] skipping ${event} for ${applicationId} — already ${row.status}`,
    );
    return;
  }

  // ── 2. The application ──
  const { data: appData } = await service
    .from("job_applications")
    .select("id, first_name, phone, job_id, job_title_snapshot, company_id_snapshot")
    .eq("id", applicationId)
    .maybeSingle();

  const app = appData as ApplicationRow | null;
  if (!app) {
    skipJob("send_message[whatsapp]", job.id, `application ${applicationId} no longer exists`);
    return;
  }

  const companyId = app.company_id_snapshot;
  if (!companyId) {
    skipJob("send_message[whatsapp]", job.id, `application ${applicationId} has no company`);
    return;
  }

  // ── 3. Can this number be addressed at all? ──
  const recipient = resolveRecipient(app.phone);
  if (!recipient.ok) {
    /*
     * A local decision, made before spending a message. Recorded as a skipped
     * log row rather than dropped, so the Messages page can show WHY this
     * candidate got an email but no WhatsApp — silence there would look like
     * the integration was broken.
     */
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      toAddress: "unknown",
      status: "skipped",
      error: recipient.reason,
    });
    return;
  }

  // ── 4. Opt-out. Global: that phone never hears from us again. ──
  const { data: optOut } = await service
    .from("whatsapp_opt_outs")
    .select("id")
    .eq("phone", recipient.digits)
    .maybeSingle();

  if (optOut) {
    await writeLog(service, {
      companyId,
      applicationId,
      event,
      toAddress: recipient.digits,
      status: "skipped",
      error: "Recipient has opted out of WhatsApp messages.",
    });
    return;
  }

  // ── 5. Company and job, for the template variables ──
  const [{ data: companyData }, { data: jobData }] = await Promise.all([
    service.from("companies").select("name").eq("id", companyId).maybeSingle(),
    app.job_id
      ? service.from("jobs").select("title").eq("id", app.job_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const companyName =
    ((companyData as { name: string | null } | null)?.name ?? "").trim() || "the company";
  const jobTitle =
    ((jobData as { title: string | null } | null)?.title ?? "").trim() ||
    (app.job_title_snapshot ?? "").trim() ||
    "the role";

  const vars = {
    candidateName: (app.first_name ?? "").trim() || "there",
    companyName,
    jobTitle,
    minutes: payload.minutes ?? DEFAULT_MINUTES,
    deadline: payload.deadline ?? "the date in your email",
  };

  /*
   * ── 6. Log BEFORE the attempt ──
   *
   * Same discipline as deliverEmail. A row that exists before the network call
   * means a crash mid-send leaves evidence rather than silence, and it is what
   * the idempotency check above will find on a retry.
   */
  const logId = await writeLog(service, {
    companyId,
    applicationId,
    event,
    toAddress: recipient.digits,
    status: "queued",
    // The rendered variables, not the template text — Meta owns the wording,
    // and storing our guess at it would go stale the moment it is edited.
    body: `${template}: ${JSON.stringify(vars)}`,
  });

  // ── 7. Send ──
  const result = await sendTemplateMessage({
    toDigits: recipient.digits,
    template,
    vars,
  });

  if (result.ok) {
    await service
      .from("communication_logs")
      .update({
        status: "sent",
        provider_message_id: result.messageId,
        sent_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", logId);
    return;
  }

  await service
    .from("communication_logs")
    .update({ status: "failed", error: result.message.slice(0, 500) })
    .eq("id", logId);

  /*
   * ── Terminal vs transient ──
   *
   * A template that is not approved fails identically every time, so throwing
   * would burn three attempts and an hour of backoff to reach the conclusion
   * already available on the first. It is logged loudly and the job ENDS.
   *
   * A 429 or a 5xx is worth another go, so that one throws and takes the
   * queue's normal retry path.
   */
  if (result.kind === "transient") {
    throw new Error(`send_message[whatsapp]: ${result.message}`);
  }

  console.error(
    `[whatsapp] ${result.kind} failure for ${event}/${applicationId} — not retrying: ${result.message}`,
  );
}

async function writeLog(
  service: ReturnType<typeof createServiceClient>,
  row: {
    companyId: string;
    applicationId: string;
    event: string;
    toAddress: string;
    status: string;
    body?: string;
    error?: string;
  },
): Promise<string> {
  const { data, error } = await service
    .from("communication_logs")
    .insert({
      company_id: row.companyId,
      application_id: row.applicationId,
      event: row.event,
      channel: "whatsapp",
      to_address: row.toAddress,
      subject: null,
      body: row.body ?? null,
      status: row.status,
      error: row.error ?? null,
      ...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`whatsapp: could not write communication_log: ${error?.message}`);
  }
  return (data as { id: string }).id;
}
