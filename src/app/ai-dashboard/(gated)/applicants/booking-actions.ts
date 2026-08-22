"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import { normaliseInterviewDuration } from "@/app/ai-dashboard/lib/job-types";
import {
  BOOKING_EXPIRY_DAYS,
  type BookingRow,
  bookingUrl,
  canCancel,
  cancelBooking,
  canReschedule,
  mintBookingToken,
} from "@/lib/calendar/bookings";
import { sendCancellationNotices } from "@/lib/calendar/notify";
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

/** Used when a job has not chosen one. A null is undecided, not zero-length. */
const DEFAULT_INTERVIEW_MINUTES = 30;
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

  const { data: jobRow } = await service
    .from("jobs")
    .select("title, interview_duration_minutes")
    .eq("id", app.job_id)
    .maybeSingle();
  const job = jobRow as { title: string | null; interview_duration_minutes: number | null } | null;

  /*
   * Whatever the job says, defaulting to 30 only when it says nothing.
   *
   * This used to read `=== 60 ? 60 : 30`, which silently rewrote every other
   * value to 30 — a 45-minute interview would have been booked as a 30-minute
   * one, on the candidate's page and in the recruiter's calendar, with nothing
   * anywhere saying why. Validated rather than trusted: the row is the source
   * of truth but it is still a number arriving from the database, and
   * interview_bookings.duration_minutes carries its own CHECK.
   */
  const durationMinutes =
    normaliseInterviewDuration(job?.interview_duration_minutes) ?? DEFAULT_INTERVIEW_MINUTES;

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

  const { data: createdRow, error: insertErr } = await service
    .from("interview_bookings")
    .insert({
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
    })
    .select("id")
    .single();

  if (insertErr) {
    console.error("[booking] invite insert failed:", insertErr.message);
    return { success: false, error: "Could not create the booking link. Try again." };
  }

  const bookingId = (createdRow as { id: string } | null)?.id ?? null;

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
    /*
     * Its OWN event, not "interview".
     *
     * communication_logs carries a UNIQUE constraint on
     * (application_id, event, channel). Reusing "interview" meant a candidate
     * who had already been sent a video-interview invitation could never be
     * sent a booking link — the insert violated the constraint, and because
     * deliverEmail used to throw on that, the recruiter saw only
     * "Couldn't send — please try again."
     *
     * The two messages sit at the same pipeline stage but are not the same
     * message, so they get different values. It is LOG-ONLY: composed here
     * rather than from message_templates, and must not reach
     * message_templates_event_check.
     */
    event: "booking_link",
    to,
    subject: `Book your ${title} interview`,
    html: buildCandidateHtml(body, ctx.company.name, ctx.companyId, to),
    companyName: ctx.company.name,
    replyTo: null,
    sentByName: ctx.memberName,
  });

  if (!outcome.ok) {
    /*
     * ROLL THE BOOKING BACK.
     *
     * The row was written before the email was attempted, so a failed send
     * leaves an `invited` booking holding a live token that nobody received —
     * an orphan. It shows in the pipeline as an outstanding invitation, it
     * suppresses nothing and unblocks nothing, and the only way anyone could
     * use it would be to dig the raw token out of a log it was never written
     * to. There is exactly one of these in the database right now, from the
     * bug this change fixes.
     *
     * An earlier version kept it, reasoning that the link was still valid and
     * the recruiter could re-send once the cause cleared. That was wrong on
     * both counts: nothing surfaces the raw token to copy, and a re-send mints
     * a fresh row anyway, so keeping it only accumulated dead invitations.
     *
     * Deleted rather than marked `expired` because it never existed as far as
     * anyone outside this function is concerned — no email, no candidate, no
     * history worth keeping.
     */
    if (bookingId) {
      const { error: cleanupErr } = await service
        .from("interview_bookings")
        .delete()
        .eq("id", bookingId)
        // Only ever removes the row THIS call created and only while it is
        // still untouched — a candidate cannot have booked it, but the guard
        // costs nothing and makes that impossible rather than merely unlikely.
        .eq("status", "invited");
      if (cleanupErr) {
        console.error("[booking] failed to roll back the orphan booking:", cleanupErr.message);
      }
    }
    return { success: false, error: outcome.message };
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { expiresAt } };
}

/* ──────────────── the recruiter's side of session 3 ─────────── */

export type BookingPanel = {
  status: string;
  scheduledStart: string | null;
  hostTimezone: string | null;
  candidateTimezone: string | null;
  meetingUrl: string | null;
  durationMinutes: number;
  canReschedule: boolean;
  canCancel: boolean;
  cancelledBy: string | null;
  cancelReason: string | null;
} | null;

/** What the drawer needs to render the booking. Never a token. */
export async function fetchBookingPanel(applicationId: string): Promise<BookingPanel> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("interview_bookings")
    .select(
      "status, scheduled_start, host_timezone, candidate_timezone, meeting_url, duration_minutes, cancelled_by, cancel_reason, company_id, job_id, host_member_id, id, application_id, scheduled_end, meeting_mode, provider_event_id, provider, expires_at, cancelled_at",
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .in("status", ["invited", "booked", "cancelled"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as BookingRow | null;
  if (!row) return null;
  if (!(await canAccessJob(ctx, row.job_id))) return null;

  return {
    status: row.status,
    scheduledStart: row.scheduled_start,
    hostTimezone: row.host_timezone,
    candidateTimezone: row.candidate_timezone,
    meetingUrl: row.meeting_url,
    durationMinutes: row.duration_minutes,
    // Server-decided, exactly as on the candidate's page.
    canReschedule: canReschedule(row),
    canCancel: canCancel(row),
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
  };
}

/**
 * Cancel from the drawer.
 *
 * The recruiter cannot pick a new time here — a reschedule is the CANDIDATE's
 * choice of slot, and a recruiter silently moving someone into a time they
 * never agreed to is not a reschedule, it is a new appointment. What the
 * recruiter can do is cancel and send a fresh link, which is two deliberate
 * acts rather than one invisible one.
 */
export async function cancelBookingAsRecruiter(
  applicationId: string,
  reason?: string,
): Promise<MutationResult<{ removedFromCalendar: boolean }>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("interview_bookings")
    .select(
      "id, company_id, application_id, job_id, host_member_id, duration_minutes, status, scheduled_start, scheduled_end, candidate_timezone, host_timezone, meeting_mode, meeting_url, provider_event_id, provider, expires_at, cancelled_at, cancelled_by, cancel_reason",
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .eq("status", "booked")
    .maybeSingle();

  const row = data as BookingRow | null;
  if (!row) return { success: false, error: "There's no booked interview to cancel." };
  if (!(await canAccessJob(ctx, row.job_id))) return { success: false, error: NOT_YOURS };
  if (!canCancel(row)) {
    return { success: false, error: "This interview has already started or passed." };
  }

  const cancelled = await cancelBooking({ row, cancelledBy: "recruiter", reason: reason ?? null });
  if (!cancelled.ok) {
    return { success: false, error: "Could not cancel. Try again." };
  }

  const { data: appRow } = await service
    .from("job_applications")
    .select("first_name, last_name, email, jobs(title)")
    .eq("id", applicationId)
    .maybeSingle();
  const app = appRow as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    jobs?: { title: string | null } | null;
  } | null;

  const { data: memberRow } = await service
    .from("company_members")
    .select("name, email")
    .eq("id", row.host_member_id)
    .maybeSingle();
  const host = memberRow as { name: string | null; email: string | null } | null;

  await sendCancellationNotices({
    row: cancelled.row,
    startMs: Date.parse(row.scheduled_start ?? ""),
    cancelledBy: "recruiter",
    reason: cancelled.row.cancel_reason,
    removedFromCalendar: cancelled.removedFromCalendar,
    hostTimezone: row.host_timezone ?? "UTC",
    candidateTimezone: row.candidate_timezone ?? row.host_timezone ?? "UTC",
    candidateEmail: app?.email ?? null,
    candidateName: [app?.first_name, app?.last_name].filter(Boolean).join(" ").trim() || "there",
    hostEmail: host?.email ?? null,
    hostName: host?.name ?? ctx.memberName,
    jobTitle: app?.jobs?.title ?? "Interview",
    companyName: ctx.company.name,
    meetingUrl: null,
  });

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { removedFromCalendar: cancelled.removedFromCalendar } };
}
