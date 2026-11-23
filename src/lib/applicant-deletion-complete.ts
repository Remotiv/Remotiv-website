import "server-only";

import { revalidatePath } from "next/cache";
import { actionIncomplete } from "@/app/ai-dashboard/lib/action-errors";
import {
  type CloseResult,
  closeApplicationForDeletion,
  finishApplicationDeletion,
  recordCalendarFailure,
} from "@/lib/applicant-deletion";
import { removeApplicationFiles } from "@/lib/application-files";
import { cancelScreeningBookingsForDeletion } from "@/lib/calendar/bookings";
import { removeInterviewFiles } from "@/lib/interviews/application-deletion";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import { notifyCompany, resolveHref } from "@/lib/notifications/company";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The applicant delete after its Close (#16, migration 071; #69 step 3):
 * Google, then storage, then Finish. Moved here unchanged from the applicants
 * actions, so the super-admin delete can share it next (#69 step 4).
 *
 * Its own module, not lib/applicant-deletion.ts: that one is imported by the
 * email and WhatsApp send path (deliver.ts, communication-attempt.ts) and runs
 * under bare node:test, while this needs the queue, the calendar, the
 * notifications and storage. jobs-queue already reaches applicant-deletion.ts
 * through whatsapp/dispatch.ts, so importing it there would be a cycle.
 *
 * Never a server action: this file has no "use server" directive, and
 * "server-only" keeps it out of any client bundle. The applicants actions call
 * it after their own role, company and job checks and the Close, and so does
 * the super-admin delete (#69 step 4), with the application's own company.
 */

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

/**
 * Who is deleting, for the deletion bell (#69 step 4): a company member on the
 * applicants page, or Remotiv's super admin, who belongs to no company
 * (memberId null, so no member is left out of the bell).
 */
export type DeletionActor = { companyId: string; memberName: string; memberId: string | null };

/**
 * #61, #16: Google, while connected, did not confirm an event was removed. The
 * delete has started (071's Close: every link is closed) and stops here; the
 * failure is recorded, so the panel now offers "Delete anyway" beside
 * "Finish deletion".
 */
export const DELETION_CALENDAR_PENDING =
  "Deletion started. A calendar event could not be removed yet, so it is not finished. Try again.";

/** #16: the delete has started (every link is closed) but a later step did not finish. */
const DELETION_PENDING =
  "Deletion started but is not finished yet. Their links are closed. Try again.";

/** "Delete anyway" without the recruiter's explicit acknowledgement. */
export const ANYWAY_NEEDS_ACK =
  "Confirm that the calendar event may stay in the host's Google Calendar, then try again.";

/** "Delete anyway" where no calendar failure has been recorded: the ordinary delete applies. */
export const ANYWAY_NOT_AVAILABLE =
  "Delete anyway is only available after a calendar event could not be removed. Use Delete.";

/**
 * After a delete that went ahead with a calendar event it could not reach
 * (#56): the host's Google Calendar is no longer connected, so the event, if
 * it is still there, is the recruiter's to remove.
 */
const CALENDAR_EVENT_LEFT =
  "This applicant is deleted. A calendar event for them may still be in the host's Google Calendar, because it is no longer connected to Remotiv. Please remove it there.";

/**
 * Everything after the Close, shared by the delete and "Delete anyway"; every
 * step is safe to repeat, and nothing here can reopen a link (the marker is
 * never cleared).
 *   2. Google: each event removed; a connected calendar that does not confirm
 *      stops here and is recorded (unless `anyway`); the final-round bookings'
 *      recording bots are told to stand down.
 *   3. Storage: the interviews' folders, the final-interview recordings and
 *      the CV. A file left stops here, before the row.
 *   4. FINISH (071), one transaction: the sessions, the bells, the row, and
 *      the calendar cleanups' activation.
 */
export async function completeDeletion(
  ctx: DeletionActor,
  service: ReturnType<typeof createServiceClient>,
  input: {
    applicationId: string;
    cvPath: string | null;
    jobId: string | null;
    closed: Extract<CloseResult, { outcome: "closed" }>;
    anyway: boolean;
  },
): Promise<MutationResult<{ calendarNote: string } | undefined>> {
  const { applicationId, closed } = input;

  // A cancelled final-round booking's recording bot (Recall) stands down; the
  // two-minute reconcile is the backstop if this enqueue does not land.
  for (const bookingId of closed.finalBookingIds) {
    await enqueue({
      type: JOB_TYPES.FINAL_BOT_SYNC,
      companyId: ctx.companyId,
      payload: { action: "sync", bookingId },
    });
  }

  // 2. Google, first: a calendar that does not confirm stops the delete (#61)
  //    and is recorded, which is what offers "Delete anyway" (#16).
  const bookings = await cancelScreeningBookingsForDeletion(ctx.companyId, applicationId, {
    anyway: input.anyway,
  });
  if (!bookings.ok) {
    revalidatePath("/ai-dashboard/applicants");
    if (bookings.failure === "calendar") {
      await recordCalendarFailure(service, ctx.companyId, applicationId);
      return { success: false, error: DELETION_CALENDAR_PENDING };
    }
    return { success: false, error: DELETION_PENDING };
  }

  // 3. Storage: every file, or the row stays and a retry finishes the job.
  const interviews = await removeInterviewFiles(service, closed.sessionIds);
  if (!interviews.ok) return { success: false, error: DELETION_PENDING };
  const files = await removeApplicationFiles(service, ctx.companyId, applicationId, input.cvPath);
  if (!files.ok) return { success: false, error: DELETION_PENDING };

  // 4. FINISH, one transaction. Bells go by the applicant and, for one written
  //    without a pointer (interview_expired), by the links that name them.
  const applicantHref = resolveHref({ type: "stage_change", applicationId });
  const hrefs = [
    ...(applicantHref ? [applicantHref] : []),
    ...closed.sessionIds.map((id) => interviewPageHref(id)),
  ];
  const finished = await finishApplicationDeletion(service, ctx.companyId, applicationId, hrefs);
  if (finished.outcome !== "deleted") {
    const code = finished.outcome === "error" ? finished.code : finished.outcome;
    console.error(`[applicants] delete applicant: finish failed: ${code}`);
    return { success: false, error: DELETION_PENDING };
  }

  // Names nobody (#88): the bell outlives the applicant by design, so it must
  // not carry their name, email or phone. The actor is a team member.
  await notifyCompany({
    companyId: ctx.companyId,
    type: "applicant_deleted",
    title: "An applicant was deleted",
    body: `${ctx.memberName} permanently removed them, their CV, and their interviews and recordings.`,
    jobId: input.jobId,
    actorMemberId: ctx.memberId,
  });

  revalidatePath("/ai-dashboard/applicants");
  // An event the delete could not reach is the recruiter's to remove (#56);
  // its alert was activated by Finish, in the same transaction as the row.
  if (bookings.eventsLeft) {
    return { success: true, data: { calendarNote: CALENDAR_EVENT_LEFT } };
  }
  return { success: true, data: undefined };
}

/** The interview-page link interview_expired writes; lib/interviews/expiry.ts builds it by hand. */
const interviewPageHref = (sessionId: string) => `/ai-dashboard/interviews/${sessionId}`;

/** Who the company's deletion bell names when Remotiv deletes (#69 step 4): no person, no address. */
const REMOTIV_ACTOR_NAME = "A Remotiv admin";

/**
 * A Remotiv delete's outcome. On a recorded calendar failure the dialog
 * offers "Delete anyway" (anywayAvailable); on success with an event left in
 * a disconnected calendar, calendarNote says so.
 */
export type RemotivDeleteResult =
  | { success: true; data: { calendarNote: string } | undefined }
  | { success: false; error: string; anywayAvailable?: true };

/**
 * The super admin's delete of an internal company's applicant (#69 step 4):
 * 071's Close, then completeDeletion, exactly as the company's own delete.
 *
 * Every step goes by `applicationCompany`, the company on the applicant's own
 * row, which the caller read within adminApplicationScope(): Close and Finish,
 * its calendar hosts, its files, its bell. Remotiv's admin belongs to no
 * company, so there is nothing else it could be. The bell names no person.
 */
export async function deleteForRemotiv(
  service: ReturnType<typeof createServiceClient>,
  target: {
    applicationId: string;
    applicationCompany: string;
    cvPath: string | null;
    jobId: string | null;
    anyway: boolean;
  },
  notFound: string,
): Promise<RemotivDeleteResult> {
  const companyId = target.applicationCompany;
  const closed = await closeApplicationForDeletion(service, companyId, target.applicationId);
  if (closed.outcome === "not_found") return { success: false, error: notFound };
  if (closed.outcome === "error") {
    return { success: false, error: actionIncomplete("close an applicant's links", closed.code) };
  }
  const result = await completeDeletion(
    { companyId, memberName: REMOTIV_ACTOR_NAME, memberId: null },
    service,
    {
      applicationId: target.applicationId,
      cvPath: target.cvPath,
      jobId: target.jobId,
      closed,
      anyway: target.anyway,
    },
  );
  if (!result.success && result.error === DELETION_CALENDAR_PENDING) {
    return { ...result, anywayAvailable: true };
  }
  return result;
}
