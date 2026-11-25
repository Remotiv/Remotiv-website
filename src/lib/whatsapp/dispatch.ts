import "server-only";
import {
  DELETION_IN_PROGRESS,
  deletionStartedFor,
  NOT_SENT_DELETING,
} from "@/lib/applicant-deletion";
import { redactCandidateLinks } from "@/lib/candidate-links";
import {
  confirmApplicationGone,
  dbFailure,
  E12,
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
import { hasWhatsAppOptIn, NO_OPT_IN_REASON } from "@/lib/whatsapp/consent";
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
  /** Migration 079 (#67): the candidate's tick on the apply form, and when. */
  whatsapp_opt_in: boolean | null;
  whatsapp_opt_in_at: string | null;
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
  /**
   * The communication_logs row a recruiter's send was queued with (#52,
   * migration 064, queue_manual_whatsapp): the row exists, durable and
   * cancellable, BEFORE this job does. Absent on jobs queued before 064.
   */
  logId?: string;
};

/**
 * What a recruiter's WhatsApp row says when this worker cannot know whether
 * Meta delivered it (a timeout, a 200 with no message id, a run that died
 * after claiming). Never retried: sending again could send it twice (#52).
 */
export const UNCERTAIN_NOTE =
  "Not confirmed. This message may have been delivered, so it was not sent again.";

export async function handleWhatsAppMessage(job: {
  id: string;
  /** The queue's attempt count: 0 on the first run, more after a failure or a reclaim. */
  attempts?: number;
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
   *
   * This read gates everything after it, so an ERROR is never read as "gone":
   * a transient one is a counted retry, anything else stops the job loudly.
   * Only a read that succeeded and found no row skips.
   */
  const {
    data: appData,
    error: appError,
    status: appStatus,
  } = await service
    .from("job_applications")
    .select(
      "id, first_name, phone, job_id, job_title_snapshot, company_id_snapshot, whatsapp_opt_in, whatsapp_opt_in_at",
    )
    .eq("id", applicationId)
    .maybeSingle();
  if (appError) throw dbFailure("the application read", appError, appStatus);

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
  /*
   * ── A recruiter's send (#52) ──
   *
   * Queued by queue_manual_whatsapp (064): its row exists and carries the id.
   * Sent only by the run that CLAIMS that row, at most once, never retried.
   * A job from before 064 (no logId) sends on its first run only: a retry or a
   * reclaim may follow a send Meta accepted, so it never sends again.
   */
  if (sentByName) {
    if (typeof payload.logId === "string" && payload.logId) {
      await sendQueuedManual(service, {
        logId: payload.logId,
        app,
        companyId,
        applicationId,
        event,
        template,
        payload,
      });
      return;
    }
    if ((job.attempts ?? 0) >= 1) {
      console.warn(
        `[whatsapp] ${event} for ${applicationId}: a recruiter's send from before #52 on attempt ${job.attempts}, not sent again`,
      );
      return;
    }
  }

  let owned: OwnedAttempt | null = null;
  if (!sentByName) {
    const resolution = await resolveAutomaticAttempt(service, key, QUEUED_ONLY);
    if (resolution.kind === "done") {
      console.log(`[whatsapp] ${event} for ${applicationId} not sent: ${resolution.reason}`);
      return;
    }
    if (resolution.kind === "owned") owned = resolution.owned;
  }

  // ── 3 and 4. Did they opt in, can this number be addressed, may we write to it? ──
  const target = await sendTarget(service, app);

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
  const { vars, body } = await messageFor(service, app, companyId, payload, template);

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
      if (written.error?.code === DELETION_IN_PROGRESS) {
        // #16: 071's guard refused the row; the applicant is being deleted.
        console.log(`[whatsapp] ${event} for ${applicationId} not sent: ${E12}`);
        return;
      }
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
      if (inserted.kind === "deleting") {
        // #16: 071's guard refused the row; nothing is ever sent.
        console.log(`[whatsapp] ${event} for ${applicationId} not sent: ${E12}`);
        return;
      }
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
  // #16: immediately before the provider call, the applicant's delete may have
  // started since this row was claimed. Not sent then, now or later.
  if (await stopIfBeingDeleted(service, { logId, companyId, applicationId })) return;
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
  // A recruiter's send that proves nothing either way is "not confirmed" (#52).
  const failure =
    !owned && result.kind === "transient" ? UNCERTAIN_NOTE : result.message.slice(0, 500);
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
   * Nothing here is retried. An automatic send's failed row is never claimed
   * again, so a retry could only find it failed: the bell is the signal. A
   * recruiter's send is at most once since #52: a timeout or a 200 with no
   * message id may already have been delivered, and a retry would send it
   * twice. The recruiter can send again from the dashboard.
   */
  console.error(
    `[whatsapp] ${result.kind} failure for ${event}/${applicationId}, not retrying: ${result.message}`,
  );
}

/** The template variables and the stored body for one application (step 5). */
async function messageFor(
  service: ReturnType<typeof createServiceClient>,
  app: ApplicationRow,
  companyId: string,
  payload: WhatsAppSendPayload,
  template: WhatsAppTemplateName,
): Promise<{ vars: InterviewVars; body: string }> {
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
  return { vars, body: `${template}: ${JSON.stringify(vars)}` };
}

type InterviewVars = {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  minutes: string;
  deadline: string;
};

/**
 * Send a recruiter's message that was queued with its row (#52, 064).
 *
 *   1. CLAIM the row through claim_manual_communication_log (064), stamped
 *      by the database: status 'queued' AND attempt_started_at IS NULL. A row
 *      Stopped first is 'stopped': nothing is sent. A row an earlier run
 *      claimed comes back 'uncertain': that run may have sent it, so the
 *      function marks it not confirmed and it is never sent again.
 *   2. Re-check the recipient now (an opt-out may have arrived since queueing).
 *   3. Send once. Accepted: 'sent' with Meta's id, by id (a send that happened
 *      is recorded, even over a Stop that landed during it: the accepted race,
 *      we never promise to recall a message). Anything else: 'failed', guarded
 *      on 'queued' so a Stop that landed during the call is kept; a timeout or
 *      a 200 with no id is "not confirmed". Never retried, never thrown.
 */
async function sendQueuedManual(
  service: ReturnType<typeof createServiceClient>,
  input: {
    logId: string;
    app: ApplicationRow;
    companyId: string;
    applicationId: string;
    event: string;
    template: WhatsAppTemplateName;
    payload: WhatsAppSendPayload;
  },
): Promise<void> {
  const { logId, app, companyId, applicationId, event, template, payload } = input;
  const alert = () =>
    alertSendFailure(service, {
      logId,
      companyId,
      applicationId,
      event,
      channel: "whatsapp",
      actorMemberId: null,
    });

  // The claim and its stamp are the DATABASE's (migration 064), as every
  // attempt stamp is (#85): nothing here writes or reads attempt_started_at.
  const {
    data: claimData,
    error: claimError,
    status: claimStatus,
  } = await service.rpc("claim_manual_communication_log", {
    p_id: logId,
    p_company_id: companyId,
    p_uncertain_error: UNCERTAIN_NOTE,
  });
  // Failing to know is not a send: the queue retries, and a claim that did land
  // comes back to the retry as 'uncertain', never as a second send.
  // #16: 071's guard refused the claim, the applicant is being deleted. The
  // row ends skipped (a write the guard allows), and nothing is ever sent.
  if (claimError?.code === DELETION_IN_PROGRESS) {
    await endAsBeingDeleted(service, { logId, companyId, applicationId }, "deleting");
    return;
  }
  if (claimError) throw dbFailure("the claim", claimError, claimStatus);
  const outcome = (
    (Array.isArray(claimData) ? claimData[0] : claimData) as {
      out_outcome?: string;
    } | null
  )?.out_outcome;
  if (outcome !== "claimed") {
    // 'uncertain': an earlier run claimed it and never finished; the function
    // marked it failed with UNCERTAIN_NOTE, so someone is told. 'stopped',
    // 'finished', 'missing': nothing to send.
    if (outcome === "uncertain") await alert();
    console.log(
      `[whatsapp] ${event} for ${applicationId}: queued row ${outcome ?? "unknown"}, not sent`,
    );
    return;
  }

  const target = await sendTarget(service, app);
  if (!target.send) {
    await service
      .from("communication_logs")
      .update({ status: "skipped", error: target.reason, to_address: target.toAddress })
      .eq("id", logId)
      .eq("company_id", companyId)
      .eq("status", "queued");
    return;
  }

  const { vars } = await messageFor(service, app, companyId, payload, template);
  // #16: immediately before the provider call, as for an automatic send.
  if (await stopIfBeingDeleted(service, { logId, companyId, applicationId })) return;
  const result = await sendTemplateMessage({ toDigits: target.digits, template, vars });

  if (result.ok) {
    await service
      .from("communication_logs")
      .update({
        status: "sent",
        provider_message_id: result.messageId,
        sent_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", logId)
      .eq("company_id", companyId);
    return;
  }

  const failure = result.kind === "transient" ? UNCERTAIN_NOTE : result.message.slice(0, 500);
  const { data: failed } = await service
    .from("communication_logs")
    .update({ status: "failed", error: failure })
    .eq("id", logId)
    .eq("company_id", companyId)
    .eq("status", "queued")
    .select("id");
  if (updatedOne(failed)) await alert();
  console.error(
    `[whatsapp] ${result.kind} failure for ${event}/${applicationId}, not retrying (#52)`,
  );
}

export type QueueManualResult =
  | { kind: "queued"; logId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "not_queued"; reason: string };

/**
 * Queue a recruiter's WhatsApp message (#52): the row and the job in ONE
 * transaction (queue_manual_whatsapp, migration 064), so the row exists,
 * durable and cancellable from Messages, before any worker can see the job,
 * and neither exists without the other. A recipient that must not be messaged
 * (no usable number, opted out) is recorded as a skipped row at once and gets
 * no job. Never throws: the caller's email has already gone out.
 */
export async function queueManualWhatsApp(
  service: ReturnType<typeof createServiceClient>,
  input: {
    applicationId: string;
    companyId: string;
    event: "interview";
    sentByName: string;
    deadline?: string;
    minutes?: string;
  },
): Promise<QueueManualResult> {
  const template = EVENT_TEMPLATES[input.event];
  const { data: appData, error: appError } = await service
    .from("job_applications")
    .select(
      "id, first_name, phone, job_id, job_title_snapshot, company_id_snapshot, whatsapp_opt_in, whatsapp_opt_in_at",
    )
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    .maybeSingle();
  const app = appData as ApplicationRow | null;
  if (appError || !app || !template) {
    return { kind: "not_queued", reason: appError?.code ?? "application_not_found" };
  }

  const payload: WhatsAppSendPayload = {
    applicationId: input.applicationId,
    event: input.event,
    channel: "whatsapp",
    sentByName: input.sentByName,
    ...(input.deadline ? { deadline: input.deadline } : {}),
    ...(input.minutes ? { minutes: input.minutes } : {}),
  };

  const target = await sendTarget(service, app);
  if (!target.send) {
    const written = await writeLog(service, {
      companyId: input.companyId,
      applicationId: input.applicationId,
      event: input.event,
      toAddress: target.toAddress,
      status: "skipped",
      error: target.reason,
      sentByName: input.sentByName,
    });
    return written.ok
      ? { kind: "skipped", reason: target.reason }
      : { kind: "not_queued", reason: written.error?.code ?? "skip_write_failed" };
  }

  const { body } = await messageFor(service, app, input.companyId, payload, template);
  const { data, error } = await service.rpc("queue_manual_whatsapp", {
    p_company_id: input.companyId,
    p_application_id: input.applicationId,
    p_event: input.event,
    p_to_address: target.digits,
    // Every write to this column goes through the redactor (see writeLog).
    p_body: redactCandidateLinks(body),
    p_sent_by_name: input.sentByName,
    p_payload: payload,
  });
  if (error) return { kind: "not_queued", reason: error.code ?? "rpc_failed" };
  const row = (Array.isArray(data) ? data[0] : data) as {
    out_outcome?: string;
    out_log_id?: string | null;
  } | null;
  if (row?.out_outcome !== "queued" || !row.out_log_id) {
    return { kind: "not_queued", reason: row?.out_outcome ?? "no_answer" };
  }
  return { kind: "queued", logId: row.out_log_id };
}

/**
 * Where this message would go, or why it must not go there. THE guard: every
 * send in this file asks it first (a tripwire test holds that).
 *
 * All local decisions, made before spending a message, and all recorded as a
 * skipped row rather than dropped, so the Messages page can show WHY this
 * candidate got an email but no WhatsApp — silence there would look like the
 * integration was broken.
 *
 * Consent first (#67, consent.ts), from the application row each caller has
 * just read: no tick on the apply form, no WhatsApp, whatever else is true. A
 * tick never overrides a STOP: the opt-out check below still runs for a
 * candidate who opted in.
 *
 * The opt-out is global: that person never hears from us again. By phone OR by
 * any BSUID seen with that phone, and closed on any lookup error. The rule and
 * its limits live in opt-out.ts; nothing about BSUIDs belongs in this file.
 */
async function sendTarget(
  service: ReturnType<typeof createServiceClient>,
  app: Pick<ApplicationRow, "phone" | "whatsapp_opt_in" | "whatsapp_opt_in_at">,
): Promise<{ send: true; digits: string } | { send: false; toAddress: string; reason: string }> {
  const recipient = resolveRecipient(app.phone);
  if (!hasWhatsAppOptIn(app)) {
    return {
      send: false,
      toAddress: recipient.ok ? recipient.digits : "unknown",
      reason: NO_OPT_IN_REASON,
    };
  }
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

/**
 * #16: the applicant's delete has started (or its marker could not be read):
 * the queued row ends without a send. A message Meta has already accepted
 * cannot be recalled; this runs immediately before the provider call, the last
 * point anything can stop one.
 */
async function endAsBeingDeleted(
  service: ReturnType<typeof createServiceClient>,
  row: { logId: string; companyId: string; applicationId: string },
  marker: "deleting" | "unknown",
): Promise<void> {
  await service
    .from("communication_logs")
    .update({
      status: marker === "deleting" ? "skipped" : "failed",
      error:
        marker === "deleting"
          ? NOT_SENT_DELETING
          : "Not sent: could not confirm this applicant is not being deleted.",
    })
    .eq("id", row.logId)
    .eq("company_id", row.companyId)
    .eq("status", "queued");
  console.log(`[whatsapp] ${row.applicationId}: not sent, applicant ${marker}`);
}

/** True when the send must not happen: the marker is set, or could not be read. */
async function stopIfBeingDeleted(
  service: ReturnType<typeof createServiceClient>,
  row: { logId: string; companyId: string; applicationId: string },
): Promise<boolean> {
  const marker = await deletionStartedFor(service, {
    applicationId: row.applicationId,
    companyId: row.companyId,
  });
  if (marker === "clear") return false;
  await endAsBeingDeleted(service, row, marker);
  return true;
}
