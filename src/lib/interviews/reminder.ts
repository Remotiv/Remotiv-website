import "server-only";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import {
  formatInterviewDeadline,
  interviewReminderCopy,
} from "@/lib/email/candidate/interview-reminder";
import { buildPlaceholders, renderCopy } from "@/lib/email/candidate/render";
import { skipJob } from "@/lib/job-skip";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The interview_reminder handler — one nudge, 24 hours before the deadline.
 *
 * ── Nagging someone who finished is the failure mode ─────────
 *
 * Every guard below exists to avoid one specific bad outcome: a candidate who
 * has already recorded their answers receiving "your interview closes
 * tomorrow". That is worse than sending nothing, so every uncertain case skips.
 * None of them throws — a submitted session, a cancelled one, a deleted
 * applicant and a passed deadline are all permanent facts, and retrying them
 * three times with backoff would burn worker slots to re-learn something the
 * first read already settled. Same contract as the other handlers; see
 * lib/job-skip.ts.
 *
 * ── Both channels, gated identically to the invitation ───────
 *
 * Email is sent here, inline — this is already a background job, so there is no
 * recruiter waiting and nothing to keep off the request path. WhatsApp is
 * ENQUEUED as an ordinary send_message job, exactly as sendInterviewInvite
 * does, which means it inherits that path's phone normalisation, global
 * opt-out check, template classification and retry rules without this file
 * knowing about any of them.
 */

/** How far ahead of the deadline the reminder fires. */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * The event name on the reminder's communication_logs row.
 *
 * Distinct from 'interview' on purpose: sharing that event would make the
 * invitation's own log row satisfy this handler's idempotency check, and no
 * reminder would ever send.
 */
export const REMINDER_EVENT = "interview_reminder" as const;

/**
 * A log row in one of these means a previous attempt already claimed the send.
 * 'failed' is excluded so a genuine provider failure still retries.
 */
const ALREADY_HANDLED = ["queued", "sent", "skipped", "cancelled"];

/** Statuses that mean the candidate is done, one way or another. */
const FINISHED_STATUSES = new Set(["submitted", "cancelled", "expired"]);

export type InterviewReminderPayload = {
  sessionId: string;
  /**
   * The deadline string the invitation email already quoted. Carried rather
   * than recomputed so the invite, the reminder and the WhatsApp message cannot
   * disagree about the date.
   */
  deadline?: string;
  /**
   * `expires_at` as it stood when this job was scheduled.
   *
   * The staleness check. `run_after` is frozen at enqueue, so if the deadline
   * ever moves this job still fires at the OLD time — and, because `deadline`
   * above is carried rather than re-read, it would quote the OLD date too. One
   * comparison against the live column turns that into a skip.
   */
  expiresAt?: string;
};

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  status: string;
  expires_at: string;
  submitted_at: string | null;
};

type ApplicationRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  company_id_snapshot: string | null;
};

export async function handleInterviewReminder(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as InterviewReminderPayload;
  const sessionId = payload?.sessionId;

  // A payload with no session is a programming error, not a data condition —
  // it throws so it lands in last_error where it can be read.
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(`interview_reminder: payload has no sessionId (job ${job.id})`);
  }

  const service = createServiceClient();

  const { data: sessionData } = await service
    .from("interview_sessions")
    .select("id, company_id, application_id, job_id, status, expires_at, submitted_at")
    .eq("id", sessionId)
    .maybeSingle();

  const session = sessionData as SessionRow | null;
  if (!session) {
    skipJob("interview_reminder", job.id, `session ${sessionId} no longer exists`);
    return;
  }

  /*
   * ── The four states that must never produce a reminder ──
   *
   * submitted  the candidate finished; this is the outcome the whole handler
   *            is built to avoid disturbing
   * cancelled  the invite was superseded by a re-send, or the invitation email
   *            failed and sendInterviewInvite rolled the session back
   * expired    the window closed early, or the expiry job got here first
   *
   * `submitted_at` is checked independently of `status` rather than trusted
   * through it: a submit that wrote the timestamp but crashed before the status
   * update would otherwise still be nagged.
   */
  if (FINISHED_STATUSES.has(session.status)) {
    skipJob(
      "interview_reminder",
      job.id,
      `session ${sessionId} is ${session.status} — nothing to remind about`,
    );
    return;
  }
  if (session.submitted_at) {
    skipJob("interview_reminder", job.id, `session ${sessionId} was already submitted`);
    return;
  }

  /*
   * The deadline has already passed. Reminding someone about a window that
   * closed is pure noise, and the interview_expiry job owns this session now.
   *
   * Reached when the queue is backed up, when the worker was down over the
   * reminder's window, or when a lease had to be reclaimed — none of which a
   * retry improves.
   */
  const expiresAtMs = new Date(session.expires_at).getTime();
  if (expiresAtMs <= Date.now()) {
    skipJob(
      "interview_reminder",
      job.id,
      `session ${sessionId} closed at ${session.expires_at} before the reminder ran`,
    );
    return;
  }

  /*
   * ── The deadline moved after this job was queued ──
   *
   * `run_after` is fixed at enqueue and cannot be renegotiated, so a session
   * whose expires_at was pushed out would still be reminded at the original
   * moment, quoting the original date from the payload. Both wrong, and the
   * guards above would let it through — the window is open and the candidate
   * has not submitted.
   *
   * Comparing against the live column makes a stale reminder cancel ITSELF
   * rather than send something inaccurate. Nothing can move a deadline today;
   * this is here so that building extension is a matter of enqueueing a
   * replacement pair, not of discovering afterwards why a candidate was told
   * the wrong date.
   */
  if (payload.expiresAt && payload.expiresAt !== session.expires_at) {
    skipJob(
      "interview_reminder",
      job.id,
      `session ${sessionId} now closes at ${session.expires_at}, not ${payload.expiresAt} — this reminder is stale`,
    );
    return;
  }

  const applicationId = session.application_id;
  if (!applicationId) {
    skipJob("interview_reminder", job.id, `session ${sessionId} has no application`);
    return;
  }

  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_id, job_title_snapshot, company_id_snapshot",
    )
    .eq("id", applicationId)
    // Tenancy, not a filter for convenience: the session names the company, and
    // an application that does not agree is not this company's to write about.
    .eq("company_id_snapshot", session.company_id)
    .maybeSingle();

  const app = appData as ApplicationRow | null;
  if (!app) {
    skipJob(
      "interview_reminder",
      job.id,
      `application ${applicationId} no longer exists`,
    );
    return;
  }

  /*
   * ── Idempotency, before anything is composed ──
   *
   * Keyed (application, event, channel), the same shape as every other
   * candidate message. `channel` is load-bearing: without it this would match
   * the WhatsApp reminder's own row, `.maybeSingle()` returns null on
   * multiplicity, and the guard would fail OPEN into a duplicate email.
   *
   * deliverEmail writes its row as 'queued' BEFORE calling Resend, so a second
   * run of this job — a reclaimed lease, a duplicated tick — finds that row and
   * returns rather than sending again.
   *
   * KNOWN LIMIT, deliberate: this is application-scoped, not session-scoped,
   * because communication_logs has no session_id column. If an interview is
   * re-sent AFTER its reminder already went out, the new session's reminder
   * finds the old row and skips. It errs towards under-sending, which is the
   * safe direction here; the fix is a session column, see the report.
   */
  const { data: existing } = await service
    .from("communication_logs")
    .select("id, status")
    .eq("application_id", applicationId)
    .eq("event", REMINDER_EVENT)
    .eq("channel", "email")
    .in("status", ALREADY_HANDLED)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; status: string };
    console.log(
      `[interview_reminder] skipping ${sessionId} — already ${row.status}`,
    );
    return;
  }

  const companyId = session.company_id;
  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) {
    skipJob(
      "interview_reminder",
      job.id,
      `application ${applicationId} has no email address`,
    );
    return;
  }

  /*
   * Opt-out, per company. A candidate who unsubscribed from this company's
   * updates gets no reminder, regardless of how time-sensitive it is — the
   * whole point of an unsubscribe is that we do not get to decide which of our
   * messages were important enough to override it.
   */
  const { data: optOut } = await service
    .from("communication_opt_outs")
    .select("id, reason")
    .eq("company_id", companyId)
    .eq("email", to)
    .maybeSingle();

  if (optOut) {
    const reason = (optOut as { reason: string | null }).reason;
    await writeSkip(
      service,
      { companyId, applicationId, to },
      `Recipient opted out${reason ? `: ${reason}` : ""}.`,
    );
    return;
  }

  const [{ data: companyData }, { data: jobData }] = await Promise.all([
    service
      .from("companies")
      .select("name, candidate_reply_email")
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
  const companyName = (company?.name ?? "").trim();
  const jobTitle =
    ((jobData as { title: string | null } | null)?.title ?? "").trim() ||
    (app.job_title_snapshot ?? "").trim();

  const deadline =
    (payload.deadline ?? "").trim() || formatInterviewDeadline(session.expires_at);

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });
  const rendered = renderCopy(interviewReminderCopy(deadline), values);
  const html = buildCandidateHtml(rendered.body, companyName, companyId, to);

  const outcome = await deliverEmail(service, {
    companyId,
    applicationId,
    event: REMINDER_EVENT,
    to,
    subject: rendered.subject,
    html,
    companyName,
    replyTo: (company?.candidate_reply_email ?? "").trim() || null,
  });

  /*
   * A provider failure RETHROWS so the queue retries with backoff — the row
   * deliverEmail left behind reads 'failed', which is excluded from
   * ALREADY_HANDLED above, so that retry genuinely tries again.
   *
   * A cap skip does not throw: the row reads 'skipped' and the job completes.
   * Retrying tomorrow would deliver "closes tomorrow" after it closed.
   */
  if (!outcome.ok && outcome.kind === "provider") {
    throw new Error(`interview_reminder: Resend rejected the message: ${outcome.message}`);
  }
  if (!outcome.ok && outcome.kind === "not_configured") {
    throw new Error("interview_reminder: RESEND_API_KEY not configured");
  }
  if (!outcome.ok) return;

  /*
   * ── WhatsApp, alongside the email ──
   *
   * Enqueued rather than sent, and non-fatal, on exactly the contract
   * sendInterviewInvite uses: the reminder HAS reached the candidate by email,
   * so a queue outage costs a second notification and never the reminder
   * itself. Throwing here would retry the whole handler and the idempotency
   * check would then suppress the email that already went out.
   */
  try {
    /*
     * Imported at CALL time, not module top — jobs-queue.ts imports this file's
     * handler in order to register it, so a top-level import back would close an
     * initialisation cycle. Same reasoning, and same shape, as
     * maybeEnqueueScorecard in transcribe.ts.
     */
    const { enqueue, JOB_TYPES } = await import("@/lib/jobs-queue");

    const queued = await enqueue({
      type: JOB_TYPES.SEND_MESSAGE,
      payload: {
        applicationId,
        event: REMINDER_EVENT,
        channel: "whatsapp",
        deadline,
      },
      companyId,
    });
    if (!queued.ok) {
      console.error(
        "[interview_reminder] whatsapp enqueue failed (non-fatal):",
        queued.error,
      );
    }
  } catch (err) {
    console.error("[interview_reminder] whatsapp enqueue threw (non-fatal):", err);
  }
}

/**
 * Record a decision not to send.
 *
 * Written rather than dropped so the Messages page can show WHY a candidate got
 * no reminder — silence there reads as a broken feature.
 */
async function writeSkip(
  service: ReturnType<typeof createServiceClient>,
  target: { companyId: string; applicationId: string; to: string },
  reason: string,
): Promise<void> {
  const { error } = await service.from("communication_logs").insert({
    company_id: target.companyId,
    application_id: target.applicationId,
    event: REMINDER_EVENT,
    channel: "email",
    to_address: target.to,
    subject: "",
    body: "",
    status: "skipped",
    error: reason,
  });
  if (error) {
    console.error("[interview_reminder] skip log insert failed:", error.message);
  }
}
