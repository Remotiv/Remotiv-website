"use server";

import { revalidatePath } from "next/cache";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { type CompanyContext, canManageBookings } from "@/app/ai-dashboard/lib/company-roles";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import {
  BOOKING_ROW_COLUMNS,
  type BookingRow,
  bookingUrl,
  canCancel,
  cancelBooking,
  createBookingLink,
  isExpired,
  resolveHostEmail,
} from "@/lib/calendar/bookings";
import "@/lib/calendar/google";
import { sendCancellationNotices, sendFinalInterviewLinkEmail } from "@/lib/calendar/notify";
import { onFinalBookingCancelled } from "@/lib/final-interviews/bots";
import {
  CUSTOM_LABEL_MAX,
  DEFAULT_FINAL_DURATION,
  deriveRecordingSummary,
  FINAL_DURATIONS,
  FINAL_RECORDING_BUCKET,
  FINAL_RECORDING_PLAYBACK_TTL_SECONDS,
  HOST_NEEDS_CALENDAR,
  INTERVIEW_TYPE_LABELS,
  INTERVIEW_TYPES,
  type InterviewType,
  interviewTypeLabel,
  isFinalDuration,
  isInterviewType,
  MAX_EXTRA_INTERVIEWERS,
  NOT_A_BOOKING_ROLE,
  RECORDING_UNAVAILABLE,
  type RecordingBotFacts,
  type RecordingRowFacts,
} from "@/lib/final-interviews/constants";
import {
  isEligibleHost,
  loadEligibleMembers,
  pickInterviewers,
} from "@/lib/final-interviews/eligibility";
import type {
  FinalInterviewBookingState,
  FinalInterviewOptions,
  FinalInterviewView,
  ScheduleFinalInterviewInput,
} from "@/lib/final-interviews/types";
import { notifyCompany } from "@/lib/notifications/company";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Final Human Interview: scheduling, from the recruiter's side.
 *
 * Every action resolves the company context first, then (for a write) the
 * account role through canManageBookings, then the job through canAccessJob,
 * then validates its input, and only then touches anything. A hiring manager
 * can read what is scheduled and never create, resend or cancel it.
 *
 * The booking itself is the existing booking flow with purpose 'final': the
 * same token, expiry, availability, claim and calendar event, on the chosen
 * HOST's calendar rather than the sender's. Nothing here moves a pipeline
 * stage, and nothing ever will from this file.
 */

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

const NOT_YOURS = "Applicant not found in your workspace.";
const NOT_FOUND = "Final interview not found in your workspace.";

type Service = ReturnType<typeof createServiceClient>;

type ApplicationRow = {
  id: string;
  job_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_id_snapshot: string | null;
  jobs?: { title: string | null } | null;
};

type FinalInterviewRow = {
  id: string;
  company_id: string;
  job_id: string;
  application_id: string;
  interview_type: string;
  custom_label: string | null;
  host_member_id: string;
  status: "active" | "completed" | "no_show" | "cancelled";
  created_by_name: string | null;
  created_at: string;
  cancelled_at: string | null;
};

const FI_COLUMNS =
  "id, company_id, job_id, application_id, interview_type, custom_label, host_member_id, status, created_by_name, created_at, cancelled_at";

/** The bot columns the card's recording status is derived from (recording step 5). */
const RECORDING_BOT_COLUMNS =
  "final_interview_id, booking_id, status, join_at, import_status, last_event_code, last_event_sub_code, last_event_at, provider_recording_id, superseded_at";
/** Recording rows, any status, for the list. Deliberately no storage_path: playback reads that. */
const RECORDING_ROW_COLUMNS =
  "id, final_interview_id, source, vendor_recording_id, status, uploaded_at, created_at, deleted_by";

/* ── guards ─────────────────────────────────────────────────────── */

/** The application, re-fetched and checked against the company and the job. */
async function gateApplication(
  ctx: CompanyContext,
  service: Service,
  applicationId: string,
): Promise<{ ok: true; app: ApplicationRow; jobId: string } | { ok: false; error: string }> {
  const { data } = await service
    .from("job_applications")
    .select("id, job_id, first_name, last_name, email, company_id_snapshot, jobs(title)")
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();
  const app = data as unknown as ApplicationRow | null;
  // Not-found and not-yours answer alike, so an id proves nothing.
  if (!app?.job_id) return { ok: false, error: NOT_YOURS };
  if (!(await canAccessJob(ctx, app.job_id))) return { ok: false, error: NOT_YOURS };
  return { ok: true, app, jobId: app.job_id };
}

/** One final interview, checked the same way. */
async function gateFinalInterview(
  ctx: CompanyContext,
  service: Service,
  finalInterviewId: string,
): Promise<{ ok: true; fi: FinalInterviewRow } | { ok: false; error: string }> {
  const { data } = await service
    .from("final_interviews")
    .select(FI_COLUMNS)
    .eq("id", finalInterviewId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const fi = data as FinalInterviewRow | null;
  if (!fi) return { ok: false, error: NOT_FOUND };
  if (!(await canAccessJob(ctx, fi.job_id))) return { ok: false, error: NOT_FOUND };
  return { ok: true, fi };
}

/** The newest booking for one final interview, whatever its status. */
async function latestBooking(
  service: Service,
  companyId: string,
  finalInterviewId: string,
): Promise<BookingRow | null> {
  const { data } = await service
    .from("interview_bookings")
    .select(BOOKING_ROW_COLUMNS)
    .eq("company_id", companyId)
    .eq("purpose", "final")
    .eq("final_interview_id", finalInterviewId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as BookingRow | null) ?? null;
}

function bookingState(row: BookingRow | null): FinalInterviewBookingState {
  if (!row) return "not_sent";
  if (row.status === "booked") return "booked";
  if (row.status === "cancelled") return "booking_cancelled";
  if (row.status === "expired" || isExpired(row)) return "expired";
  return "invited";
}

/* ── reads ──────────────────────────────────────────────────────── */

/**
 * What the scheduling form offers: who may host (with the calendar flag, so
 * the form can say why someone is greyed out), who may join, and the fixed
 * types and durations. Anyone who can view the candidate may read this.
 */
export async function getFinalInterviewOptions(
  applicationId: string,
): Promise<MutationResult<FinalInterviewOptions>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const gate = await gateApplication(ctx, service, applicationId);
  if (!gate.ok) return { success: false, error: gate.error };

  try {
    const members = await loadEligibleMembers(service, ctx.companyId, gate.jobId);
    return {
      success: true,
      data: {
        hosts: members,
        interviewers: members,
        types: INTERVIEW_TYPES.map((value) => ({
          value,
          label: value === "custom" ? null : INTERVIEW_TYPE_LABELS[value],
        })),
        durations: FINAL_DURATIONS,
        defaultDuration: DEFAULT_FINAL_DURATION,
        maxExtraInterviewers: MAX_EXTRA_INTERVIEWERS,
      },
    };
  } catch (err) {
    console.error("[final-interview] options read failed:", err);
    return { success: false, error: "Couldn't load who can take part. Try again." };
  }
}

/** Every final interview for this applicant, newest first, with its booking. */
export async function listFinalInterviews(
  applicationId: string,
): Promise<MutationResult<FinalInterviewView[]>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const gate = await gateApplication(ctx, service, applicationId);
  if (!gate.ok) return { success: false, error: gate.error };

  const { data: rows, error } = await service
    .from("final_interviews")
    .select(FI_COLUMNS)
    .eq("company_id", ctx.companyId)
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[final-interview] list failed:", error.message);
    return { success: false, error: "Couldn't load the final interviews. Try again." };
  }
  const interviews = (rows ?? []) as FinalInterviewRow[];
  if (interviews.length === 0) return { success: true, data: [] };
  const ids = interviews.map((fi) => fi.id);

  // One read per table for every interview on the card, all company-filtered:
  // the recording facts never cost a query per row.
  const [{ data: bookings, error: bookingsErr }, { data: extra }, botsRes, recordingsRes] =
    await Promise.all([
      service
        .from("interview_bookings")
        .select(BOOKING_ROW_COLUMNS)
        .eq("company_id", ctx.companyId)
        .eq("purpose", "final")
        .in("final_interview_id", ids)
        .order("created_at", { ascending: false }),
      service
        .from("final_interview_interviewers")
        .select("final_interview_id, member_id")
        .eq("company_id", ctx.companyId)
        .in("final_interview_id", ids),
      service
        .from("final_interview_bots")
        .select(RECORDING_BOT_COLUMNS)
        .eq("company_id", ctx.companyId)
        .in("final_interview_id", ids),
      service
        .from("final_interview_recordings")
        .select(RECORDING_ROW_COLUMNS)
        .eq("company_id", ctx.companyId)
        .in("final_interview_id", ids),
    ]);
  // A failed read is never shown as "no recording": the card says it could not tell.
  const recordingReadFailed = Boolean(bookingsErr || botsRes.error || recordingsRes.error);
  if (recordingReadFailed) {
    console.error(
      `[final-interview] recording status read failed (${bookingsErr?.code ?? botsRes.error?.code ?? recordingsRes.error?.code ?? "db"})`,
    );
  }
  const botsByInterview = new Map<string, RecordingBotFacts[]>();
  for (const b of (botsRes.data ?? []) as (RecordingBotFacts & { final_interview_id: string })[]) {
    botsByInterview.set(b.final_interview_id, [
      ...(botsByInterview.get(b.final_interview_id) ?? []),
      b,
    ]);
  }
  const recordingsByInterview = new Map<string, RecordingRowFacts[]>();
  for (const r of (recordingsRes.data ?? []) as (RecordingRowFacts & {
    final_interview_id: string;
  })[]) {
    recordingsByInterview.set(r.final_interview_id, [
      ...(recordingsByInterview.get(r.final_interview_id) ?? []),
      r,
    ]);
  }
  const bookingStarts = new Map<string, string | null>(
    ((bookings ?? []) as BookingRow[]).map((b) => [b.id, b.scheduled_start ?? null]),
  );
  const nowMs = Date.now();

  // Newest booking per interview: the list is already newest first.
  const latest = new Map<string, BookingRow>();
  for (const b of (bookings ?? []) as BookingRow[]) {
    if (b.final_interview_id && !latest.has(b.final_interview_id))
      latest.set(b.final_interview_id, b);
  }
  const extraByInterview = new Map<string, string[]>();
  for (const r of (extra ?? []) as { final_interview_id: string; member_id: string }[]) {
    extraByInterview.set(r.final_interview_id, [
      ...(extraByInterview.get(r.final_interview_id) ?? []),
      r.member_id,
    ]);
  }

  const memberIds = [
    ...new Set([
      ...interviews.map((fi) => fi.host_member_id),
      ...[...extraByInterview.values()].flat(),
    ]),
  ];
  const { data: memberRows } = await service
    .from("company_members")
    .select("id, name, email, role")
    .eq("company_id", ctx.companyId)
    .in("id", memberIds);
  const names = new Map<string, string>();
  for (const m of (memberRows ?? []) as {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
  }[]) {
    // company_members.name and .email are null for every owner; the company's
    // contact name is the owner's.
    names.set(
      m.id,
      m.name?.trim() ||
        m.email?.trim() ||
        (m.role === "owner" ? ctx.company.contact_name?.trim() : "") ||
        "Team member",
    );
  }
  const named = (memberId: string) => ({ memberId, name: names.get(memberId) ?? "Team member" });

  return {
    success: true,
    data: interviews.map((fi) => {
      const booking = latest.get(fi.id) ?? null;
      return {
        id: fi.id,
        interviewType: fi.interview_type as InterviewType,
        label: interviewTypeLabel(fi.interview_type, fi.custom_label),
        status: fi.status,
        host: named(fi.host_member_id),
        interviewers: (extraByInterview.get(fi.id) ?? []).map(named),
        createdByName: fi.created_by_name,
        createdAt: fi.created_at,
        cancelledAt: fi.cancelled_at,
        booking: {
          state: bookingState(booking),
          durationMinutes: booking?.duration_minutes ?? DEFAULT_FINAL_DURATION,
          expiresAt: booking?.expires_at ?? null,
          scheduledStart: booking?.scheduled_start ?? null,
          scheduledEnd: booking?.scheduled_end ?? null,
          hostTimezone: booking?.host_timezone ?? null,
          candidateTimezone: booking?.candidate_timezone ?? null,
          meetingUrl: booking?.meeting_url ?? null,
          canCancel: booking ? canCancel(booking) : false,
          cancelledBy: booking?.cancelled_by ?? null,
          cancelReason: booking?.cancel_reason ?? null,
        },
        recording: recordingReadFailed
          ? RECORDING_UNAVAILABLE
          : deriveRecordingSummary({
              currentBookingId: booking?.id ?? null,
              bots: botsByInterview.get(fi.id) ?? [],
              recordings: recordingsByInterview.get(fi.id) ?? [],
              bookingStarts,
              nowMs,
            }),
      };
    }),
  };
}

/* ── recording playback (recording step 5) ──────────────────────── */

const NO_RECORDING = "Recording not found in your workspace.";

/**
 * A signed URL to watch one ready recording, minted only when Watch is
 * pressed. Anyone who may view the candidate may watch: owner, admin,
 * recruiter or a hiring manager on the job.
 *
 * Every link is checked on the server, from the recording outwards:
 *
 *   recording      this company's, by id
 *   job access     canAccessJob on the recording's job, checked once here
 *   interview      this company's, and on the same job and application
 *   application    this company's (company_id_snapshot), on the same job
 *   ready          status 'ready' with a storage path
 *
 * storage_path is read here and never returned. The signed URL itself carries
 * the object key, {company_id}/{final_interview_id}/{recording_id}.mp4: ids
 * only, no names or emails. The URL lives three hours so a long interview
 * stays seekable. Each grant is written to signed_url_logs like the
 * interview-answer and CV grants; a failed log write never blocks a grant.
 */
export async function getFinalRecordingPlayback(
  recordingId: string,
): Promise<MutationResult<{ url: string; expiresAt: string }>> {
  if (typeof recordingId !== "string" || !recordingId || recordingId.length > 100) {
    return { success: false, error: NO_RECORDING };
  }
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data: recData, error: recErr } = await service
    .from("final_interview_recordings")
    .select("id, final_interview_id, job_id, application_id, status, storage_path")
    .eq("id", recordingId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (recErr) {
    console.error(`[final-interview] recording read failed (${recErr.code ?? "db"})`);
    return { success: false, error: "Couldn't load that recording. Try again." };
  }
  const rec = recData as {
    id: string;
    final_interview_id: string;
    job_id: string;
    application_id: string;
    status: string;
    storage_path: string | null;
  } | null;
  if (!rec) return { success: false, error: NO_RECORDING };

  if (!(await canAccessJob(ctx, rec.job_id))) return { success: false, error: NO_RECORDING };

  const [{ data: fiData }, { data: appData }] = await Promise.all([
    service
      .from("final_interviews")
      .select("id, job_id, application_id")
      .eq("id", rec.final_interview_id)
      .eq("company_id", ctx.companyId)
      .maybeSingle(),
    service
      .from("job_applications")
      .select("id, job_id")
      .eq("id", rec.application_id)
      .eq("company_id_snapshot", ctx.companyId)
      .maybeSingle(),
  ]);
  const fi = fiData as { job_id: string; application_id: string } | null;
  const app = appData as { job_id: string | null } | null;
  if (
    !fi ||
    !app ||
    fi.job_id !== rec.job_id ||
    fi.application_id !== rec.application_id ||
    app.job_id !== rec.job_id
  ) {
    return { success: false, error: NO_RECORDING };
  }

  if (rec.status !== "ready" || !rec.storage_path) {
    return { success: false, error: "This recording isn't ready to watch." };
  }

  const { data: signed, error: signErr } = await service.storage
    .from(FINAL_RECORDING_BUCKET)
    .createSignedUrl(rec.storage_path, FINAL_RECORDING_PLAYBACK_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    console.error("[final-interview] recording playback sign failed");
    return { success: false, error: "Couldn't load that recording. Try again." };
  }

  const { error: logErr } = await service.from("signed_url_logs").insert({
    user_id: ctx.user.id,
    // The application id, as the CV and interview-answer grants record it.
    candidate_id: rec.application_id,
    source_table: "final_interview_recordings",
    was_admin: false,
  });
  if (logErr) console.error(`[signed_url_logs insert] (${logErr.code ?? "db"})`);

  return {
    success: true,
    data: {
      url: signed.signedUrl,
      expiresAt: new Date(Date.now() + FINAL_RECORDING_PLAYBACK_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

/* ── the link ───────────────────────────────────────────────────── */

/**
 * Mint and email a final-round link for one interview. Shared by schedule and
 * resend, so both check the host's calendar the same way and both roll back an
 * unsent link the same way.
 */
async function sendLink(
  ctx: CompanyContext,
  service: Service,
  fi: FinalInterviewRow,
  app: ApplicationRow,
  durationMinutes: number,
): Promise<MutationResult<{ finalInterviewId: string; expiresAt: string }>> {
  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) return { success: false, error: "This applicant has no email address." };

  // The host's calendar is checked at every send, not only at creation: a
  // disconnected calendar renders an empty booking page, so the sender is told
  // now, while they can fix it.
  const members = await loadEligibleMembers(service, ctx.companyId, fi.job_id);
  if (!isEligibleHost(members, fi.host_member_id)) {
    return { success: false, error: HOST_NEEDS_CALENDAR };
  }

  const created = await createBookingLink({
    purpose: "final",
    companyId: ctx.companyId,
    applicationId: fi.application_id,
    jobId: fi.job_id,
    hostMemberId: fi.host_member_id,
    invitedBy: ctx.user.id,
    invitedByName: ctx.memberName,
    durationMinutes,
    finalInterviewId: fi.id,
  });
  if (!created.ok) {
    return created.reason === "already_booked"
      ? {
          success: false,
          error: "The candidate has already booked this interview. Cancel it to send a new link.",
        }
      : { success: false, error: "Could not create the booking link. Try again." };
  }

  const host = members.find((m) => m.memberId === fi.host_member_id);
  const sent = await sendFinalInterviewLinkEmail({
    companyId: ctx.companyId,
    applicationId: fi.application_id,
    to,
    candidateFirstName: (app.first_name ?? "").trim(),
    interviewLabel: interviewTypeLabel(fi.interview_type, fi.custom_label),
    jobTitle: (app.jobs?.title ?? "").trim() || "the role",
    companyName: ctx.company.name,
    durationMinutes,
    url: bookingUrl(created.rawToken),
    sentByName: host?.name ?? ctx.memberName,
  });
  if (!sent.ok) {
    // Same rule as the screening link: a link nobody received is deleted, not
    // left as a live token. Only this call's row, and only while untouched.
    await service
      .from("interview_bookings")
      .delete()
      .eq("id", created.bookingId)
      .eq("status", "invited");
    return { success: false, error: sent.message };
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { finalInterviewId: fi.id, expiresAt: created.expiresAt } };
}

/* ── writes ─────────────────────────────────────────────────────── */

export async function scheduleFinalInterview(
  input: ScheduleFinalInterviewInput,
): Promise<MutationResult<{ finalInterviewId: string; expiresAt: string }>> {
  const ctx = await getCompanyContext();
  if (!canManageBookings(ctx.role)) return { success: false, error: NOT_A_BOOKING_ROLE };
  const service = createServiceClient();

  const gate = await gateApplication(ctx, service, input.applicationId);
  if (!gate.ok) return { success: false, error: gate.error };
  const { app, jobId } = gate;

  // ── Input, before any read of who may take part ──
  if (!isInterviewType(input.interviewType)) {
    return { success: false, error: "Choose an interview type." };
  }
  const customLabel = (input.customLabel ?? "").trim();
  if (input.interviewType === "custom") {
    if (customLabel.length < 1 || customLabel.length > CUSTOM_LABEL_MAX) {
      return {
        success: false,
        error: `Give the custom interview a name (1 to ${CUSTOM_LABEL_MAX} characters).`,
      };
    }
  } else if (customLabel) {
    return { success: false, error: "Only a custom interview takes a name." };
  }
  const durationMinutes = input.durationMinutes ?? DEFAULT_FINAL_DURATION;
  if (!isFinalDuration(durationMinutes)) {
    return { success: false, error: "Final interviews are 30, 45 or 60 minutes." };
  }
  const hostMemberId = String(input.hostMemberId ?? "").trim();
  if (!hostMemberId) return { success: false, error: "Choose who will host the interview." };

  // ── Who may take part ──
  let members: Awaited<ReturnType<typeof loadEligibleMembers>>;
  try {
    members = await loadEligibleMembers(service, ctx.companyId, jobId);
  } catch (err) {
    console.error("[final-interview] eligibility read failed:", err);
    return { success: false, error: "Couldn't check who can take part. Try again." };
  }
  const host = members.find((m) => m.memberId === hostMemberId);
  if (!host) {
    return {
      success: false,
      error: "The host must be an active member of this job's hiring team, or an owner or admin.",
    };
  }
  if (!host.calendarConnected) return { success: false, error: HOST_NEEDS_CALENDAR };
  const picked = pickInterviewers(members, input.interviewerMemberIds, hostMemberId);
  if (!picked.ok) return { success: false, error: picked.error };

  // ── The rows ──
  const { data: created, error: insertErr } = await service
    .from("final_interviews")
    .insert({
      company_id: ctx.companyId,
      job_id: jobId,
      application_id: app.id,
      interview_type: input.interviewType,
      custom_label: input.interviewType === "custom" ? customLabel : null,
      host_member_id: hostMemberId,
      status: "active",
      created_by: ctx.user.id,
      created_by_name: ctx.memberName,
    })
    .select(FI_COLUMNS)
    .single();
  if (insertErr || !created) {
    console.error("[final-interview] insert failed:", insertErr?.message);
    return { success: false, error: "Couldn't create the final interview. Try again." };
  }
  const fi = created as FinalInterviewRow;

  if (picked.memberIds.length > 0) {
    const { error: extraErr } = await service.from("final_interview_interviewers").insert(
      picked.memberIds.map((memberId) => ({
        final_interview_id: fi.id,
        company_id: ctx.companyId,
        member_id: memberId,
        added_by: ctx.user.id,
      })),
    );
    if (extraErr) {
      // Half an interview is worse than none: nothing has been sent yet, so
      // the row goes and the recruiter tries again.
      console.error("[final-interview] interviewers insert failed:", extraErr.message);
      await service
        .from("final_interviews")
        .delete()
        .eq("id", fi.id)
        .eq("company_id", ctx.companyId);
      return { success: false, error: "Couldn't add the interviewers. Try again." };
    }
  }

  // ── The link. A failed send leaves the interview in place for a resend. ──
  const sent = await sendLink(ctx, service, fi, app, durationMinutes);
  if (!sent.success) {
    revalidatePath("/ai-dashboard/applicants");
    return {
      success: false,
      error: `The final interview was created, but the link could not be sent: ${sent.error} Use Resend link to try again.`,
    };
  }
  return sent;
}

export async function resendFinalInterviewLink(
  finalInterviewId: string,
): Promise<MutationResult<{ finalInterviewId: string; expiresAt: string }>> {
  const ctx = await getCompanyContext();
  if (!canManageBookings(ctx.role)) return { success: false, error: NOT_A_BOOKING_ROLE };
  const service = createServiceClient();

  const gate = await gateFinalInterview(ctx, service, finalInterviewId);
  if (!gate.ok) return { success: false, error: gate.error };
  const { fi } = gate;
  if (fi.status !== "active") {
    return {
      success: false,
      error: "This final interview is no longer open, so no link can be sent.",
    };
  }
  const appGate = await gateApplication(ctx, service, fi.application_id);
  if (!appGate.ok) return { success: false, error: appGate.error };

  // The same length as last time, unless no link was ever sent.
  const previous = await latestBooking(service, ctx.companyId, fi.id);
  return sendLink(
    ctx,
    service,
    fi,
    appGate.app,
    previous?.duration_minutes ?? DEFAULT_FINAL_DURATION,
  );
}

export async function cancelFinalInterview(
  finalInterviewId: string,
  reason?: string,
): Promise<MutationResult<{ removedFromCalendar: boolean | null }>> {
  const ctx = await getCompanyContext();
  if (!canManageBookings(ctx.role)) return { success: false, error: NOT_A_BOOKING_ROLE };
  const service = createServiceClient();

  const gate = await gateFinalInterview(ctx, service, finalInterviewId);
  if (!gate.ok) return { success: false, error: gate.error };
  const { fi } = gate;
  if (fi.status === "cancelled") {
    return { success: false, error: "This final interview is already cancelled." };
  }

  const live = await latestBooking(service, ctx.companyId, fi.id);
  let removedFromCalendar: boolean | null = null;

  if (live?.status === "booked") {
    // The existing cancel path: the Google event goes first, then the row.
    if (!canCancel(live)) {
      return { success: false, error: "This interview has already started or passed." };
    }
    const cancelled = await cancelBooking({
      row: live,
      cancelledBy: "recruiter",
      reason: reason ?? null,
    });
    if (!cancelled.ok) return { success: false, error: "Could not cancel. Try again." };
    removedFromCalendar = cancelled.removedFromCalendar;

    const [appGate, host] = await Promise.all([
      gateApplication(ctx, service, fi.application_id),
      resolveHostEmail(fi.host_member_id, ctx.companyId),
    ]);
    // The booking is already cancelled by this point, so a refusal here must not
    // abort - the notices degrade to the same fallbacks a missing row has always
    // produced rather than leaving the cancellation half-done.
    const app = appGate.ok ? appGate.app : null;
    const candidateName = [app?.first_name, app?.last_name].filter(Boolean).join(" ").trim();
    const label = interviewTypeLabel(fi.interview_type, fi.custom_label);

    const notices = await sendCancellationNotices({
      row: cancelled.row,
      startMs: Date.parse(live.scheduled_start ?? ""),
      cancelledBy: "recruiter",
      reason: cancelled.row.cancel_reason,
      removedFromCalendar: cancelled.removedFromCalendar,
      hostTimezone: live.host_timezone ?? "UTC",
      candidateTimezone: live.candidate_timezone ?? live.host_timezone ?? "UTC",
      candidateEmail: app?.email ?? null,
      candidateName: candidateName || "there",
      hostEmail: host.email,
      hostName: host.name ?? ctx.memberName,
      jobTitle: app?.jobs?.title ?? "Interview",
      companyName: ctx.company.name,
      meetingUrl: null,
      interviewLabel: label,
      sentByName: host.name ?? ctx.memberName,
    });
    for (const problem of notices.problems) {
      console.error(`[final-interview] cancel ${cancelled.row.id}: ${problem}`);
    }
    await notifyCompany({
      companyId: ctx.companyId,
      type: "interview_cancelled",
      title: `${candidateName || "A candidate"}'s ${label.toLowerCase()} was cancelled`,
      body: `${ctx.memberName} cancelled it${cancelled.row.cancel_reason ? ` · ${cancelled.row.cancel_reason}` : ""}`,
      jobId: fi.job_id,
      applicationId: fi.application_id,
      actorMemberId: ctx.memberId,
    });
  } else if (live?.status === "invited") {
    // An unbooked link simply stops working.
    await service
      .from("interview_bookings")
      .update({ status: "expired" })
      .eq("id", live.id)
      .eq("status", "invited");
  }

  // The recording bot, if one was scheduled: queues its removal, keeping
  // anything it recorded. Bounded, never throws, never calls Recall.
  if (live) await onFinalBookingCancelled(live);

  const { error } = await service
    .from("final_interviews")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", fi.id)
    .eq("company_id", ctx.companyId);
  if (error) {
    console.error("[final-interview] cancel write failed:", error.message);
    return {
      success: false,
      error: "The booking was cancelled, but the interview could not be marked. Try again.",
    };
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { removedFromCalendar } };
}
