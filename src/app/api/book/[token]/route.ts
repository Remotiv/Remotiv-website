import { NextResponse } from "next/server";
import { fetchAvailability } from "@/lib/calendar/availability";
import {
  attachCalendarEvent,
  type BookingRow,
  claimSlot,
  findBookingByToken,
  isExpired,
  releaseClaim,
} from "@/lib/calendar/bookings";
import "@/lib/calendar/google";
import { sendBookingConfirmations } from "@/lib/calendar/notify";
import { formatInZone, isValidTimeZone } from "@/lib/calendar/timezone";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The public booking endpoint. No login — the token IS the authorisation.
 *
 * GET  → the slots this candidate may book
 * POST → confirm one
 *
 * ── What "no login" means for what may be returned ───────────
 *
 * Anyone holding the link can call this, so the response is scoped to what the
 * candidate already knows: their own first name, the role, the company, the
 * interviewer's display name, and a list of times. No member ids, no company
 * id, no application id, no email addresses, no other candidate's data. The
 * token proves entitlement to exactly one booking and nothing else.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, max-age=0" } as const;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** Context the page needs, gathered once. Server-side ids stay here. */
async function loadContext(row: BookingRow) {
  const service = createServiceClient();
  const [{ data: app }, { data: job }, { data: company }, { data: member }] = await Promise.all([
    service
      .from("job_applications")
      .select("first_name, last_name, email")
      .eq("id", row.application_id)
      .maybeSingle(),
    service
      .from("jobs")
      .select("title, interview_duration_minutes")
      .eq("id", row.job_id)
      .maybeSingle(),
    service.from("companies").select("name").eq("id", row.company_id).maybeSingle(),
    service
      .from("company_members")
      .select("name, email")
      .eq("id", row.host_member_id)
      .maybeSingle(),
  ]);

  return {
    candidate: app as {
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    } | null,
    job: job as { title: string | null; interview_duration_minutes: number | null } | null,
    company: company as { name: string | null } | null,
    host: member as { name: string | null; email: string | null } | null,
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const row = await findBookingByToken(token);
  // Same answer for a bad token and a missing one — a prober learns nothing
  // about which tokens exist.
  if (!row) return fail(404, "not_found");
  if (isExpired(row)) return fail(410, "expired");

  const ctx = await loadContext(row);

  if (row.status === "booked") {
    return NextResponse.json(
      {
        state: "booked",
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        candidateTimezone: row.candidate_timezone,
        hostTimezone: row.host_timezone,
        meetingUrl: row.meeting_url,
        jobTitle: ctx.job?.title ?? "the role",
        companyName: ctx.company?.name ?? "the company",
        hostName: ctx.host?.name ?? "your interviewer",
        durationMinutes: row.duration_minutes,
      },
      { headers: NO_STORE },
    );
  }

  if (row.status === "cancelled") return fail(410, "cancelled");

  const availability = await fetchAvailability({
    hostMemberId: row.host_member_id,
    jobId: row.job_id,
    durationMinutes: row.duration_minutes,
  });

  /*
   * A calendar we cannot read is NOT an empty calendar.
   *
   * Returning `slots: []` here would tell the candidate "no times available",
   * which is indistinguishable from a genuinely full diary — they would wait,
   * and nobody would learn the integration is broken. The reason travels so
   * the page can say the interviewer will be in touch, which is both true and
   * actionable.
   */
  if (!availability.ok) {
    return NextResponse.json(
      {
        state: "unavailable",
        reason: availability.reason,
        jobTitle: ctx.job?.title ?? "the role",
        companyName: ctx.company?.name ?? "the company",
        hostName: ctx.host?.name ?? "your interviewer",
        candidateFirstName: ctx.candidate?.first_name ?? "",
      },
      { headers: NO_STORE },
    );
  }

  return NextResponse.json(
    {
      state: "open",
      slots: availability.slots,
      hostTimezone: availability.hostTimezone,
      truncated: availability.truncated,
      durationMinutes: row.duration_minutes,
      jobTitle: ctx.job?.title ?? "the role",
      companyName: ctx.company?.name ?? "the company",
      hostName: ctx.host?.name ?? "your interviewer",
      candidateFirstName: ctx.candidate?.first_name ?? "",
      expiresAt: row.expires_at,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const body = (await request.json().catch(() => null)) as {
    startIso?: string;
    timezone?: string;
  } | null;

  const startMs = Date.parse(body?.startIso ?? "");
  if (!Number.isFinite(startMs)) return fail(400, "bad_slot");

  /*
   * The candidate's zone is theirs to state. It is validated against the
   * runtime's zone database rather than trusted, because it is written to a
   * column and later used to render times back to them — an unknown zone would
   * throw at format time, on the confirmation page, after the booking was
   * already made.
   */
  const candidateTimezone = (body?.timezone ?? "").trim();
  if (!isValidTimeZone(candidateTimezone)) return fail(400, "bad_timezone");

  const row = await findBookingByToken(token);
  if (!row) return fail(404, "not_found");
  if (isExpired(row)) return fail(410, "expired");
  if (row.status === "booked") return fail(409, "already_booked");
  if (row.status === "cancelled") return fail(410, "cancelled");

  /*
   * RE-DERIVE availability rather than trusting the posted instant.
   *
   * The slot list the browser holds may be minutes old — the host may have
   * accepted a meeting since. Confirming against a stale list is how a booking
   * lands on top of something real, so the offer is recomputed and the posted
   * start must still be in it. This also rejects an arbitrary instant posted
   * directly to the endpoint, which is the same check by a different name.
   */
  const availability = await fetchAvailability({
    hostMemberId: row.host_member_id,
    jobId: row.job_id,
    durationMinutes: row.duration_minutes,
  });
  if (!availability.ok) return fail(503, "unavailable");

  const match = availability.slots.find((s) => Date.parse(s.startIso) === startMs);
  if (!match) return fail(409, "slot_taken");

  const endMs = Date.parse(match.endIso);

  // Atomic claim. See the long note in bookings.ts about exactly what this
  // does and does not guarantee.
  const claim = await claimSlot({
    row,
    startMs,
    endMs,
    candidateTimezone,
    hostTimezone: availability.hostTimezone,
  });
  if (!claim.ok) {
    const status = claim.reason === "slot_taken" || claim.reason === "already_booked" ? 409 : 500;
    return fail(status, claim.reason);
  }

  const ctx = await loadContext(row);
  const candidateName = [ctx.candidate?.first_name, ctx.candidate?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const jobTitle = ctx.job?.title ?? "Interview";

  let meetingUrl: string | null = null;
  try {
    const attached = await attachCalendarEvent({
      row: claim.row,
      startMs,
      endMs,
      hostTimezone: availability.hostTimezone,
      summary: `Interview — ${candidateName || "Candidate"} · ${jobTitle}`,
      description: [
        `${jobTitle} interview with ${candidateName || "the candidate"}.`,
        `Candidate timezone: ${candidateTimezone}.`,
        "Arranged through Remotiv.",
      ].join("\n\n"),
      attendeeEmails: [ctx.host?.email ?? "", ctx.candidate?.email ?? ""].filter(Boolean),
      // Session 3 exposes a manual URL per booking; the column exists and is
      // honoured here already when set.
      manualUrl: row.meeting_url,
    });
    meetingUrl = attached.meetingUrl;
  } catch (err) {
    /*
     * The event did not land, so the claim is given back. A booking the
     * recruiter's calendar has never heard of is worse than asking the
     * candidate to pick again — they would both hold a time only one of them
     * knows about.
     */
    console.error("[booking] event creation failed — releasing the claim:", err);
    await releaseClaim(claim.row.id);
    return fail(502, "calendar_failed");
  }

  // Both sides are told. A failure here does not undo the booking — the
  // meeting is real and on the calendar; the email is a notification about it.
  await sendBookingConfirmations({
    row: claim.row,
    startMs,
    endMs,
    hostTimezone: availability.hostTimezone,
    candidateTimezone,
    candidateEmail: ctx.candidate?.email ?? null,
    candidateName: candidateName || "there",
    hostEmail: ctx.host?.email ?? null,
    hostName: ctx.host?.name ?? "",
    jobTitle,
    companyName: ctx.company?.name ?? "",
    meetingUrl,
  });

  return NextResponse.json(
    {
      state: "booked",
      scheduledStart: new Date(startMs).toISOString(),
      scheduledEnd: new Date(endMs).toISOString(),
      candidateTimezone,
      hostTimezone: availability.hostTimezone,
      meetingUrl,
      // Rendered server-side in the candidate's OWN stated zone, never the
      // server's — the classic way a scheduling product shows two people two
      // different times for one meeting.
      readableStart: formatInZone(startMs, candidateTimezone),
    },
    { headers: NO_STORE },
  );
}
