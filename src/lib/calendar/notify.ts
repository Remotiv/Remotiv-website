import "server-only";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import { escapeHtml } from "@/lib/email/candidate/render";
import type { LoggedEvent } from "@/lib/email/candidate/types";
import { sendEmail } from "@/lib/email/send";
import { createServiceClient } from "@/lib/supabase/server";
import type { BookingActor, BookingRow } from "./bookings";
import { formatInZone, zoneAbbreviation } from "./timezone";

/**
 * Booking confirmations, both directions.
 *
 * ── Each side is shown the time in THEIR OWN zone ────────────
 *
 * The same instant, rendered twice. The candidate's email says 3pm London and
 * the host's says 8pm Karachi, and both are correct because both name the zone
 * they are quoting. Sending one rendering to both is how somebody joins an
 * hour late while holding an email that "clearly" says otherwise.
 *
 * Both emails also state the OTHER side's local time. It costs a line and it
 * removes the most common pre-interview message.
 *
 * ── Why the candidate path is the existing one ───────────────
 *
 * `deliverEmail` carries the daily cap, the unsubscribe footer, the reply-to
 * identity and the communication_logs row. Bypassing it for a "quick" send
 * would put candidate mail outside every one of those. The host is internal
 * and takes the plain sender instead — a recruiter must not be able to
 * unsubscribe from their own bookings.
 */

/**
 * These are LOG-ONLY events.
 *
 * `communication_logs.event` DOES carry a CHECK, and all three booking values
 * are in it — the ALTER was run and verified. What these must not join is
 * MESSAGE_EVENTS: that union drives the Settings template editor and is
 * constrained by message_templates_event_check, which would reject them.
 */
/**
 * One event value per message, never shared.
 *
 * The UNIQUE index on (application_id, event, channel) WHERE sent_by_name IS
 * NULL means a shared value makes the SECOND message unsendable — and these
 * three all go to the same application with a null sender, so sharing one was
 * guaranteed to break two of them. It did: reschedule and cancellation notices
 * both collided with the confirmation and were refused with 23505, logged and
 * never sent, while the API returned 200.
 */
const EVENT_CONFIRMED = "booking_confirmed" as const;
const EVENT_RESCHEDULED = "booking_rescheduled" as const;
const EVENT_CANCELLED = "booking_cancelled" as const;

/**
 * Shared shape for all four of the reschedule/cancel emails.
 *
 * `timesDiffer` is computed once from the RENDERED blocks and threaded through
 * every one of them, so the same-timezone suppression that fixed the
 * confirmation email applies identically here. A recruiter and candidate in
 * one zone never see "09:45 … that's 09:45 for them" on any message.
 */
type NoticeArgs = {
  row: BookingRow;
  startMs: number;
  hostTimezone: string;
  candidateTimezone: string;
  candidateEmail: string | null;
  candidateName: string;
  hostEmail: string | null;
  hostName: string;
  jobTitle: string;
  companyName: string;
  meetingUrl: string | null;
};

function timeBlock(ms: number, zone: string): string {
  return `${formatInZone(ms, zone)} (${zoneAbbreviation(ms, zone)})`;
}

export async function sendBookingConfirmations(args: {
  row: BookingRow;
  startMs: number;
  endMs: number;
  hostTimezone: string;
  candidateTimezone: string;
  candidateEmail: string | null;
  candidateName: string;
  hostEmail: string | null;
  hostName: string;
  jobTitle: string;
  companyName: string;
  meetingUrl: string | null;
}): Promise<NoticeOutcome> {
  const service = createServiceClient();

  const candidateTime = timeBlock(args.startMs, args.candidateTimezone);
  const hostTime = timeBlock(args.startMs, args.hostTimezone);
  const duration = args.row.duration_minutes;

  /*
   * Only cross-reference the other side's time when it actually reads
   * differently.
   *
   * ── Compared as RENDERED STRINGS, not as zone names ──────────
   *
   * The question this answers is "does this email say the same thing twice?",
   * and that is a question about the two lines, not about the two zones.
   *
   * Comparing `candidateTimezone !== hostTimezone` would be wrong in both
   * directions. Asia/Karachi and Asia/Tashkent are different names that are
   * always +05:00, so a name comparison would print the identical sentence
   * twice — the exact bug being fixed, just harder to notice. And
   * Europe/London and Africa/Abidjan are different names that render the same
   * in January and an hour apart in July, so whether the line is redundant
   * depends on WHEN this booking is, not on the zones in general.
   *
   * Comparing the strings settles it per-email, for the one instant the email
   * is about. Identical text is redundant whatever the zones are called;
   * different text is worth showing even when the zones look related.
   */
  const timesDiffer = hostTime !== candidateTime;
  let candidate: Awaited<ReturnType<typeof deliverBooking>> = {
    result: "skipped_no_address",
    problem: "candidate has no email address",
  };
  let host: Awaited<ReturnType<typeof sendHostEmail>> = {
    result: "skipped_no_address",
    problem: "host has no resolvable email address",
  };

  const joinLine = args.meetingUrl
    ? `<p style="margin:16px 0;"><a href="${escapeHtml(args.meetingUrl)}" style="color:#7E47FF;font-weight:700;">Join the interview</a></p>`
    : `<p style="margin:16px 0;color:#4A4550;">Your interviewer will send joining details separately.</p>`;

  /* ── Candidate ───────────────────────────────────────────── */
  if (args.candidateEmail) {
    const body = `
      <p style="margin:0 0 12px;color:#17131F;">Hi ${escapeHtml(args.candidateName)},</p>
      <p style="margin:0 0 12px;color:#4A4550;">
        Your ${escapeHtml(args.jobTitle)} interview is confirmed.
      </p>
      <p style="margin:0 0 4px;color:#17131F;font-weight:700;">${escapeHtml(candidateTime)}</p>
      <p style="margin:0 0 12px;color:#847E8C;font-size:13px;">
        ${duration} minutes${
          timesDiffer
            ? ` · that's ${escapeHtml(hostTime)} for ${escapeHtml(args.hostName || "your interviewer")}`
            : ""
        }
      </p>
      ${joinLine}
      <p style="margin:16px 0 0;color:#847E8C;font-size:13px;">
        Times are shown in ${escapeHtml(args.candidateTimezone)}. If that isn't your timezone, reply to this email.
      </p>`;

    candidate = await deliverBooking(
      service,
      args,
      EVENT_CONFIRMED,
      `Interview confirmed — ${args.jobTitle}`,
      body,
    );
  }

  /* ── Host ────────────────────────────────────────────────── */
  if (args.hostEmail) {
    const body = `
      <p>Hi ${escapeHtml(args.hostName || "there")},</p>
      <p><strong>${escapeHtml(args.candidateName)}</strong> booked their ${escapeHtml(args.jobTitle)} interview.</p>
      <p><strong>${escapeHtml(hostTime)}</strong><br>
      <span style="color:#847E8C;font-size:13px;">${duration} minutes${
        timesDiffer ? ` · ${escapeHtml(candidateTime)} for them` : ""
      }</span></p>
      ${joinLine}
      <p style="color:#847E8C;font-size:13px;">It's on your calendar already.</p>`;

    /*
     * This branch USED to be `await sendEmail(...)` inside a try/catch with no
     * check of the returned `ok`. sendEmail does not throw — it returns
     * {ok:false, error} when Resend is unconfigured or rejects — so the catch
     * caught nothing and a refused send looked identical to a delivered one.
     * sendHostEmail checks the flag.
     */
    host = await sendHostEmail(
      args.hostEmail,
      `${args.candidateName} booked — ${args.jobTitle}`,
      body,
    );
  }

  return summarise(candidate, host);
}

/* ─────────────────── reschedule and cancel ─────────────────── */

/**
 * Both sides, when a booking MOVES.
 *
 * Says the new time first and the old one second — the reader's question is
 * "when is it now", and leading with what changed rather than what it changed
 * from answers it in the first line.
 *
 * The Meet link is repeated deliberately. It survives a reschedule because the
 * event is patched rather than recreated, and saying so pre-empts the obvious
 * worry that the old link is now dead.
 */
export async function sendRescheduleNotices(
  args: NoticeArgs & { previousStartMs: number; movedBy: BookingActor },
): Promise<NoticeOutcome> {
  const service = createServiceClient();
  const candidateTime = timeBlock(args.startMs, args.candidateTimezone);
  const hostTime = timeBlock(args.startMs, args.hostTimezone);
  const timesDiffer = hostTime !== candidateTime;
  const duration = args.row.duration_minutes;
  let candidate: Awaited<ReturnType<typeof deliverBooking>> = {
    result: "skipped_no_address",
    problem: "candidate has no email address",
  };
  let host: Awaited<ReturnType<typeof sendHostEmail>> = {
    result: "skipped_no_address",
    problem: "host has no resolvable email address",
  };

  const joinLine = args.meetingUrl
    ? `<p style="margin:16px 0;"><a href="${escapeHtml(args.meetingUrl)}" style="color:#7E47FF;font-weight:700;">Join the interview</a></p><p style="margin:0;color:#847E8C;font-size:13px;">Same link as before — nothing to re-save.</p>`
    : `<p style="margin:16px 0;color:#4A4550;">Your interviewer will send joining details separately.</p>`;

  const movedByThem = args.movedBy === "recruiter";

  /* ── Candidate ───────────────────────────────────────────── */
  if (args.candidateEmail) {
    const body = `
      <p style="margin:0 0 12px;color:#17131F;">Hi ${escapeHtml(args.candidateName)},</p>
      <p style="margin:0 0 12px;color:#4A4550;">
        ${movedByThem ? `${escapeHtml(args.hostName || "Your interviewer")} moved your` : "You moved your"}
        ${escapeHtml(args.jobTitle)} interview.
      </p>
      <p style="margin:0 0 4px;color:#17131F;font-weight:700;">${escapeHtml(candidateTime)}</p>
      <p style="margin:0 0 12px;color:#847E8C;font-size:13px;">
        ${duration} minutes${timesDiffer ? ` · that's ${escapeHtml(hostTime)} for ${escapeHtml(args.hostName || "your interviewer")}` : ""}
        <br>Previously ${escapeHtml(timeBlock(args.previousStartMs, args.candidateTimezone))}
      </p>
      ${joinLine}`;
    candidate = await deliverBooking(
      service,
      args,
      EVENT_RESCHEDULED,
      `Interview moved — ${args.jobTitle}`,
      body,
    );
  }

  /* ── Host ────────────────────────────────────────────────── */
  if (args.hostEmail) {
    const body = `
      <p>Hi ${escapeHtml(args.hostName || "there")},</p>
      <p>${movedByThem ? "You moved" : `<strong>${escapeHtml(args.candidateName)}</strong> moved their`}
      ${escapeHtml(args.jobTitle)} interview.</p>
      <p><strong>${escapeHtml(hostTime)}</strong><br>
      <span style="color:#847E8C;font-size:13px;">${duration} minutes${timesDiffer ? ` · ${escapeHtml(candidateTime)} for them` : ""}
      <br>Previously ${escapeHtml(timeBlock(args.previousStartMs, args.hostTimezone))}</span></p>
      ${joinLine}
      <p style="color:#847E8C;font-size:13px;">Your calendar has been updated.</p>`;
    host = await sendHostEmail(args.hostEmail, `Interview moved — ${args.jobTitle}`, body);
  }

  return summarise(candidate, host);
}

/**
 * Both sides, when a booking is CANCELLED.
 *
 * The reason is included only when one was given — it is optional by design,
 * and "Reason: (none)" reads as an accusation about a field somebody chose not
 * to fill in.
 *
 * When the calendar entry could not be removed, the HOST is told so and asked
 * to delete it. The candidate is not: the stale entry is not in their diary,
 * and it is not their problem to solve.
 */
export async function sendCancellationNotices(
  args: NoticeArgs & {
    cancelledBy: BookingActor;
    reason: string | null;
    removedFromCalendar: boolean;
  },
): Promise<NoticeOutcome> {
  const service = createServiceClient();
  const candidateTime = timeBlock(args.startMs, args.candidateTimezone);
  const hostTime = timeBlock(args.startMs, args.hostTimezone);
  const timesDiffer = hostTime !== candidateTime;
  const cancelledByThem = args.cancelledBy === "recruiter";
  let candidate: Awaited<ReturnType<typeof deliverBooking>> = {
    result: "skipped_no_address",
    problem: "candidate has no email address",
  };
  let host: Awaited<ReturnType<typeof sendHostEmail>> = {
    result: "skipped_no_address",
    problem: "host has no resolvable email address",
  };
  const reasonLine = args.reason
    ? `<p style="margin:12px 0;color:#4A4550;">Reason given: ${escapeHtml(args.reason)}</p>`
    : "";

  /* ── Candidate ───────────────────────────────────────────── */
  if (args.candidateEmail) {
    const body = `
      <p style="margin:0 0 12px;color:#17131F;">Hi ${escapeHtml(args.candidateName)},</p>
      <p style="margin:0 0 12px;color:#4A4550;">
        ${cancelledByThem ? `${escapeHtml(args.hostName || "Your interviewer")} cancelled your` : "You cancelled your"}
        ${escapeHtml(args.jobTitle)} interview${escapeHtml(args.companyName ? ` at ${args.companyName}` : "")}.
      </p>
      <p style="margin:0 0 4px;color:#847E8C;text-decoration:line-through;">${escapeHtml(candidateTime)}</p>
      ${reasonLine}
      <p style="margin:16px 0 0;color:#4A4550;">
        ${cancelledByThem ? "They'll be in touch if there's another time that works." : "Reply to this email if you'd like to arrange another time."}
      </p>`;
    candidate = await deliverBooking(
      service,
      args,
      EVENT_CANCELLED,
      `Interview cancelled — ${args.jobTitle}`,
      body,
    );
  }

  /* ── Host ────────────────────────────────────────────────── */
  if (args.hostEmail) {
    const body = `
      <p>Hi ${escapeHtml(args.hostName || "there")},</p>
      <p>${cancelledByThem ? "You cancelled" : `<strong>${escapeHtml(args.candidateName)}</strong> cancelled their`}
      ${escapeHtml(args.jobTitle)} interview.</p>
      <p style="color:#847E8C;text-decoration:line-through;">${escapeHtml(hostTime)}${timesDiffer ? ` · ${escapeHtml(candidateTime)} for them` : ""}</p>
      ${reasonLine}
      <p style="color:#847E8C;font-size:13px;">${
        args.removedFromCalendar
          ? "It's been removed from your calendar."
          : "We couldn't confirm its removal from your calendar — please delete the entry yourself."
      }</p>`;
    host = await sendHostEmail(args.hostEmail, `Interview cancelled — ${args.jobTitle}`, body);
  }

  return summarise(candidate, host);
}

/**
 * What a set of notices actually managed to do.
 *
 * ── Why this is no longer void ───────────────────────────────
 *
 * `Promise<void>` is what let TWO separate failures hide behind a 200: the
 * candidate's mail was refused by a unique constraint and the host's was
 * skipped for want of an address, and the route — which dutifully awaited
 * both — had nothing to inspect and nothing to log. A function that can fail
 * partially has to say so.
 */
export type NoticeOutcome = {
  candidate: "sent" | "skipped_no_address" | "failed";
  host: "sent" | "skipped_no_address" | "failed";
  /** Populated when either side is not "sent". Safe to log; no personal data. */
  problems: string[];
};

/** Candidate mail, through the logged/capped/unsubscribable path. */
async function deliverBooking(
  service: ReturnType<typeof createServiceClient>,
  args: NoticeArgs,
  event: LoggedEvent,
  subject: string,
  body: string,
): Promise<{ result: NoticeOutcome["candidate"]; problem?: string }> {
  if (!args.candidateEmail) {
    return { result: "skipped_no_address", problem: "candidate has no email address" };
  }
  try {
    const outcome = await deliverEmail(service, {
      companyId: args.row.company_id,
      applicationId: args.row.application_id,
      event,
      to: args.candidateEmail,
      subject,
      html: buildCandidateHtml(body, args.companyName, args.row.company_id, args.candidateEmail),
      companyName: args.companyName,
      replyTo: null,
    });
    if (!outcome.ok) {
      const problem = `candidate ${event}: ${outcome.kind} — ${outcome.message}`;
      console.error(`[booking] ${problem}`);
      return { result: "failed", problem };
    }
    return { result: "sent" };
  } catch (err) {
    // The booking change is already real. A failed notification must not
    // unwind it — but it must not vanish either.
    const problem = `candidate ${event}: threw — ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[booking] ${problem}`);
    return { result: "failed", problem };
  }
}

/** Host mail, plain sender — a recruiter must not be able to unsubscribe from
 *  their own diary. */
async function sendHostEmail(
  to: string | null,
  subject: string,
  html: string,
): Promise<{ result: NoticeOutcome["host"]; problem?: string }> {
  if (!to) {
    /*
     * THIS IS THE ONE THAT WENT UNNOTICED FOR TWO SESSIONS.
     *
     * The host branch was guarded by `if (args.hostEmail)` and simply did
     * nothing when the address was null — no log, no error, no trace. Every
     * booking email to the recruiter had been silently skipped since session
     * 2, including the original confirmation, and the feature was reported
     * working because the candidate's copy arrived.
     *
     * Now it is a reported outcome rather than an early return.
     */
    return { result: "skipped_no_address", problem: "host has no resolvable email address" };
  }
  try {
    const sent = await sendEmail({ to, subject, html });
    if (!sent.ok) {
      const problem = `host: ${sent.error ?? "send failed"}`;
      console.error(`[booking] ${problem}`);
      return { result: "failed", problem };
    }
    return { result: "sent" };
  } catch (err) {
    const problem = `host: threw — ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[booking] ${problem}`);
    return { result: "failed", problem };
  }
}

/** Fold the two halves into one reportable outcome. */
function summarise(
  candidate: { result: NoticeOutcome["candidate"]; problem?: string },
  host: { result: NoticeOutcome["host"]; problem?: string },
): NoticeOutcome {
  return {
    candidate: candidate.result,
    host: host.result,
    problems: [candidate.problem, host.problem].filter((p): p is string => Boolean(p)),
  };
}
