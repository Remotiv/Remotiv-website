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

/**
 * A log row in one of these means a previous attempt already claimed it.
 *
 * `queued` is in here on purpose and must stay. The row is written BEFORE the
 * Meta call precisely so a crash leaves evidence, and dropping `queued` from
 * this list would make a job that died after Meta accepted the message send a
 * SECOND one on retry — a real charge and a duplicate to the candidate. It is
 * age-bounded below instead.
 */
const ALREADY_HANDLED = ["queued", "sent", "skipped", "cancelled"];

/**
 * How long a `queued` row is believed to mean "a send is in flight".
 *
 * Beyond it, the process that wrote the row is gone: the only work between the
 * insert and the status update is one Meta call inside a worker tick that
 * allows ~25s total. Fifteen minutes is two orders of magnitude of headroom and
 * still nothing like the "forever" this replaces.
 */
const QUEUED_STALE_MS = 15 * 60 * 1000;

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
  /**
   * The recruiter who asked for this send, or absent for an automatic one.
   *
   * This is the ONLY thing that tells the two apart down here — both enqueue
   * sites were otherwise identical — and it is the same value the email path
   * writes to `communication_logs.sent_by_name`, so the row this job produces
   * lands on the correct side of the partial unique index.
   */
  sentByName?: string | null;
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
   * A recruiter's explicit re-send, as opposed to an automatic one.
   *
   * The partial unique index on (application_id, event, channel) WHERE
   * sent_by_name IS NULL already encodes this rule: automatic rows are unique
   * per event, a named one is not. The check below used to ignore the
   * distinction entirely and refuse both, which is why the index change never
   * took effect on this channel — the code in front of it was stricter.
   */
  const sentByName = (payload.sentByName ?? "").trim() || null;

  /*
   * ── 1. Idempotency, before any work ──
   *
   * Identical to the email path's check with ONE addition: `channel`. Without
   * it, this query would find the email row for the same (application, event)
   * and skip every WhatsApp send — and the email path's own check would find
   * two rows and, because `.maybeSingle()` returns null on multiplicity, send
   * a SECOND email. The channel filter is what keeps the two independent.
   *
   * Skipped ENTIRELY for a recruiter's send: they can see the previous message
   * on the Messages page and asked for another one anyway. Only automatic
   * sends are deduplicated, which is exactly what the index says.
   */
  let reuseLogId: string | null = null;

  if (!sentByName) {
    const { data: existing } = await service
      .from("communication_logs")
      .select("id, status, created_at")
      .eq("application_id", applicationId)
      .eq("event", event)
      .eq("channel", "whatsapp")
      .is("sent_by_name", null)
      .in("status", ALREADY_HANDLED)
      .maybeSingle();

    if (existing) {
      const row = existing as { id: string; status: string; created_at: string | null };
      const age = row.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
      const staleQueued = row.status === "queued" && age > QUEUED_STALE_MS;

      if (!staleQueued) {
        /*
         * Recorded, not merely logged.
         *
         * This was the one skip in this file that returned in silence, and it
         * is the one that fired — so the Messages page showed an email with no
         * WhatsApp beside it and no reason, which is precisely the "looks
         * broken" the other two skips were written to avoid.
         *
         * Written against the EXISTING row rather than inserted as a new one:
         * a second automatic row would collide with the partial index, and the
         * point here is a visible reason, not a second record of one send.
         */
        await service
          .from("communication_logs")
          .update({
            error:
              `Not re-sent automatically — this event was already ${row.status} ` +
              `on this application. A recruiter can send it again from the applicant.`,
          })
          .eq("id", row.id);

        console.log(
          `[whatsapp] skipping ${event} for ${applicationId} — already ${row.status}`,
        );
        return;
      }

      /*
       * A stale `queued` row: the process that wrote it died between the insert
       * and the status update. Adopt it rather than insert — it still occupies
       * the partial index's slot (the index does not filter on status), so a
       * fresh automatic insert would collide with it. Re-using the row also
       * keeps one record per automatic send, which is what the index is for.
       */
      console.warn(
        `[whatsapp] adopting stale queued row ${row.id} for ${event}/${applicationId} ` +
          `(${Math.round(age / 60000)}m old) — a previous attempt died mid-send`,
      );
      reuseLogId = row.id;
    }
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
      sentByName,
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
      sentByName,
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
  // The rendered variables, not the template text — Meta owns the wording, and
  // storing our guess at it would go stale the moment it is edited.
  const body = `${template}: ${JSON.stringify(vars)}`;

  let logId: string;
  if (reuseLogId) {
    // Adopted stale row: put it back to `queued` and clear the previous
    // attempt's error, so the Messages page shows this attempt, not the dead one.
    await service
      .from("communication_logs")
      .update({ status: "queued", body, error: null, to_address: recipient.digits })
      .eq("id", reuseLogId);
    logId = reuseLogId;
  } else {
    logId = await writeLog(service, {
      companyId,
      applicationId,
      event,
      toAddress: recipient.digits,
      status: "queued",
      body,
      sentByName,
    });
  }

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

/**
 * Postgres unique-violation. The partial index on (application_id, event,
 * channel) WHERE sent_by_name IS NULL is the only one this table can trip.
 */
const UNIQUE_VIOLATION = "23505";

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
    /**
     * Null for an automatic send, which is what puts the row INSIDE the partial
     * unique index. The email path writes the same column from the same value
     * (deliver.ts); until now this one never wrote it at all, so every WhatsApp
     * row was null and the index could not tell a recruiter's send from a
     * scheduled one.
     */
    sentByName?: string | null;
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
      sent_by_name: row.sentByName ?? null,
      ...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    /*
     * A unique violation here means the index disagrees with the reasoning
     * above — most likely its definition differs from the one this file was
     * written against, which lives only in the database and not in any
     * migration. Named explicitly so it is not mistaken for a transient fault,
     * and thrown rather than swallowed: silently dropping a send is the class
     * of bug this whole change exists to remove.
     */
    if (error?.code === UNIQUE_VIOLATION) {
      throw new Error(
        `whatsapp: communication_logs rejected a ${row.sentByName ? "recruiter" : "automatic"} ` +
          `${row.event} row as a duplicate. Check the partial unique index on ` +
          `(application_id, event, channel) WHERE sent_by_name IS NULL. ${error.message}`,
      );
    }
    throw new Error(`whatsapp: could not write communication_log: ${error?.message}`);
  }
  return (data as { id: string }).id;
}
