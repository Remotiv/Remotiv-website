"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import { BOOKING_EXPIRY_DAYS, bookingUrl, mintBookingToken } from "@/lib/calendar/bookings";
import "@/lib/calendar/google";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import { escapeHtml } from "@/lib/email/candidate/render";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Send a candidate a link to book their interview.
 *
 * Manual, from the applicant drawer, exactly like the video interview invite —
 * deciding someone should be interviewed is a hiring judgement and nothing
 * sends this automatically.
 *
 * Guarded the same way too: the application is re-fetched server-side, checked
 * against the company, then against the hiring team for its job. The id from
 * the client proves nothing.
 */

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

const NOT_YOURS = "Applicant not found in your workspace.";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function sendBookingLink(
  applicationId: string,
): Promise<MutationResult<{ expiresAt: string }>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /*
   * The HOST is the sender, not the company. A booking is against one
   * person's calendar, and `interview_bookings.host_member_id` is what
   * availability resolves through — so a sender with no member row cannot host.
   */
  if (!ctx.memberId) {
    return {
      success: false,
      error: "Your account has no team member record, so a calendar can't be attached to it yet.",
    };
  }

  const { data: appRow } = await service
    .from("job_applications")
    .select("id, first_name, last_name, email, job_id, company_id_snapshot, jobs(title)")
    .eq("id", applicationId)
    .maybeSingle();

  const app = appRow as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    job_id: string;
    company_id_snapshot: string | null;
    jobs?: { title: string | null } | null;
  } | null;

  if (!app || app.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: NOT_YOURS };
  }
  if (!(await canAccessJob(ctx, app.job_id))) {
    return { success: false, error: NOT_YOURS };
  }

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) return { success: false, error: "This applicant has no email address." };

  /*
   * Refuse rather than send a link to an empty page.
   *
   * A booking link whose host has no working calendar renders "we can't show
   * times right now" — honest, but a wasted email and a confused candidate.
   * The recruiter is told here instead, while they can still fix it.
   */
  const { data: connRow } = await service
    .from("calendar_connections")
    .select("status, timezone")
    .eq("member_id", ctx.memberId)
    .eq("status", "active")
    .maybeSingle();

  const conn = connRow as { status: string; timezone: string | null } | null;
  if (!conn) {
    return {
      success: false,
      error: "Connect your calendar in Settings before sending a booking link.",
    };
  }
  if (!conn.timezone) {
    return {
      success: false,
      error: "Your calendar has no timezone set. Set one in Google Calendar, then reconnect it.",
    };
  }

  // 30 unless the job says otherwise. The column is nullable and a null is a
  // choice not yet made, not a zero-length interview.
  const { data: jobRow } = await service
    .from("jobs")
    .select("title, interview_duration_minutes")
    .eq("id", app.job_id)
    .maybeSingle();
  const job = jobRow as { title: string | null; interview_duration_minutes: number | null } | null;
  const durationMinutes = job?.interview_duration_minutes === 60 ? 60 : 30;

  /*
   * One live link per application. Re-sending supersedes rather than
   * accumulating — two open links for one candidate means two ways to book the
   * same interview and no way to say which is theirs.
   *
   * A BOOKED row is never superseded. Session 3 owns reschedule; silently
   * issuing a fresh link here would let a candidate book a second slot while
   * the first is still on the recruiter's calendar.
   */
  const { data: existing } = await service
    .from("interview_bookings")
    .select("id, status")
    .eq("application_id", applicationId)
    .in("status", ["invited", "booked"])
    .order("created_at", { ascending: false })
    .limit(1);

  const live = ((existing ?? []) as { id: string; status: string }[])[0];
  if (live?.status === "booked") {
    return {
      success: false,
      error: "This candidate has already booked. Rescheduling isn't available yet.",
    };
  }
  if (live) {
    await service.from("interview_bookings").update({ status: "expired" }).eq("id", live.id);
  }

  const { rawToken, tokenHash } = mintBookingToken();
  const expiresAt = new Date(Date.now() + BOOKING_EXPIRY_DAYS * DAY_MS).toISOString();

  const { error: insertErr } = await service.from("interview_bookings").insert({
    company_id: ctx.companyId,
    application_id: applicationId,
    job_id: app.job_id,
    host_member_id: ctx.memberId,
    // Only the hash is stored. The raw token exists in the email URL and
    // nowhere else — see bookings.ts.
    token_hash: tokenHash,
    duration_minutes: durationMinutes,
    status: "invited",
    meeting_mode: "auto",
    invited_by: ctx.user.id,
    invited_by_name: ctx.memberName,
    expires_at: expiresAt,
  });

  if (insertErr) {
    console.error("[booking] invite insert failed:", insertErr.message);
    return { success: false, error: "Could not create the booking link. Try again." };
  }

  const name = (app.first_name ?? "there").trim() || "there";
  const title = job?.title ?? app.jobs?.title ?? "the role";
  const url = bookingUrl(rawToken);

  const body = `
    <p style="margin:0 0 12px;color:#17131F;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 12px;color:#4A4550;">
      We'd like to talk to you about the ${escapeHtml(title)} role. Pick a time that suits you —
      it takes about ${durationMinutes} minutes.
    </p>
    <p style="margin:20px 0;">
      <a href="${escapeHtml(url)}" style="background:#7E47FF;color:#ffffff;padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700;display:inline-block;">
        Choose your interview time
      </a>
    </p>
    <p style="margin:16px 0 0;color:#847E8C;font-size:13px;">
      Times are shown in your own timezone, and you can change it on the page if it looks wrong.
      This link works for the next ${BOOKING_EXPIRY_DAYS} days.
    </p>`;

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId,
    // An existing template event — this IS the interview step of the pipeline,
    // and a company that has customised their interview wording should not be
    // bypassed by a second, invisible event.
    event: "interview",
    to,
    subject: `Book your ${title} interview`,
    html: buildCandidateHtml(body, ctx.company.name, ctx.companyId, to),
    companyName: ctx.company.name,
    replyTo: null,
    sentByName: ctx.memberName,
  });

  if (!outcome.ok) {
    /*
     * The row exists but the email did not go. Left as 'invited' rather than
     * deleted: the link is valid, and the recruiter can copy it or re-send
     * once the cause (daily cap, unconfigured provider) is cleared. Deleting
     * would throw away a usable link to make an error message tidier.
     */
    return { success: false, error: outcome.message };
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { expiresAt } };
}
