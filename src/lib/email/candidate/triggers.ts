import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import {
  REJECTION_DELAY_MS,
  STAGE_EVENTS,
  type MessageEvent,
} from "./types";

/**
 * The only place that decides whether a candidate email is enqueued.
 *
 * Callers are request paths — /api/apply and the stage-change action — so every
 * function here is NON-THROWING by contract. A queue failure must be logged and
 * swallowed: a candidate not receiving a "we got your application" mail is a
 * missing courtesy, while a failed application is a lost candidate.
 */

/** Fire-and-forget enqueue. Never throws, always logs. */
async function safeEnqueue(
  scope: string,
  input: Parameters<typeof enqueue>[0],
): Promise<void> {
  try {
    const result = await enqueue(input);
    if (!result.ok) {
      console.error(`[${scope}] enqueue failed (non-fatal):`, result.error);
    }
  } catch (err) {
    console.error(`[${scope}] enqueue threw (non-fatal):`, err);
  }
}

/** application_received — sent immediately after a successful apply. */
export async function queueApplicationReceived(
  applicationId: string,
  companyId: string | null,
): Promise<void> {
  // Remotiv-owned applications have no company whose name could carry the
  // message, so they are not part of candidate messaging at all.
  if (!companyId) return;
  await safeEnqueue("email/application_received", {
    type: JOB_TYPES.SEND_MESSAGE,
    payload: { applicationId, event: "application_received" satisfies MessageEvent },
    companyId,
  });
}

/**
 * Whether this job wants automated rejections.
 *
 * Reads the JOB's flag, not the company's. The company setting is only a seed
 * for new jobs — see seedRejectionDefault — so a company that flips its default
 * today does not retroactively start rejecting on jobs posted last month.
 */
async function jobWantsRejectionEmail(
  service: ReturnType<typeof createServiceClient>,
  jobId: string | null,
): Promise<boolean> {
  if (!jobId) return false;
  const { data } = await service
    .from("jobs")
    .select("send_rejection_email")
    .eq("id", jobId)
    .maybeSingle();
  return (data as { send_rejection_email?: boolean } | null)?.send_rejection_email === true;
}

/**
 * Stage change → the matching event.
 *
 * Which stages are live is decided entirely by STAGE_EVENTS; an unmapped stage
 * returns before anything else runs. Today only `rejected` is mapped — it is
 * scheduled two days out and gated on the job's flag. The immediate-send branch
 * below is kept intact so re-enabling a stage needs no change here.
 */
export async function queueStageChange(input: {
  applicationId: string;
  companyId: string;
  jobId: string | null;
  toStage: string;
}): Promise<void> {
  const event = STAGE_EVENTS[input.toStage];
  if (!event) return; // 'applied' and anything unmapped send nothing.

  const service = createServiceClient();

  if (event === "rejected") {
    if (!(await jobWantsRejectionEmail(service, input.jobId))) {
      // Off by default and deliberately so: an automated rejection carrying a
      // company's name is switched on knowingly, never inherited.
      return;
    }
    // Clear a tombstone from a PREVIOUS rejection that was undone. Without
    // this, rejecting → un-rejecting → rejecting again would leave the old
    // 'cancelled' row in place, the dispatcher would treat it as already
    // handled, and the second rejection would silently never send.
    //
    // Scoped to 'cancelled' only. A 'sent' or 'skipped' row is left exactly as
    // it is — that is what stops this from becoming a way to send twice.
    await clearCancelledRejection(service, input.applicationId);

    await safeEnqueue("email/rejected", {
      type: JOB_TYPES.SEND_MESSAGE,
      payload: { applicationId: input.applicationId, event },
      companyId: input.companyId,
      // THE WINDOW. Moving the candidate off Rejected before this fires
      // cancels the message — see cancelPendingRejection.
      runAfter: new Date(Date.now() + REJECTION_DELAY_MS),
    });
    return;
  }

  await safeEnqueue(`email/${event}`, {
    type: JOB_TYPES.SEND_MESSAGE,
    payload: { applicationId: input.applicationId, event },
    companyId: input.companyId,
  });
}

/**
 * Delete the 'cancelled' rejection tombstone, if one is there.
 *
 * Deleted rather than reused: the dispatcher writes its own row, and a row that
 * flipped cancelled → queued → sent would read as one message that changed its
 * mind instead of two separate decisions the company actually made.
 *
 * Non-throwing like everything else here — worst case the tombstone survives
 * and the re-rejection sends nothing, which is the quiet failure, not the loud
 * one.
 */
async function clearCancelledRejection(
  service: ReturnType<typeof createServiceClient>,
  applicationId: string,
): Promise<void> {
  try {
    await service
      .from("communication_logs")
      .delete()
      .eq("application_id", applicationId)
      .eq("event", "rejected")
      .eq("status", "cancelled");
  } catch (err) {
    console.error("[email/clear-cancelled] failed (non-fatal):", err);
  }
}

/**
 * Cancel a rejection that has not gone out yet.
 *
 * Called whenever an application moves to any stage OTHER than rejected.
 *
 * Works by claiming the log row: the dispatcher's first action is to look for a
 * log row in ('queued','sent','skipped','cancelled') and return if it finds
 * one, so writing a 'cancelled' row here means the job — which may already be
 * scheduled and will still run in two days — finds it and exits without
 * sending. No need to hunt down and delete the background_jobs row.
 *
 * If the message has ALREADY SENT there is a 'sent' row, the update below
 * matches nothing, and the candidate keeps the email they received. That is the
 * correct outcome: mail cannot be recalled, and pretending otherwise by marking
 * it cancelled would make the audit log lie.
 */
export async function cancelPendingRejection(
  applicationId: string,
  companyId: string,
): Promise<void> {
  const service = createServiceClient();
  try {
    // Claim the row if the dispatcher has not already written one.
    const { data: existing } = await service
      .from("communication_logs")
      .select("id, status")
      .eq("application_id", applicationId)
      .eq("event", "rejected")
      .maybeSingle();

    if (existing) {
      const row = existing as { id: string; status: string };
      // Only a not-yet-delivered message can be cancelled.
      if (row.status === "queued") {
        await service
          .from("communication_logs")
          .update({ status: "cancelled", error: "Candidate moved off Rejected." })
          .eq("id", row.id);
      }
      return;
    }

    // No row yet — the scheduled job has not started. Write the cancellation
    // tombstone so it exits when it does.
    await service.from("communication_logs").insert({
      company_id: companyId,
      application_id: applicationId,
      event: "rejected",
      channel: "email",
      to_address: "",
      subject: "",
      body: "",
      status: "cancelled",
      error: "Candidate moved off Rejected before the message was due.",
    });
  } catch (err) {
    console.error("[email/cancel-rejection] failed (non-fatal):", err);
  }
}

/**
 * The company's default for a NEW job's send_rejection_email.
 *
 * Read at job-creation time only. Copying the value rather than referencing it
 * is what makes a later change to the company default non-retroactive: existing
 * jobs keep whatever they were created with, and whatever they were explicitly
 * set to afterwards.
 */
export async function seedRejectionDefault(companyId: string): Promise<boolean> {
  const service = createServiceClient();
  const { data } = await service
    .from("companies")
    .select("send_rejection_email")
    .eq("id", companyId)
    .maybeSingle();
  return (data as { send_rejection_email?: boolean } | null)?.send_rejection_email === true;
}
