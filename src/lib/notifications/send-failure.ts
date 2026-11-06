import "server-only";
import { deterministicUuid } from "@/lib/queue/job-id";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Someone is told when a candidate message does not arrive (#71A).
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * Four paths mark a communication_logs row failed: deliverEmail without a
 * provider key, deliverEmail when Resend refuses, the WhatsApp dispatcher
 * when Meta refuses, and the WhatsApp webhook when Meta reports a failure
 * after acceptance. Until this helper, no path led from any of them to a
 * person. The worst was the WhatsApp terminal case, which returns normally,
 * so the job is marked succeeded and the queue's job_dead alert never fires.
 * All four call this, so there is one place to read and one to test.
 *
 * ── Best effort, structurally ────────────────────────────────
 *
 * The exported function returns void and its whole body is inside one
 * try/catch, so it cannot throw and nothing it does can be branched on. A
 * send path that calls it behaves exactly as it did before the call: the same
 * return value, the same throw or no throw. That is the contract every caller
 * relies on, and it holds whatever the inner function grows into, because the
 * wrapper is the only export.
 *
 * ── No alert for an erased applicant ─────────────────────────
 *
 * communication_logs.application_id is ON DELETE SET NULL. A NULL there means
 * the applicant was deleted, and the Messages page hides those rows on
 * purpose: the product's delete means erasure (messages/actions.ts:108-127,
 * pinned by split-and-failed.test.ts:87-88). A bell about a person the
 * company has erased would undo that decision, so a NULL application is a
 * return, not an alert.
 *
 * ── No candidate data in the text ────────────────────────────
 *
 * notifications_company.application_id is ON DELETE SET NULL too, so a bell
 * row survives the applicant's deletion with a dangling NULL, and nothing
 * redacts its title, body or href. A name or a phone number written there
 * outlives the erasure. The text therefore names the applicant by the last six
 * characters of the id only, and the href carries the id, as every applicant
 * bell already does.
 *
 * ── One bell per failure record ──────────────────────────────
 *
 * The row id is deterministicUuid(kind, communication_logs row id, member),
 * so the database refuses a second bell for the same failure record and the
 * same recipient (23505, read as "already there" by notifyCompanyOnce). A
 * retry that fails on the same row alerts nobody twice. A genuine later
 * failure of the same message is a NEW communication_logs row, a recruiter's
 * re-send or a fresh automatic attempt, and that alerts again. The key is the
 * row, not (application, event, channel): that triple is unique only for
 * automatic rows, and keying on it would silence a recruiter's second,
 * different failed send for ever.
 *
 * ── Only for a row that was really marked ────────────────────
 *
 * A PostgREST update that matches zero rows returns no error, so a null
 * error proves nothing was rejected, not that anything changed. Every caller
 * therefore asks its update for the row back (.select("id"), the shape
 * jobs-queue.ts uses) and alerts only when exactly one came back: updatedOne.
 *
 * ── Bounded, and cancelled ───────────────────────────────────
 *
 * The alert runs inside a worker tick with a 55 s budget and inside request
 * handlers that a recruiter or Meta is waiting on. A notification write that
 * hangs must not hold any of them, so the work is given
 * SEND_FAILURE_ALERT_TIMEOUT_MS and then abandoned. Abandoned for real, not
 * merely raced past: an AbortController's signal goes into every PostgREST
 * call (postgrest-js 2.105.0, .abortSignal()), so the requests are aborted
 * rather than left running. Every promise made here has a handler attached
 * at creation, so an abort or a late rejection can never surface as an
 * unhandled rejection.
 *
 * A LATE SIDE EFFECT is possible and harmless: if an insert had already
 * reached the server when the abort fired, aborting stops the wait but the
 * row may still land. That row has the deterministic id, so it is the same
 * bell this call was writing, not a second one. Do not "fix" this by trying
 * to roll it back.
 *
 * ── Filed: the invitation actor gap (#71A follow-up) ─────────
 *
 * Two callers of deliverEmail sit under src/lib/interviews/, which this
 * change may not touch, so they pass no actorMemberId:
 *   invite-delivery.ts:126 (sendInviteEmail). A recruiter's own invitation
 *     failure therefore also rings their bell. The wiring is InviteSender
 *     (invite-delivery.ts:29) gaining memberId, that call passing it as
 *     actorMemberId, and interview-actions.ts supplying ctx.memberId.
 *   reminder.ts:333 (the automatic reminder). No actor exists for it, so
 *     nothing is missing there; it is listed so nobody looks for a gap.
 * calendar/notify.ts:247 and :467 pass none either: its argument objects
 * carry sentByName, a display name, and no member id. It needs an
 * actorMemberId in those argument types, passed from the dashboard callers
 * (applicants/booking-actions.ts and final-interview-actions.ts, from
 * ctx.memberId); the candidate-side /api/book route has no member and
 * passes null.
 */

type Service = ReturnType<typeof createServiceClient>;

export type SendFailureInput = {
  /** The communication_logs row that was just marked failed. */
  logId: string;
  companyId: string;
  /** NULL once the applicant is deleted: no alert. */
  applicationId: string | null;
  event: string | null;
  channel: "email" | "whatsapp";
  /**
   * The member whose own action produced this failure, when there is one.
   * resolveRecipients leaves the actor out, so a recruiter who just saw the
   * error on screen gets no bell for it; an automatic send has no actor and
   * reaches every owner, admin and hiring-team member for the job.
   */
  actorMemberId?: string | null;
};

/**
 * How long the alert may take before it is abandoned. Three seconds is
 * generous for two reads and a handful of inserts, and small against the
 * worker's 55 s budget and a webhook's response time.
 */
export const SEND_FAILURE_ALERT_TIMEOUT_MS = 3_000;

/**
 * Whether an update returned exactly one row. Callers chain .select("id") on
 * the update and pass its data here; null, an empty list or two rows all read
 * as "not marked", so the bell is never rung for a change that did not happen.
 */
export function updatedOne(data: unknown): boolean {
  return Array.isArray(data) && data.length === 1;
}

/** The kind string in the bell id, so it can never collide with another bell's key. */
export const SEND_FAILURE_BELL_KIND = "send-failure-bell";

/** One bell per failure record per recipient. */
export function sendFailureBellId(logId: string, memberId: string): string {
  return deterministicUuid(`${SEND_FAILURE_BELL_KIND}:${logId}:${memberId}`);
}

/** How a stored event reads in the bell. Anything unlisted reads as its own words. */
const EVENT_LABELS: Record<string, string> = {
  interview: "interview invitation",
  interview_reminder: "interview reminder",
  application_received: "application received message",
  rejected: "rejection message",
  booking_link: "booking link",
  booking_confirmed: "booking confirmation",
  booking_rescheduled: "booking change",
  booking_cancelled: "booking cancellation",
  manual: "message",
};

function eventLabel(event: string | null): string {
  if (!event) return "message";
  return EVENT_LABELS[event] ?? event.replace(/_/g, " ");
}

/**
 * The bell's words. Exported for the test that asserts the text carries no
 * candidate data: it is the only thing the test needs to see.
 */
export function sendFailureText(input: {
  channel: "email" | "whatsapp";
  event: string | null;
  applicationId: string;
}): { title: string; body: string } {
  const what = input.channel === "whatsapp" ? "A WhatsApp message" : "An email";
  const ref = input.applicationId.slice(-6);
  return {
    title: `${what} didn't arrive`,
    body: `The ${eventLabel(input.event)} to applicant ${ref} wasn't delivered. Open the applicant to send it again.`,
  };
}

/** The alert, as it may fail or hang. Only alertSendFailure calls this. */
async function alert(
  service: Service,
  input: SendFailureInput,
  signal: AbortSignal,
): Promise<void> {
  if (!input.applicationId) return; // erased applicant: see the module comment

  /*
   * The job, for the recipient rule: with it the bell reaches the hiring team
   * of that job; without it, owners and admins only. Scoped on the company
   * the log row names, so a row cannot address another tenant's application.
   * A read that fails falls back to the narrower set rather than alerting
   * nobody.
   */
  const { data } = await service
    .from("job_applications")
    .select("job_id")
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    .abortSignal(signal)
    .maybeSingle();
  const jobId = (data as { job_id: string | null } | null)?.job_id ?? null;

  const text = sendFailureText({
    channel: input.channel,
    event: input.event,
    applicationId: input.applicationId,
  });

  /*
   * Loaded here, not at the top. deliverEmail is driven under bare node by
   * communication-log-writes.test.ts with no database client module in reach,
   * and company.ts imports @/lib/supabase/server (and through it next/headers)
   * as a value. A static import would put that module in deliverEmail's own
   * graph and break the test at load time; a lazy one keeps it in this
   * function, where a failure to load is caught like any other failure.
   */
  const { notifyCompanyOnce } = await import("./company");
  await notifyCompanyOnce(service, {
    companyId: input.companyId,
    type: "message_failed",
    title: text.title,
    body: text.body,
    jobId,
    applicationId: input.applicationId,
    actorMemberId: input.actorMemberId ?? null,
    idFor: (memberId) => sendFailureBellId(input.logId, memberId),
    signal,
  });
}

/**
 * Tell the company a message did not arrive. Never throws, returns nothing,
 * and returns within SEND_FAILURE_ALERT_TIMEOUT_MS: see "Best effort,
 * structurally" and "Bounded, and cancelled" above.
 */
export async function alertSendFailure(service: Service, input: SendFailureInput): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Resolves, never rejects. The abort is what stops the work; the resolve
    // is what lets this function return.
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timed-out");
      }, SEND_FAILURE_ALERT_TIMEOUT_MS);
    });
    // The handler is attached HERE, at creation, so a rejection after the
    // race has already been decided (an aborted request, a late failure)
    // lands in it and never in the process's unhandled-rejection path.
    const work = alert(service, input, controller.signal).then(
      () => "done" as const,
      (err) => {
        if (!controller.signal.aborted) {
          console.error("[send-failure] alert failed (non-fatal):", err);
        }
        return "failed" as const;
      },
    );
    const outcome = await Promise.race([work, timedOut]);
    if (outcome === "timed-out") {
      console.error(
        `[send-failure] alert abandoned after ${SEND_FAILURE_ALERT_TIMEOUT_MS}ms (non-fatal); a late insert, if any, is the same bell`,
      );
    }
  } catch (err) {
    console.error("[send-failure] alert failed (non-fatal):", err);
  } finally {
    clearTimeout(timer);
  }
}
