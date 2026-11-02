import "server-only";
import type { DeliveryOutcome } from "@/lib/email/candidate/deliver";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import { buildPlaceholders, renderCopy } from "@/lib/email/candidate/render";
import { REMINDER_LEAD_MS } from "@/lib/interviews/reminder";
import { interviewUrl } from "@/lib/interviews/tokens";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * An interview invitation's email and its background jobs, shared by the
 * applicant drawer's send actions (applicants/interview-actions.ts) and, next,
 * the live restart (F10 C5).
 *
 *   sendInviteEmail       renders and sends the invitation; never touches the session
 *   deliverInvite         sendInviteEmail, then cancels the session if the email
 *                         failed: the send actions' path, exactly as before
 *   scheduleInterviewJobs the reminder (async only) and the expiry, for any session
 *
 * Moved here unchanged from interview-actions.ts (F10 C4): same queries, same
 * copy handling, same email path, same jobs, in the same order. Every caller
 * has already resolved the company and checked the hiring team; nothing here
 * checks either again.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Who is sending: the company and the member named on the email's log row. */
export type InviteSender = { companyId: string; memberName: string | null };

export type InviteApplication = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  jobs?: { title: string | null } | null;
};

export type InviteEmailInput = {
  ctx: InviteSender;
  applicationId: string;
  app: InviteApplication;
  rawToken: string;
  expiresAt: string;
  copy: (link: string, deadline: string) => { subject: string; body: string };
};

/** Why the email was not sent: deliverEmail's own reason, unchanged. */
export type InviteEmailFailure = Extract<DeliveryOutcome, { ok: false }>["kind"];

/**
 * Email the invitation, and nothing else: whatever happens, the session is left
 * as it is. `code` is deliverEmail's reason and `message` its sentence for the
 * recruiter.
 *
 * The invite goes out through the SAME path as every other candidate email —
 * renderCopy for substitution, buildCandidateHtml for the shell and the
 * unsubscribe footer, deliverEmail for sender identity, reply-to, the daily
 * cap and the log-before-send row. Nothing here talks to Resend directly.
 *
 * Event 'interview' rather than 'manual': it IS the lifecycle event, so it
 * lands in the Messages page's Automatic tab and shares the idempotency and
 * opt-out semantics of the rest of the lifecycle.
 *
 * Returns the deadline exactly as the email rendered it, so every later
 * message about this session can quote the same wording.
 */
export async function sendInviteEmail(
  service: Service,
  input: InviteEmailInput,
): Promise<
  { ok: true; deadline: string } | { ok: false; code: InviteEmailFailure; message: string }
> {
  const { ctx, app } = input;
  const to = (app.email ?? "").trim().toLowerCase();
  const jobTitle =
    (app.jobs?.title ?? "").trim() || (app.job_title_snapshot ?? "").trim() || "the role";

  const { data: companyData } = await service
    .from("companies")
    .select("name, candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;
  const companyName = (company?.name ?? "").trim();

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });

  const link = interviewUrl(input.rawToken);
  const deadline = new Date(input.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  const rendered = renderCopy(input.copy(link, deadline), values);

  const html = buildCandidateHtml(rendered.body, companyName, ctx.companyId, to);

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId: input.applicationId,
    event: "interview",
    to,
    subject: rendered.subject,
    html,
    companyName,
    replyTo: (company?.candidate_reply_email ?? "").trim() || null,
    sentByName: ctx.memberName,
  });

  if (!outcome.ok) return { ok: false, code: outcome.kind, message: outcome.message };
  return { ok: true, deadline };
}

/**
 * Email the invitation, and cancel the session if it cannot be delivered. The
 * send actions' path; a restart never takes it (it calls sendInviteEmail and
 * keeps its session, F10 decision 6).
 */
export async function deliverInvite(
  service: Service,
  input: InviteEmailInput & { sessionId: string },
): Promise<{ ok: true; deadline: string } | { ok: false; error: string }> {
  const sent = await sendInviteEmail(service, input);
  if (!sent.ok) {
    /*
     * The session exists but nobody can reach it, so it is cancelled rather
     * than left as a live token with no delivered link. Re-sending mints a
     * fresh one; leaving this open would accumulate dead sessions that the
     * one-open-session rule would then have to reason about.
     */
    await service
      .from("interview_sessions")
      .update({ status: "cancelled" })
      .eq("id", input.sessionId);
    return { ok: false, error: sent.message };
  }
  return { ok: true, deadline: sent.deadline };
}

/**
 * Queue the reminder and the expiry for one freshly sent session, any session:
 * a first invite, a re-send, or a restart's attempt 2.
 *
 * Server code only, never a server action: scheduling background work is not
 * something a browser may ask for. Every caller has already done the company
 * and hiring-team checks.
 *
 * `reminder` is explicit, not defaulted: the reminder's copy describes an
 * async interview, so the live send passes false and the async send true.
 *
 * ── When the reminder is skipped entirely ──
 *
 * If the window is 24 hours or less, `run_after` would land at or before now
 * and the reminder would fire within one worker tick of the invitation — "your
 * interview closes tomorrow" arriving minutes after "here is your interview".
 * That is worse than no reminder, so none is queued and the reason is logged.
 *
 * Unreachable today: SESSION_EXPIRY_DAYS is 5, so the lead is always four days.
 * It is a guard against the value being lowered, or being made per-job, without
 * anyone re-deriving what that does to the reminder.
 */
export async function scheduleInterviewJobs(input: {
  sessionId: string;
  companyId: string;
  expiresAt: string;
  expiresAtMs: number;
  deadline: string;
  reminder: boolean;
}): Promise<void> {
  const { sessionId, companyId, expiresAt, expiresAtMs, deadline } = input;

  try {
    const reminderAtMs = expiresAtMs - REMINDER_LEAD_MS;
    if (input.reminder && reminderAtMs <= Date.now()) {
      console.log(
        `[interview] no reminder for session ${sessionId} — the window is shorter than the ${
          REMINDER_LEAD_MS / (60 * 60 * 1000)
        }h reminder lead`,
      );
    } else if (input.reminder) {
      const queued = await enqueue({
        type: JOB_TYPES.INTERVIEW_REMINDER,
        // `deadline` is the invitation email's exact wording, so the reminder
        // cannot quote a different date to the same candidate; `expiresAt` is
        // the instant it was derived from, which is what lets the handler
        // notice that the deadline has since moved.
        payload: { sessionId, deadline, expiresAt },
        companyId,
        runAfter: new Date(reminderAtMs),
      });
      if (!queued.ok) {
        console.error("[interview] reminder enqueue failed (non-fatal):", queued.error);
      }
    }

    const expired = await enqueue({
      type: JOB_TYPES.INTERVIEW_EXPIRY,
      payload: { sessionId },
      companyId,
      runAfter: new Date(expiresAtMs),
    });
    if (!expired.ok) {
      console.error("[interview] expiry enqueue failed (non-fatal):", expired.error);
    }
  } catch (err) {
    console.error("[interview] scheduling enqueue threw (non-fatal):", err);
  }
}
