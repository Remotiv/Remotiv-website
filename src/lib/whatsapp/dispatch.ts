import "server-only";
import { redactCandidateLinks } from "@/lib/candidate-links";
import {
  confirmApplicationGone,
  dbFailure,
  finaliseOrphanedAttempt,
  insertFirstAttemptCommunicationLog,
  markOwnedFailed,
  markOwnedSkipped,
  type OwnedAttempt,
  QUEUED_ONLY,
  refreshOwnedBeforeSend,
  resolveAutomaticAttempt,
} from "@/lib/communication-attempt";
import { skipJob } from "@/lib/job-skip";
import { alertSendFailure, updatedOne } from "@/lib/notifications/send-failure";
import { TerminalJobError } from "@/lib/queue/failure-class";
import { createServiceClient } from "@/lib/supabase/server";
import { isWhatsAppOptedOut } from "@/lib/whatsapp/opt-out";
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
 * ── Who owns an automatic send (#85) ─────────────────────────
 *
 * Same queue, same job type and the same log-before-send discipline as the
 * email path, keyed on (application, event, channel). Whether this run may
 * send is decided by the database, through lib/communication-attempt.ts: the
 * first attempt inserts its row stamped by the database clock, a retry claims
 * a stale queued row, and every write after that is guarded on the stamp this
 * worker was handed. Nothing here compares a time.
 *
 * A failed row is never claimed again. Two of its causes are uncertain rather
 * than failed (the 15-second timeout, and a 200 from Meta with no message id),
 * and without an idempotency key a resend could duplicate. Retrying failed
 * WhatsApp rows is its own later piece.
 *
 * A recruiter's send (sentByName set) is not deduplicated and claims nothing:
 * it keeps its plain insert, outside the partial unique index.
 */

/** The only events that go out on WhatsApp, mapped to their Meta template. */
const EVENT_TEMPLATES: Record<string, WhatsAppTemplateName> = {
  interview: WHATSAPP_TEMPLATES.interview_invitation,
  interview_reminder: WHATSAPP_TEMPLATES.interview_reminder,
};

/** Roughly how long an interview takes, for template variable {{4}}. */
const DEFAULT_MINUTES = "12";

/** Shown on the Messages page for a skipped send. Fixed text, never a raw error. */
export const OPTED_OUT_REASON = "Recipient has opted out of WhatsApp messages.";
export const OPT_OUT_CHECK_FAILED_REASON =
  "Not sent: we couldn't confirm whether this candidate has opted out of WhatsApp, so it was skipped to be safe. Email is unaffected.";

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
   * sent_by_name IS NULL encodes this rule: automatic rows are unique per
   * event, a named one is not. So only an automatic send is deduplicated and
   * claimed; a recruiter can see the previous message and asked for another.
   */
  const sentByName = (payload.sentByName ?? "").trim() || null;
  const key = { applicationId, event, channel: "whatsapp" as const };

  /*
   * ── 1. The application, before anything is claimed ──
   *
   * Loaded first so a deleted application never gets a row claimed for it.
   * Deleted after this read and before the claim, the claim answers missing
   * and the run retries (E4); the next run finds nothing and skips.
   */
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

  /*
   * ── 2. Who owns this send ──
   *
   * Automatic only. `done` is terminal and writes nothing: the row is already
   * sent, skipped, cancelled or failed, or a database rule just ended it. A
   * wait or a retry leaves by throwing, and the queue runs the job again.
   */
  let owned: OwnedAttempt | null = null;
  if (!sentByName) {
    const resolution = await resolveAutomaticAttempt(service, key, QUEUED_ONLY);
    if (resolution.kind === "done") {
      console.log(`[whatsapp] ${event} for ${applicationId} not sent: ${resolution.reason}`);
      return;
    }
    if (resolution.kind === "owned") owned = resolution.owned;
  }

  // ── 3 and 4. Can this number be addressed, and may we write to it? ──
  const target = await sendTarget(service, app.phone);

  /*
   * A decision not to send, recorded where the row lives: on the owned row
   * (guarded), or as a new skipped row for a first attempt or a recruiter
   * send. A first attempt's skipped insert that collides with a row written
   * meanwhile takes the conflict path instead of inserting a second.
   */
  if (!target.send) {
    if (owned) {
      const skipped = await markOwnedSkipped(service, owned, {
        error: target.reason,
        toAddress: target.toAddress,
      });
      if (!skipped) {
        console.warn(`[whatsapp] ${event} for ${applicationId}: the row changed before the skip`);
      }
      return;
    }
    const written = await writeLog(service, {
      companyId,
      applicationId,
      event,
      toAddress: target.toAddress,
      status: "skipped",
      error: target.reason,
      sentByName,
    });
    if (written.ok) return;
    if (sentByName) {
      throw new Error(`whatsapp: could not write communication_log: ${written.error?.message}`);
    }
    if (written.error?.code === UNIQUE_VIOLATION) {
      const again = await resolveAutomaticAttempt(service, key, QUEUED_ONLY, {
        afterConflict: true,
      });
      if (again.kind === "owned") {
        await markOwnedSkipped(service, again.owned, {
          error: target.reason,
          toAddress: target.toAddress,
        });
      }
      return;
    }
    if (written.error?.code !== FOREIGN_KEY_VIOLATION) {
      throw dbFailure("the skipped insert", written.error, written.status);
    }
    // Which foreign key broke is decided by reading the application, never by the message.
    await confirmApplicationGone(service, { applicationId, companyId }, written.error);
    skipJob("send_message[whatsapp]", job.id, `application ${applicationId} was deleted`);
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

  // The rendered variables, not the template text — Meta owns the wording, and
  // storing our guess at it would go stale the moment it is edited.
  const body = `${template}: ${JSON.stringify(vars)}`;

  /*
   * ── 6. Log BEFORE the attempt ──
   *
   * A row that exists before the network call means a crash mid-send leaves
   * evidence rather than silence. An automatic send owns its row first (the
   * database-stamped insert, or the claim above), then refreshes it with what
   * this attempt sends. The refresh is guarded, and also requires the
   * application to still exist, so a row stopped, claimed elsewhere or
   * orphaned meanwhile is never sent.
   */
  let logId: string;
  if (sentByName) {
    const written = await writeLog(service, {
      companyId,
      applicationId,
      event,
      toAddress: target.digits,
      status: "queued",
      body,
      sentByName,
    });
    if (!written.ok) {
      throw new Error(`whatsapp: could not write communication_log: ${written.error?.message}`);
    }
    logId = written.id;
  } else {
    if (!owned) {
      const inserted = await insertFirstAttemptCommunicationLog(service, {
        ...key,
        companyId,
        toAddress: target.digits,
        subject: null,
        body,
      });
      if (inserted.kind === "foreign_key") {
        await confirmApplicationGone(service, { applicationId, companyId }, inserted.error);
        skipJob("send_message[whatsapp]", job.id, `application ${applicationId} was deleted`);
        return;
      }
      if (inserted.kind === "conflict") {
        const again = await resolveAutomaticAttempt(service, key, QUEUED_ONLY, {
          afterConflict: true,
        });
        if (again.kind === "done") {
          console.log(`[whatsapp] ${event} for ${applicationId} not sent: ${again.reason}`);
          return;
        }
        if (again.kind !== "owned") {
          throw new TerminalJobError(
            "deterministic",
            "send_message[whatsapp]: a conflict resolved to a second first attempt",
          );
        }
        owned = again.owned;
      } else {
        owned = inserted.owned;
      }
    }
    if (!(await refreshOwnedBeforeSend(service, owned, { toAddress: target.digits, body }))) {
      const orphaned = await finaliseOrphanedAttempt(service, owned);
      console.warn(
        orphaned
          ? `[whatsapp] ${event} for ${applicationId} not sent: the application was deleted`
          : `[whatsapp] ${event} for ${applicationId} not sent: the row was stopped or claimed elsewhere`,
      );
      return;
    }
    logId = owned.id;
  }

  // ── 7. Send ──
  const result = await sendTemplateMessage({
    toDigits: target.digits,
    template,
    vars,
  });

  if (result.ok) {
    // By id, whatever the row became meanwhile: a send that happened is recorded.
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

  /*
   * A refusal, or an answer that proves nothing either way (a timeout, a 200
   * with no message id). Recorded as failed, never as sent. An automatic row is
   * guarded on this worker's stamp; a recruiter's row by id, as before.
   */
  const failure = result.message.slice(0, 500);
  let marked: boolean;
  if (owned) {
    marked = await markOwnedFailed(service, owned, failure);
  } else {
    // The row back (.select), so the bell rings only for a mark that landed.
    const { data } = await service
      .from("communication_logs")
      .update({ status: "failed", error: failure })
      .eq("id", logId)
      .select("id");
    marked = updatedOne(data);
  }

  /*
   * Someone is told (#71A), only for a mark that landed. Best-effort by
   * construction. No actor: a recruiter's WhatsApp send is queued, so nobody
   * saw this error on a screen and nobody is left out of the fan-out.
   */
  if (marked) {
    await alertSendFailure(service, {
      logId,
      companyId,
      applicationId,
      event,
      channel: "whatsapp",
      actorMemberId: null,
    });
  }

  /*
   * An automatic send ends here. Its failed row is never claimed again, so a
   * retry could only find it failed: the bell is the signal, not a dead job.
   *
   * A recruiter's send keeps its retry. A 429 or a 5xx is worth another go,
   * and throwing takes the queue's normal retry path; a template that is not
   * approved fails identically every time, so that one ends here too.
   */
  if (!owned && result.kind === "transient") {
    throw new Error(`send_message[whatsapp]: ${result.message}`);
  }

  console.error(
    `[whatsapp] ${result.kind} failure for ${event}/${applicationId}, not retrying: ${result.message}`,
  );
}

/**
 * Where this message would go, or why it must not go there.
 *
 * Both are local decisions, made before spending a message, and both are
 * recorded as a skipped row rather than dropped, so the Messages page can show
 * WHY this candidate got an email but no WhatsApp — silence there would look
 * like the integration was broken.
 *
 * The opt-out is global: that person never hears from us again. By phone OR by
 * any BSUID seen with that phone, and closed on any lookup error. The rule and
 * its limits live in opt-out.ts; nothing about BSUIDs belongs in this file.
 */
async function sendTarget(
  service: ReturnType<typeof createServiceClient>,
  phone: string | null,
): Promise<{ send: true; digits: string } | { send: false; toAddress: string; reason: string }> {
  const recipient = resolveRecipient(phone);
  if (!recipient.ok) return { send: false, toAddress: "unknown", reason: recipient.reason };
  const optOut = await isWhatsAppOptedOut(service, recipient.digits);
  if (optOut.status !== "clear") {
    return {
      send: false,
      toAddress: recipient.digits,
      reason: optOut.status === "opted_out" ? OPTED_OUT_REASON : OPT_OUT_CHECK_FAILED_REASON,
    };
  }
  return { send: true, digits: recipient.digits };
}

/** Postgres unique_violation: the partial unique index on (application_id, event, channel). */
const UNIQUE_VIOLATION = "23505";
/** Postgres foreign_key_violation. Which key is settled by a read, never by the message. */
const FOREIGN_KEY_VIOLATION = "23503";

type WriteLogResult =
  | { ok: true; id: string }
  | { ok: false; error: { code?: string; message?: string } | null; status: number };

/**
 * Insert one row: a recruiter's queued row, or a skipped row. An automatic
 * send's queued row never comes here; it is inserted by the database
 * (insert_first_attempt_communication_log) so its stamp is the database's.
 * Answers the failure rather than throwing it, because what a 23505 or a
 * 23503 means depends on the caller.
 */
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
     * (deliver.ts).
     */
    sentByName?: string | null;
  },
): Promise<WriteLogResult> {
  const { data, error, status } = await service
    .from("communication_logs")
    .insert({
      company_id: row.companyId,
      application_id: row.applicationId,
      event: row.event,
      channel: "whatsapp",
      to_address: row.toAddress,
      subject: null,
      // The variables carry no link today. Redacted anyway: every write to this
      // column goes through the redactor, and a test holds every write to that.
      body: redactCandidateLinks(row.body),
      status: row.status,
      error: row.error ?? null,
      sent_by_name: row.sentByName ?? null,
      ...(row.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error, status };
  return { ok: true, id: (data as { id: string }).id };
}
