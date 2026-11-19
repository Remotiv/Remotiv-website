"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canManageBookings } from "@/app/ai-dashboard/lib/company-roles";
import { roleAllowsJobAction } from "@/app/ai-dashboard/lib/job-scope";
import { cancellationCandidateEmail } from "@/lib/calendar/notify";
import { buildCandidateHtml, resendFailedEmail } from "@/lib/email/candidate/deliver";
import { interviewTypeLabel } from "@/lib/final-interviews/constants";
import { createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions. The Retry for a
// cancellation's candidate email, screening call or final round alike (#59):
// its own module, so booking-actions.ts stays the screening path only.

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

const NOT_YOURS = "Applicant not found in your workspace.";
const NOT_A_BOOKING_ROLE =
  "Only an owner, admin or recruiter can send or cancel interview booking links.";

const NOTHING_TO_RESEND = "There is no cancellation email to resend.";

/** Why the claim refused a Retry, in the canceller's words. */
function notRetriedMessage(reason: "wrong_status" | "too_old" | "missing"): string {
  if (reason === "too_old") {
    return "This email is more than a day old, so it can no longer be resent safely. Contact the candidate directly.";
  }
  if (reason === "missing") return NOTHING_TO_RESEND;
  // Unknown outcome (its first send never answered) or claimed a moment ago.
  return NOT_CONFIRMED;
}
const NOT_CONFIRMED = "We couldn't confirm the first email, so it was not sent again.";

/**
 * Retry the candidate's cancellation email (#59), screening call or final
 * round. Sends at most once, ever, for one cancellation:
 *   - the email's row is CLAIMED by id (migration 067): only a failed row,
 *     one Retry at a time; a send whose outcome is unknown is never retried;
 *   - the email is rebuilt by the first send's own builder from the same
 *     facts (the cancelled booking, the row's address and sender name), and
 *     sent with the first send's idempotency key: if the first one did reach
 *     Resend, or the email changed meanwhile, Resend sends nothing.
 * Scope first, as the cancel does: another job's applicant gets NOT_YOURS.
 */
export async function retryCancellationNotice(input: {
  bookingId: string;
  logId: string;
}): Promise<MutationResult<{ alreadySent: boolean }>> {
  const ctx = await getCompanyContext();
  if (!canManageBookings(ctx.role)) return { success: false, error: NOT_A_BOOKING_ROLE };
  const service = createServiceClient();

  const { data: bookingData } = await service
    .from("interview_bookings")
    .select(
      "id, company_id, application_id, status, cancelled_by, cancel_reason, scheduled_start, candidate_timezone, host_timezone, final_interview_id",
    )
    .eq("id", input.bookingId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const booking = bookingData as {
    id: string;
    company_id: string;
    application_id: string | null;
    status: string;
    cancelled_by: string | null;
    cancel_reason: string | null;
    scheduled_start: string | null;
    candidate_timezone: string | null;
    host_timezone: string | null;
    final_interview_id: string | null;
  } | null;
  if (!booking?.application_id) return { success: false, error: NOT_YOURS };

  const { data: appData } = await service
    .from("job_applications")
    .select("job_id, first_name, last_name, jobs(title)")
    .eq("id", booking.application_id)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();
  const app = appData as {
    job_id: string | null;
    first_name: string | null;
    last_name: string | null;
    jobs?: { title: string | null } | null;
  } | null;
  if (!app || !(await roleAllowsJobAction(ctx, app.job_id ?? ""))) {
    return { success: false, error: NOT_YOURS };
  }
  if (booking.status !== "cancelled" || booking.cancelled_by !== "recruiter") {
    return { success: false, error: NOTHING_TO_RESEND };
  }

  const { data: logData } = await service
    .from("communication_logs")
    .select("id, application_id, event, channel, to_address, sent_by_name, status")
    .eq("id", input.logId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const log = logData as {
    application_id: string | null;
    event: string;
    channel: string;
    to_address: string;
    sent_by_name: string | null;
    status: string;
  } | null;
  if (
    !log ||
    log.application_id !== booking.application_id ||
    log.event !== "booking_cancelled" ||
    log.channel !== "email"
  ) {
    return { success: false, error: NOTHING_TO_RESEND };
  }
  if (log.status === "sent") return { success: true, data: { alreadySent: true } };

  let interviewLabel: string | null = null;
  if (booking.final_interview_id) {
    const { data: fiData } = await service
      .from("final_interviews")
      .select("interview_type, custom_label")
      .eq("id", booking.final_interview_id)
      .eq("company_id", ctx.companyId)
      .maybeSingle();
    const fi = fiData as { interview_type: string; custom_label: string | null } | null;
    if (!fi) return { success: false, error: NOTHING_TO_RESEND };
    interviewLabel = interviewTypeLabel(fi.interview_type, fi.custom_label);
  }

  const email = cancellationCandidateEmail({
    startMs: Date.parse(booking.scheduled_start ?? ""),
    candidateTimezone: booking.candidate_timezone ?? booking.host_timezone ?? "UTC",
    candidateName: [app.first_name, app.last_name].filter(Boolean).join(" ").trim() || "there",
    hostName: log.sent_by_name ?? "",
    companyName: ctx.company.name,
    jobTitle: app.jobs?.title ?? "Interview",
    interviewLabel,
    cancelledBy: "recruiter",
    reason: booking.cancel_reason,
    candidateEmail: log.to_address,
  });
  const outcome = await resendFailedEmail(service, {
    logId: input.logId,
    companyId: ctx.companyId,
    to: log.to_address,
    subject: email.subject,
    html: buildCandidateHtml(email.body, ctx.company.name, booking.company_id, log.to_address),
    companyName: ctx.company.name,
    replyTo: null,
  });

  switch (outcome.kind) {
    case "sent":
      revalidatePath("/ai-dashboard/applicants");
      return { success: true, data: { alreadySent: false } };
    case "mismatch":
      return { success: false, error: NOT_CONFIRMED };
    case "not_retried":
      return { success: false, error: notRetriedMessage(outcome.reason) };
    case "cap":
      return {
        success: false,
        error: "Remotiv's daily email limit has been reached. Try again tomorrow.",
      };
    default:
      return { success: false, error: "The email could not be sent. Try again." };
  }
}
