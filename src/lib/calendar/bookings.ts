import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { accountKeyFromEmail } from "./account-key";
import { recordPendingCleanup } from "./cleanups";
import { getAccessToken } from "./connections";
import { getProvider } from "./provider";
import { isValidTimeZone } from "./timezone";

/**
 * interview_bookings — tokens, claiming, and the double-booking question.
 *
 * ── The token ────────────────────────────────────────────────
 *
 * Minted here, hashed with SHA-256, and only the HASH is stored — the same
 * shape as interview sessions. The raw token exists in the emailed URL and
 * nowhere else, so a leaked database row cannot be turned back into a working
 * booking link. SHA-256 rather than bcrypt because the token already carries
 * 256 bits of entropy: there is no low-entropy secret to slow an attacker
 * down on, and a per-request bcrypt would just make the public page slow.
 */

export const BOOKING_EXPIRY_DAYS = 14;

/**
 * Moving needs notice. Cancelling never does.
 *
 * ── Why the two rules differ ─────────────────────────────────
 *
 * They are not the same act. A late CANCELLATION is information the other side
 * urgently wants — someone who cannot come should always be able to say so,
 * and a product that blocks it at the eleventh hour just converts a cancelled
 * interview into a no-show, which is strictly worse for everybody.
 *
 * A late RESCHEDULE is different: it picks a NEW time, and the 24-hour rule
 * already governs first bookings for the same reason — nobody should be
 * committed to something tomorrow morning they learned about tonight. Allowing
 * a move inside the window would let the notice rule be bypassed by booking
 * far out and then dragging the slot forward.
 *
 * So: cancel until the moment it starts; move only with a day's notice.
 */
export const RESCHEDULE_NOTICE_MS = 24 * 60 * 60 * 1000;

/** May this booking still be MOVED? */
export function canReschedule(row: BookingRow, now = Date.now()): boolean {
  if (row.status !== "booked" || !row.scheduled_start) return false;
  const start = Date.parse(row.scheduled_start);
  return Number.isFinite(start) && start - now >= RESCHEDULE_NOTICE_MS;
}

/** May this booking still be CANCELLED? Right up to the start. */
export function canCancel(row: BookingRow, now = Date.now()): boolean {
  if (row.status !== "booked" || !row.scheduled_start) return false;
  const start = Date.parse(row.scheduled_start);
  return Number.isFinite(start) && start > now;
}

/** Longest a stored cancellation reason may be. Optional, never required. */
export const CANCEL_REASON_MAX = 500;

/** Who acted. Stored on cancelled_by so the emails and the audit agree. */
export type BookingActor = "candidate" | "recruiter";

export function mintBookingToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashBookingToken(rawToken) };
}

export function hashBookingToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

// The public URL builder lives with the redactor that scrubs it from stored
// bodies (see lib/candidate-links.ts); re-exported so callers did not move.
export { bookingUrl } from "@/lib/candidate-links";

/* ─────────────────────── public page reads ─────────────────── */

/** What the PUBLIC page may know. No member ids, no company ids, no tokens. */
export type PublicBooking = {
  status: string;
  durationMinutes: number;
  jobTitle: string;
  companyName: string;
  hostName: string;
  candidateFirstName: string;
  expiresAt: string | null;
  /** Set once booked, so the page can render the confirmation. */
  scheduledStart: string | null;
  scheduledEnd: string | null;
  candidateTimezone: string | null;
  hostTimezone: string | null;
  meetingUrl: string | null;
};

/** Server-side row. Carries the ids the public shape deliberately omits. */
export type BookingRow = {
  id: string;
  company_id: string;
  application_id: string;
  job_id: string;
  host_member_id: string;
  duration_minutes: number;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  candidate_timezone: string | null;
  host_timezone: string | null;
  meeting_mode: string;
  meeting_url: string | null;
  provider_event_id: string | null;
  provider: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  /** When the CANDIDATE picked the slot, not when the link was sent — that is
   *  created_at. Nulled again on release, so a re-booked row carries the
   *  latest choice rather than the first. */
  booked_at: string | null;
  /** 'candidate' or 'recruiter' — see BookingActor. */
  cancelled_by: string | null;
  cancel_reason: string | null;
  /** 'interview' (a screening call) or 'final' (a Final Human Interview). */
  purpose: string;
  /** Set exactly when purpose is 'final' (migration 038). */
  final_interview_id: string | null;
  /** The candidate's acknowledgement of the recording notice, final only. */
  recording_notice_acknowledged_at: string | null;
  recording_notice_version: string | null;
};

export type BookingPurpose = "interview" | "final";

const ROW_COLUMNS =
  "id, company_id, application_id, job_id, host_member_id, duration_minutes, status, scheduled_start, scheduled_end, candidate_timezone, host_timezone, meeting_mode, meeting_url, provider_event_id, provider, expires_at, cancelled_at, booked_at, cancelled_by, cancel_reason, purpose, final_interview_id, recording_notice_acknowledged_at, recording_notice_version";
/** The same list, for callers that read a BookingRow themselves. */
export const BOOKING_ROW_COLUMNS = ROW_COLUMNS;

/* ─────────────────────── creating a link ───────────────────── */

export type CreateLinkOutcome =
  | { ok: true; bookingId: string; rawToken: string; expiresAt: string }
  | { ok: false; reason: "already_booked" | "write_failed" };

/**
 * Mint a booking link: supersede the live one, then insert the new row.
 *
 * ── The supersede rule is PER PURPOSE ────────────────────────
 *
 * A screening call and a final round can both be live for one application, so
 * "the live booking" is looked up differently for each:
 *
 *   purpose 'interview'  rows WHERE purpose = 'interview' AND application_id = X
 *   purpose 'final'      rows WHERE purpose = 'final' AND final_interview_id = Y
 *
 * Sending or resending a screening link can therefore never expire a final
 * booking, and a final resend can never touch the screening booking or another
 * final interview's booking. A BOOKED row is never superseded: the caller is
 * told, and must cancel first.
 *
 * `hostMemberId` and `invitedBy` are separate because they differ for a final
 * round: the recruiter sends the link, the chosen host holds the calendar.
 */
export async function createBookingLink(args: {
  purpose: BookingPurpose;
  companyId: string;
  applicationId: string;
  jobId: string;
  hostMemberId: string;
  invitedBy: string;
  invitedByName: string;
  durationMinutes: number;
  finalInterviewId?: string | null;
}): Promise<CreateLinkOutcome> {
  const service = createServiceClient();
  const finalInterviewId = args.purpose === "final" ? (args.finalInterviewId ?? null) : null;
  if (args.purpose === "final" && !finalInterviewId) {
    console.error("[booking] a final-round link needs its final interview id");
    return { ok: false, reason: "write_failed" };
  }

  let live = service
    .from("interview_bookings")
    .select("id, status")
    .eq("company_id", args.companyId)
    .eq("purpose", args.purpose);
  live =
    args.purpose === "final"
      ? live.eq("final_interview_id", finalInterviewId)
      : live.eq("application_id", args.applicationId);
  const { data: existing, error: readErr } = await live
    .in("status", ["invited", "booked"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (readErr) {
    console.error("[booking] live booking read failed:", readErr.message);
    return { ok: false, reason: "write_failed" };
  }

  const current = ((existing ?? []) as { id: string; status: string }[])[0];
  if (current?.status === "booked") return { ok: false, reason: "already_booked" };
  if (current) {
    await service.from("interview_bookings").update({ status: "expired" }).eq("id", current.id);
  }

  const { rawToken, tokenHash } = mintBookingToken();
  const expiresAt = new Date(Date.now() + BOOKING_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: created, error: insertErr } = await service
    .from("interview_bookings")
    .insert({
      company_id: args.companyId,
      application_id: args.applicationId,
      job_id: args.jobId,
      host_member_id: args.hostMemberId,
      // Only the hash is stored. The raw token exists in the email URL and
      // nowhere else.
      token_hash: tokenHash,
      duration_minutes: args.durationMinutes,
      status: "invited",
      meeting_mode: "auto",
      purpose: args.purpose,
      final_interview_id: finalInterviewId,
      invited_by: args.invitedBy,
      invited_by_name: args.invitedByName,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (insertErr || !created) {
    console.error("[booking] invite insert failed:", insertErr?.message);
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, bookingId: (created as { id: string }).id, rawToken, expiresAt };
}

/** Look a booking up by its RAW token. Hashes before querying — the raw value
 *  never reaches a query predicate. */
export async function findBookingByToken(rawToken: string): Promise<Read<BookingRow | null>> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("interview_bookings")
    .select(ROW_COLUMNS)
    .eq("token_hash", hashBookingToken(rawToken))
    .maybeSingle();

  /*
   * `unavailable`, not null.
   *
   * Null means "no such token", and the route turns that into 404 →
   * "This booking link isn't valid. Check the link in your email." A candidate
   * who reads that about a link that IS valid does not refresh. They conclude
   * the interview fell through and they stop — which is the most expensive
   * failure in this codebase, because nobody ever finds out it happened.
   */
  if (error) {
    console.error("[booking] lookup failed:", error.message);
    return unavailable();
  }
  const row = (data as BookingRow | null) ?? null;
  /*
   * No applicant, no booking (#56 C-2, #96). The row outlives a deleted
   * applicant (application_id is ON DELETE SET NULL), and its link used to
   * keep working: GET, booking, rescheduling and cancelling all ran for
   * nobody. It now reads as no such link, on every method.
   */
  if (row && row.application_id === null) return answered(null);
  return answered(row);
}

/** Has this link run out, regardless of what the status column says? */
export function isExpired(row: BookingRow, now = Date.now()): boolean {
  if (row.status === "expired") return true;
  if (!row.expires_at) return false;
  const at = Date.parse(row.expires_at);
  return Number.isFinite(at) && at <= now;
}

/* ──────────────────── THE DOUBLE-BOOKING GATE ──────────────── */

export type ClaimOutcome =
  | { ok: true; row: BookingRow }
  | {
      ok: false;
      reason:
        | "already_booked"
        | "slot_taken"
        | "expired"
        | "not_found"
        | "write_failed"
        | "acknowledgement_required";
    };

/**
 * Claim a slot, atomically.
 *
 * ══ WHAT IS AND IS NOT GUARANTEED ═══════════════════════════
 *
 * TWO different double-bookings are possible, and they have different answers.
 * Being precise about which is which matters more than a reassuring sentence.
 *
 * 1. THE SAME CANDIDATE, TWICE — fully guaranteed, in the database.
 *
 *    A double-click, a retried request, or two tabs on the same link. The
 *    UPDATE below carries `.eq("status", "invited")` in its WHERE clause and
 *    returns the rows it actually transitioned. Postgres serialises the two
 *    statements on the row lock, so exactly one sees `invited` and the other
 *    matches nothing and gets zero rows back. This is the same conditional-
 *    UPDATE-as-a-gate the interview expiry and auto-shortlist paths use.
 *
 * 2. TWO DIFFERENT CANDIDATES, SAME HOST SLOT — **NOT** guaranteed by the
 *    database as the schema stands, and I am not going to claim otherwise.
 *
 *    Nothing in `interview_bookings` prevents two rows, with different tokens,
 *    holding overlapping times for one host. The unique key is on token_hash
 *    alone. The `overlapsExisting` pre-flight below closes the window to the
 *    few milliseconds between its SELECT and this UPDATE, which in practice
 *    catches essentially everything — two candidates would have to confirm the
 *    same slot within the same instant — but it is a check-then-act race and
 *    calling it a guarantee would be false.
 *
 *    THE CALENDAR IS NOT THE ARBITER EITHER. Google Calendar accepts
 *    overlapping events without complaint; it will happily place two
 *    interviews at 3pm. There is no layer below this one that says no.
 *
 *    The SQL that makes it a real guarantee is in the module footer. It is an
 *    EXCLUDE constraint rather than a unique index, because a unique index on
 *    (host_member_id, scheduled_start) would still permit a 60-minute booking
 *    starting at 15:00 to overlap a 30-minute one starting at 15:30 — the
 *    overlap is between RANGES, and only a range constraint expresses that.
 *
 *    This function is already written to work correctly once it exists:
 *    Postgres raises SQLSTATE 23P01 on violation, which is detected below and
 *    reported as `slot_taken`, the same outcome the pre-flight produces. When
 *    the constraint lands, no code here changes.
 */
export async function claimSlot(args: {
  row: BookingRow;
  startMs: number;
  endMs: number;
  candidateTimezone: string;
  hostTimezone: string;
  /**
   * The recording notice the candidate acknowledged, by version. REQUIRED for
   * a final round and written in the same UPDATE that books the slot, because
   * migration 038's CHECK refuses a booked final row without it. Ignored for
   * a screening call, which shows no notice.
   */
  recordingNotice?: { version: string } | null;
}): Promise<ClaimOutcome> {
  const service = createServiceClient();

  if (args.row.status === "booked") return { ok: false, reason: "already_booked" };
  if (isExpired(args.row)) return { ok: false, reason: "expired" };
  if (!isValidTimeZone(args.candidateTimezone)) {
    return { ok: false, reason: "write_failed" };
  }
  const isFinal = args.row.purpose === "final";
  if (isFinal && !args.recordingNotice?.version) {
    return { ok: false, reason: "acknowledgement_required" };
  }

  // Pre-flight. Narrows the cross-candidate window; does not close it.
  if (await overlapsExisting(args.row.host_member_id, args.startMs, args.endMs, args.row.id)) {
    return { ok: false, reason: "slot_taken" };
  }

  const bookedAt = new Date().toISOString();
  const { data, error } = await service
    .from("interview_bookings")
    .update({
      status: "booked",
      // ISO instants. The zones travel in their own columns; no local
      // timestamp is written anywhere.
      scheduled_start: new Date(args.startMs).toISOString(),
      scheduled_end: new Date(args.endMs).toISOString(),
      candidate_timezone: args.candidateTimezone,
      host_timezone: args.hostTimezone,
      booked_at: bookedAt,
      ...(isFinal && args.recordingNotice
        ? {
            recording_notice_acknowledged_at: bookedAt,
            recording_notice_version: args.recordingNotice.version,
          }
        : {}),
    })
    .eq("id", args.row.id)
    // THE GATE. Only a row still 'invited' transitions.
    .eq("status", "invited")
    .select(ROW_COLUMNS);

  if (error) {
    // 23P01 is exclusion_violation — raised only once the EXCLUDE constraint
    // in the footer exists. Until then this branch is unreachable, and after
    // it lands no other code needs to change.
    if ((error as { code?: string }).code === "23P01") {
      return { ok: false, reason: "slot_taken" };
    }
    console.error("[booking] claim failed:", error.message);
    return { ok: false, reason: "write_failed" };
  }

  const rows = (data ?? []) as BookingRow[];
  // Zero rows means somebody else won the gate between the read and the write.
  if (rows.length === 0) return { ok: false, reason: "already_booked" };

  const row = rows[0];
  if (!row) return { ok: false, reason: "write_failed" };
  return { ok: true, row };
}

/**
 * Does a confirmed booking already overlap this range for this host?
 *
 * Half-open comparison (`start < otherEnd && end > otherStart`) so a meeting
 * ending exactly when another begins is NOT an overlap — back-to-back is legal
 * at the database level; the 15-minute buffer that makes it undesirable is an
 * availability concern, applied when slots are offered.
 */
export async function overlapsExisting(
  hostMemberId: string,
  startMs: number,
  endMs: number,
  exceptBookingId?: string,
): Promise<boolean> {
  const service = createServiceClient();
  let query = service
    .from("interview_bookings")
    .select("id")
    .eq("host_member_id", hostMemberId)
    .eq("status", "booked")
    .lt("scheduled_start", new Date(endMs).toISOString())
    .gt("scheduled_end", new Date(startMs).toISOString());

  if (exceptBookingId) query = query.neq("id", exceptBookingId);

  const { data, error } = await query.limit(1);
  if (error) {
    /*
     * FAIL CLOSED. A failed overlap check must not be read as "no overlap" —
     * that turns a transient database blip into a confident double booking,
     * which is the exact outcome this whole function exists to avoid.
     */
    console.error("[booking] overlap check failed — refusing the slot:", error.message);
    return true;
  }
  return (data ?? []).length > 0;
}

/** Put the claim back when the calendar event could not be created. */
export async function releaseClaim(bookingId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from("interview_bookings")
    .update({
      status: "invited",
      scheduled_start: null,
      scheduled_end: null,
      booked_at: null,
    })
    .eq("id", bookingId)
    .eq("status", "booked");
  if (error) console.error("[booking] releaseClaim failed:", error.message);
}

/**
 * Place the meeting on the host's calendar and record what came back.
 *
 * ── Why the row is claimed BEFORE the event is created ───────
 *
 * The reverse order — create the event, then try to claim — leaves an orphan
 * meeting in a recruiter's calendar whenever the claim loses its race, and
 * deleting a remote event can itself fail. Claiming first means the only
 * failure to undo is a local row, and `releaseClaim` is reliable in a way a
 * remote delete is not.
 */
export async function attachCalendarEvent(args: {
  row: BookingRow;
  startMs: number;
  endMs: number;
  hostTimezone: string;
  summary: string;
  description: string;
  attendeeEmails: string[];
  manualUrl: string | null;
}): Promise<{ meetingUrl: string | null; meetingProvider: string | null; eventId: string | null }> {
  const service = createServiceClient();

  const { data: connRow } = await service
    .from("calendar_connections")
    .select("provider, calendar_id, provider_account")
    .eq("member_id", args.row.host_member_id)
    .eq("status", "active")
    .maybeSingle();

  const conn = connRow as {
    provider: string;
    calendar_id: string | null;
    provider_account: string | null;
  } | null;
  if (!conn) throw new Error("The interviewer's calendar is no longer connected.");

  const accessToken = await getAccessToken(args.row.host_member_id, conn.provider as "google");
  if (!accessToken) throw new Error("The interviewer's calendar needs reconnecting.");

  const provider = getProvider(conn.provider);
  if (!provider?.createEvent) throw new Error("This calendar provider cannot create events.");

  const created = await provider.createEvent(accessToken, {
    calendarId: conn.calendar_id ?? "primary",
    summary: args.summary,
    description: args.description,
    startMs: args.startMs,
    endMs: args.endMs,
    timeZone: args.hostTimezone,
    attendeeEmails: args.attendeeEmails,
    // Manual URL suppresses the provider conference request entirely.
    requestConferencing: !args.manualUrl,
    manualUrl: args.manualUrl,
  });

  const { error } = await service
    .from("interview_bookings")
    .update({
      provider_event_id: created.eventId || null,
      // The CALENDAR provider, recorded so session 3 knows which API to call
      // to move or cancel this event.
      provider: conn.provider,
      meeting_url: created.meetingUrl,
      // The MEETING mode is not the calendar provider — a Google Calendar
      // account need not have Meet. See CreatedEvent.meetingProvider.
      meeting_mode: created.meetingProvider === "manual" ? "manual" : "auto",
    })
    .eq("id", args.row.id);

  if (error) {
    /*
     * The event EXISTS but we failed to record its id. Loud, because session 3
     * needs provider_event_id to reschedule or cancel, and without it the only
     * way to move this meeting is by hand in the recruiter's calendar.
     */
    console.error("[booking] event created but not recorded — provider_event_id lost:", {
      bookingId: args.row.id,
      eventId: created.eventId,
      error: error.message,
    });
  }

  /*
   * Which account holds the event, as an HMAC (#56): a leftover event is
   * cleared automatically only when this same account reconnects. Its own
   * write: without the column (070 not applied) only the key is lost.
   */
  if (created.eventId) {
    const { data: keyRow } = await service
      .from("calendar_connections")
      .select("provider_account_key")
      .eq("member_id", args.row.host_member_id)
      .eq("status", "active")
      .maybeSingle();
    const storedKey = (keyRow as { provider_account_key: string | null } | null)
      ?.provider_account_key;
    const { error: keyError } = await service
      .from("interview_bookings")
      .update({
        provider_account_key:
          storedKey || accountKeyFromEmail(conn.provider, conn.provider_account) || "",
      })
      .eq("id", args.row.id)
      .eq("company_id", args.row.company_id);
    if (keyError) console.error(`[booking] account key not stored: ${keyError.code ?? "error"}`);
  }

  return {
    meetingUrl: created.meetingUrl,
    meetingProvider: created.meetingProvider,
    eventId: created.eventId || null,
  };
}

/**
 * The host's email address, resolved properly.
 *
 * ── What company_members.email is FOR, and why this exists ───
 *
 * It is the member's own address, and it is genuinely populated — the
 * invite-acceptance path (ai-dashboard/accept/actions.ts) writes `name` and
 * `email` when someone joins a team. The team list, the member search and the
 * hiring-team picker all read it.
 *
 * It is NULL for OWNERS, and that is a real bug rather than a quirk to route
 * around: owner provisioning in admin/companies/actions.ts inserts only
 * company_id, user_id, role and status — no name, no email. So every company's
 * founding member has a blank one, and the blank shows up anywhere that column
 * is read, not only here. That file is out of scope for this change and is
 * reported rather than edited.
 *
 * Given that, this does not TRUST the column:
 *
 *   1. company_members.email — correct when present, and the member's own
 *      choice, so it wins.
 *   2. auth.users.email via user_id — the authoritative address they actually
 *      sign in with. This is what makes an owner reachable today.
 *   3. companies.contact_email — the company's published address. A backstop,
 *      not a preference: on a multi-member team it may belong to somebody else
 *      entirely, which is why it is last.
 *
 * Returns null only when all three are empty, and the caller reports that as a
 * skipped notice rather than passing over it in silence.
 */
export async function resolveHostEmail(
  memberId: string,
  companyId: string,
): Promise<{ email: string | null; name: string | null; source: string }> {
  const service = createServiceClient();

  const { data: memberRow } = await service
    .from("company_members")
    .select("name, email, user_id")
    .eq("id", memberId)
    .maybeSingle();
  const member = memberRow as {
    name: string | null;
    email: string | null;
    user_id: string | null;
  } | null;

  const fromMember = (member?.email ?? "").trim();
  if (fromMember)
    return { email: fromMember, name: member?.name ?? null, source: "company_members" };

  if (member?.user_id) {
    // The service client can read auth.users through the admin API.
    const { data: authUser } = await service.auth.admin.getUserById(member.user_id);
    const fromAuth = (authUser?.user?.email ?? "").trim();
    if (fromAuth) return { email: fromAuth, name: member?.name ?? null, source: "auth.users" };
  }

  const { data: companyRow } = await service
    .from("companies")
    .select("contact_email, contact_name")
    .eq("id", companyId)
    .maybeSingle();
  const company = companyRow as {
    contact_email: string | null;
    contact_name: string | null;
  } | null;
  const fromCompany = (company?.contact_email ?? "").trim();
  if (fromCompany) {
    return {
      email: fromCompany,
      name: member?.name ?? company?.contact_name ?? null,
      source: "companies.contact_email",
    };
  }

  console.error("[booking] no host email could be resolved:", { memberId, companyId });
  return { email: null, name: member?.name ?? null, source: "none" };
}

/* ─────────────────────── reschedule ────────────────────────── */

export type MoveOutcome =
  | { ok: true; row: BookingRow; previousStart: string }
  | {
      ok: false;
      reason: "too_late" | "slot_taken" | "not_booked" | "provider_failed" | "write_failed";
    };

/**
 * Move an existing booking to a new time. ONE row, ONE history.
 *
 * ── Not a cancel plus a new booking ──────────────────────────
 *
 * The row keeps its id, its token and its provider_event_id. The application
 * therefore keeps a single booking with a single history, and the candidate's
 * original link still works — a link that died on every reschedule would
 * strand anyone who opened the email again.
 *
 * ── What wins when the claim and the provider disagree ───────
 *
 * The database moves first, then the provider. If the provider call fails, the
 * database move is ROLLED BACK to the original time and the caller is told the
 * move did not happen.
 *
 * That direction is deliberate. The provider is the copy both humans can see:
 * it is in the recruiter's calendar, it sends the notifications, it holds the
 * Meet link. If the two disagree, the one nobody looks at has to yield. The
 * alternative — keep the new time locally and let the calendar lag — produces
 * two parties who each believe a different hour and no way to tell which is
 * real. A rollback leaves everything exactly as it was and asks them to try
 * again, which is a state both sides already understand.
 *
 * The rollback is a local UPDATE, and local writes are reliable in a way a
 * remote retry is not. The window where the row holds the new time is the
 * duration of one HTTP call.
 */
export async function rescheduleBooking(args: {
  row: BookingRow;
  startMs: number;
  endMs: number;
  hostTimezone: string;
  candidateTimezone?: string | null;
}): Promise<MoveOutcome> {
  const service = createServiceClient();
  const previousStart = args.row.scheduled_start ?? "";

  if (args.row.status !== "booked") return { ok: false, reason: "not_booked" };
  if (!canReschedule(args.row)) return { ok: false, reason: "too_late" };

  // Same pre-flight as the first booking. Excludes THIS row, which legitimately
  // occupies its own current time.
  if (await overlapsExisting(args.row.host_member_id, args.startMs, args.endMs, args.row.id)) {
    return { ok: false, reason: "slot_taken" };
  }

  const patch: Record<string, unknown> = {
    scheduled_start: new Date(args.startMs).toISOString(),
    scheduled_end: new Date(args.endMs).toISOString(),
    host_timezone: args.hostTimezone,
  };
  // The candidate may have corrected their zone on the way through; only
  // overwrite when they actually supplied one.
  if (args.candidateTimezone) patch.candidate_timezone = args.candidateTimezone;

  const { data, error } = await service
    .from("interview_bookings")
    .update(patch)
    .eq("id", args.row.id)
    // THE GATE, same shape as the original claim: only a row still 'booked'
    // moves, so two simultaneous reschedules cannot both win.
    .eq("status", "booked")
    .eq("scheduled_start", previousStart)
    .select(ROW_COLUMNS);

  if (error) {
    // 23P01 is the EXCLUDE constraint — the new slot belongs to someone else.
    if ((error as { code?: string }).code === "23P01") return { ok: false, reason: "slot_taken" };
    console.error("[booking] reschedule write failed:", error.message);
    return { ok: false, reason: "write_failed" };
  }

  const moved = ((data ?? []) as BookingRow[])[0];
  // Zero rows means somebody moved or cancelled it between the read and this
  // write.
  if (!moved) return { ok: false, reason: "not_booked" };

  const event = await withProviderEvent(moved);
  if (!event) {
    /*
     * No event to move — the booking exists but was never recorded against a
     * provider event. The times are updated and the caller is told; there is
     * nothing to roll back to, since the calendar never had it.
     */
    console.error("[booking] rescheduled a booking with no provider_event_id:", moved.id);
    return { ok: true, row: moved, previousStart };
  }

  try {
    await event.provider.updateEventTime?.(event.accessToken, {
      calendarId: event.calendarId,
      eventId: event.eventId,
      startMs: args.startMs,
      endMs: args.endMs,
      timeZone: args.hostTimezone,
    });
  } catch (err) {
    console.error("[booking] calendar move failed — rolling the row back:", err);
    const { error: rollbackErr } = await service
      .from("interview_bookings")
      .update({
        scheduled_start: previousStart,
        scheduled_end: args.row.scheduled_end,
        host_timezone: args.row.host_timezone,
        candidate_timezone: args.row.candidate_timezone,
      })
      .eq("id", moved.id);
    if (rollbackErr) {
      /*
       * Both the provider move AND the rollback failed. The row now says a time
       * the calendar does not. Loud, because this is the only path that can
       * leave the two genuinely out of step and it needs a human.
       */
      console.error("[booking] ROLLBACK FAILED — row and calendar disagree:", {
        bookingId: moved.id,
        rowSaysStart: patch.scheduled_start,
        calendarSaysStart: previousStart,
        error: rollbackErr.message,
      });
    }
    return { ok: false, reason: "provider_failed" };
  }

  return { ok: true, row: moved, previousStart };
}

/* ───────────────────────── cancel ──────────────────────────── */

export type CancelOutcome =
  | { ok: true; row: BookingRow; removedFromCalendar: boolean }
  | { ok: false; reason: "too_late" | "not_booked" | "write_failed" };

/**
 * Cancel a booking. Allowed right up to the start.
 *
 * ── What a failed provider delete does ───────────────────────
 *
 * The cancellation goes through anyway, and the caller is told the calendar
 * was not confirmed.
 *
 * This is the opposite resolution to reschedule, and deliberately so. A
 * reschedule that half-lands leaves two live-but-different times, so it must
 * be undone. A cancellation that half-lands leaves ONE stale entry in a diary
 * — annoying, not ambiguous — while refusing it would trap someone who cannot
 * attend inside a meeting they have already told us they are not coming to.
 * The information is what matters, and the emails carry it regardless of what
 * Google did.
 *
 * `removedFromCalendar: false` travels back so both the recruiter's UI and the
 * emails can say the entry may still be in the diary, rather than claiming a
 * tidiness we did not achieve. The provider's delete already treats 404/410 as
 * success, so this only reports a genuine "could not tell".
 */
export async function cancelBooking(args: {
  row: BookingRow;
  cancelledBy: BookingActor;
  reason?: string | null;
}): Promise<CancelOutcome> {
  const service = createServiceClient();

  if (args.row.status !== "booked") return { ok: false, reason: "not_booked" };
  if (!canCancel(args.row)) return { ok: false, reason: "too_late" };

  /*
   * The calendar is cleared FIRST, while the row still names the event.
   *
   * If the local write then failed we would have deleted an event for a
   * booking that still reads 'booked' — recoverable, because the next cancel
   * attempt treats an already-gone event as success. The reverse order risks
   * cancelling locally and then losing the event id, which strands the entry
   * in the diary with nothing left pointing at it.
   */
  let removedFromCalendar = false;
  const event = await withProviderEvent(args.row);
  if (!event) {
    // Nothing to remove. Not a failure — say so honestly rather than implying
    // we cleaned up a calendar that never had it.
    removedFromCalendar = true;
  } else {
    removedFromCalendar =
      (await event.provider.deleteEvent?.(event.accessToken, {
        calendarId: event.calendarId,
        eventId: event.eventId,
      })) ?? false;
    if (!removedFromCalendar) {
      console.error("[booking] calendar delete did not confirm; cancelling locally anyway:", {
        bookingId: args.row.id,
        eventId: event.eventId,
      });
    }
  }

  const { data, error } = await service
    .from("interview_bookings")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by: args.cancelledBy,
      cancel_reason: (args.reason ?? "").trim().slice(0, CANCEL_REASON_MAX) || null,
      // An event Google confirmed gone has nothing left to point at (#56). One
      // that did not confirm keeps its id, so the applicant's delete can still
      // remove it (cancelScreeningBookingsForDeletion).
      ...(event && removedFromCalendar ? { provider_event_id: null } : {}),
    })
    .eq("id", args.row.id)
    // Same single-winner gate. Two cancels race safely; one wins, one is told
    // it is already cancelled.
    .eq("status", "booked")
    .select(ROW_COLUMNS);

  if (error) {
    console.error("[booking] cancel write failed:", error.message);
    return { ok: false, reason: "write_failed" };
  }
  const cancelled = ((data ?? []) as BookingRow[])[0];
  if (!cancelled) return { ok: false, reason: "not_booked" };

  return { ok: true, row: cancelled, removedFromCalendar };
}

export type DeletionBookingsOutcome =
  /**
   * `eventsLeft`, only when above 0: rows that still name a Google event this
   * delete could not reach, because the host's calendar is no longer
   * connected. The delete goes ahead; the recruiter is told to remove it.
   */
  | { ok: true; cancelled: number; eventsLeft?: number }
  /** Google did not confirm the event was removed, or could not be reached: nothing changed. */
  | { ok: false; failure: "calendar" }
  /** The bookings could not be read or marked: nothing changed that a retry would not redo. */
  | { ok: false; failure: "database" };

/** What the delete must do about one booking row; null when it should not touch it. */
function deletionStepFor(row: BookingRow): "cancel" | "clear-event" | null {
  if (row.status === "booked") return canCancel(row) ? "cancel" : null;
  if (row.status === "invited") return "cancel";
  if (row.status === "cancelled" && row.provider_event_id) return "clear-event";
  return null;
}

/**
 * Before an applicant is deleted (#61, #56): nothing of theirs may be left on a
 * host's Google Calendar, and no booking link of theirs may keep working. With
 * no email to anyone.
 *
 * The rows, all screening (purpose 'interview') bookings of this applicant:
 *   - booked, still ahead (canCancel): the event is removed, then the row is
 *     cancelled;
 *   - invited, never booked (#56 C-2, #96): cancelled, so its link dies with
 *     the applicant (findBookingByToken also refuses a row whose applicant is
 *     gone);
 *   - cancelled but still holding an event id: a recruiter's cancel whose
 *     Google delete did not confirm (cancelBooking keeps the id for exactly
 *     this). The event is removed now and the id cleared.
 * A call already started or past, an expired or completed row, and final-round
 * bookings are left as they are.
 *
 * The calendar goes first and a calendar that does not confirm STOPS the
 * delete: the applicant is about to vanish, and an event left in the host's
 * diary would point at nobody, with no row left to cancel it from. So:
 *   - no event id: nothing to remove; the row is just written;
 *   - an event id but no active calendar connection (or no provider): nothing
 *     we can reach. The delete goes ahead and the row is written, and the
 *     outcome counts it in `eventsLeft`, so the recruiter is told to remove
 *     the event from the host's calendar themselves;
 *   - a connected calendar whose token cannot be had, or whose delete does not
 *     confirm (google.ts deleteEvent: 410, or a 404 on a calendar it can read,
 *     is gone; a 404 on one it cannot read is not): refused there; that row
 *     and the ones after it are untouched, and a retry finishes them;
 *   - the event deleted SILENTLY (sendUpdates=none): no Google email to the
 *     candidate either.
 * Every confirmed delete clears provider_event_id in the same write.
 *
 * Retry-safe in every order: an event already deleted reads as success, and
 * each write is gated on the status it read.
 */
export async function cancelScreeningBookingsForDeletion(
  companyId: string,
  applicationId: string,
): Promise<DeletionBookingsOutcome> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("interview_bookings")
    .select(ROW_COLUMNS)
    .eq("company_id", companyId)
    .eq("application_id", applicationId)
    .eq("purpose", "interview")
    .in("status", ["booked", "invited", "cancelled"]);
  if (error) {
    console.error(`[booking] applicant delete: bookings read failed: ${error.code ?? "error"}`);
    return { ok: false, failure: "database" };
  }

  let cancelled = 0;
  let eventsLeft = 0;
  for (const row of (data ?? []) as BookingRow[]) {
    const step = deletionStepFor(row);
    if (!step) continue;

    let eventGone = false;
    if (row.provider_event_id) {
      const { data: connRow, error: connErr } = await service
        .from("calendar_connections")
        .select("provider, calendar_id")
        .eq("member_id", row.host_member_id)
        .eq("status", "active")
        .maybeSingle();
      if (connErr) {
        console.error(
          `[booking] applicant delete: connection read failed: ${connErr.code ?? "error"}`,
        );
        return { ok: false, failure: "database" };
      }
      const conn = connRow as { provider: string; calendar_id: string | null } | null;
      const provider = conn ? getProvider(row.provider ?? conn.provider) : null;
      if (conn && provider?.deleteEvent) {
        const accessToken = await getAccessToken(row.host_member_id, conn.provider as "google");
        const removed = accessToken
          ? await provider.deleteEvent(accessToken, {
              calendarId: conn.calendar_id ?? "primary",
              eventId: row.provider_event_id,
              silent: true,
            })
          : false;
        if (!removed) {
          console.error("[booking] applicant delete: calendar delete did not confirm", {
            bookingId: row.id,
          });
          return { ok: false, failure: "calendar" };
        }
        eventGone = true;
        // Removed after all (e.g. reconnected before this retry): an earlier
        // attempt's pending record of it is no longer true (#56).
        const { error: dropErr } = await service
          .from("calendar_cleanups")
          .delete()
          .eq("company_id", companyId)
          .eq("provider_event_id", row.provider_event_id)
          .eq("pending_application_id", applicationId)
          .eq("status", "pending");
        if (dropErr) return { ok: false, failure: "database" };
      } else {
        // Not connected any more: nothing to call, so the delete goes ahead and
        // the event is recorded for the lasting alert (#56, cleanups.ts):
        // PENDING until the whole delete has succeeded. If it cannot be
        // recorded the delete stops, so the event never ends up with nothing
        // pointing at it; a retry records nothing twice.
        const recorded = await recordPendingCleanup(service, companyId, applicationId, {
          bookingId: row.id,
          hostMemberId: row.host_member_id,
          provider: row.provider ?? conn?.provider ?? "google",
          eventId: row.provider_event_id,
          eventStart: row.scheduled_start,
        });
        if (!recorded) return { ok: false, failure: "database" };
        eventsLeft += 1;
      }
    }

    // A cancelled row whose event could not be reached (no connection): left as it is.
    if (step === "clear-event" && !eventGone) continue;

    const write =
      step === "cancel"
        ? {
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
            cancelled_by: "recruiter",
            cancel_reason: null,
            ...(eventGone ? { provider_event_id: null } : {}),
          }
        : { provider_event_id: null };
    const { error: writeErr } = await service
      .from("interview_bookings")
      .update(write)
      .eq("id", row.id)
      .eq("company_id", companyId)
      .eq("status", row.status);
    if (writeErr) {
      console.error(`[booking] applicant delete: write failed: ${writeErr.code ?? "error"}`);
      return { ok: false, failure: "database" };
    }
    if (step === "cancel") cancelled += 1;
  }
  return eventsLeft > 0 ? { ok: true, cancelled, eventsLeft } : { ok: true, cancelled };
}

/**
 * Resolve everything needed to act on a booking's provider event, or null when
 * there is nothing to act on.
 *
 * Shared by reschedule and cancel so the connection lookup, the token refresh
 * and the "no event id recorded" case are handled identically in both.
 */
async function withProviderEvent(row: BookingRow): Promise<{
  provider: NonNullable<ReturnType<typeof getProvider>>;
  accessToken: string;
  calendarId: string;
  eventId: string;
} | null> {
  if (!row.provider_event_id) return null;

  const service = createServiceClient();
  const { data: connRow } = await service
    .from("calendar_connections")
    .select("provider, calendar_id")
    .eq("member_id", row.host_member_id)
    .eq("status", "active")
    .maybeSingle();

  const conn = connRow as { provider: string; calendar_id: string | null } | null;
  if (!conn) return null;

  const provider = getProvider(row.provider ?? conn.provider);
  if (!provider) return null;

  // THE SEAM. Never refreshes inline — see connections.ts.
  const accessToken = await getAccessToken(row.host_member_id, conn.provider as "google");
  if (!accessToken) return null;

  return {
    provider,
    accessToken,
    calendarId: conn.calendar_id ?? "primary",
    eventId: row.provider_event_id,
  };
}

/*
 * ══════════════════════════════════════════════════════════════
 * SQL REQUIRED TO MAKE THE CROSS-CANDIDATE GUARANTEE REAL
 * ══════════════════════════════════════════════════════════════
 *
 * NOT RUN. Reported for review, per the standing rule on schema changes.
 *
 *   CREATE EXTENSION IF NOT EXISTS btree_gist;
 *
 *   ALTER TABLE interview_bookings
 *     ADD CONSTRAINT interview_bookings_no_host_overlap
 *     EXCLUDE USING gist (
 *       host_member_id WITH =,
 *       tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
 *     )
 *     WHERE (status = 'booked');
 *
 * Why each part:
 *
 *   · EXCLUDE, not UNIQUE. Overlap is a relation between RANGES. A unique
 *     index on (host_member_id, scheduled_start) permits a 60-minute booking
 *     at 15:00 to sit across a 30-minute one at 15:30 — different start
 *     values, same host, genuinely double-booked.
 *   · btree_gist, because the constraint mixes an equality operator on a uuid
 *     with an overlap operator on a range, and plain gist cannot index the
 *     uuid side.
 *   · '[)' bounds, so a meeting ending at 15:00 and one starting at 15:00 do
 *     NOT collide. Back-to-back is legal; the 15-minute buffer that
 *     discourages it belongs to availability, not to the constraint.
 *   · WHERE (status = 'booked'), so cancelled and expired rows — which keep
 *     their scheduled_start for the audit trail — do not block the slot they
 *     used to hold.
 *
 * Until this exists, claimSlot's pre-flight is a narrow check-then-act race,
 * not a guarantee. Once it exists, claimSlot already handles the violation.
 */
