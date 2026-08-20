import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
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

export function mintBookingToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashBookingToken(rawToken) };
}

export function hashBookingToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** The URL a candidate opens. Raw token, never the hash. */
export function bookingUrl(rawToken: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://remotiv.work";
  return `${base}/book/${rawToken}`;
}

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
};

const ROW_COLUMNS =
  "id, company_id, application_id, job_id, host_member_id, duration_minutes, status, scheduled_start, scheduled_end, candidate_timezone, host_timezone, meeting_mode, meeting_url, provider_event_id, provider, expires_at";

/** Look a booking up by its RAW token. Hashes before querying — the raw value
 *  never reaches a query predicate. */
export async function findBookingByToken(rawToken: string): Promise<BookingRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("interview_bookings")
    .select(ROW_COLUMNS)
    .eq("token_hash", hashBookingToken(rawToken))
    .maybeSingle();

  if (error) {
    console.error("[booking] lookup failed:", error.message);
    return null;
  }
  return (data as BookingRow | null) ?? null;
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
      reason: "already_booked" | "slot_taken" | "expired" | "not_found" | "write_failed";
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
}): Promise<ClaimOutcome> {
  const service = createServiceClient();

  if (args.row.status === "booked") return { ok: false, reason: "already_booked" };
  if (isExpired(args.row)) return { ok: false, reason: "expired" };
  if (!isValidTimeZone(args.candidateTimezone)) {
    return { ok: false, reason: "write_failed" };
  }

  // Pre-flight. Narrows the cross-candidate window; does not close it.
  if (await overlapsExisting(args.row.host_member_id, args.startMs, args.endMs, args.row.id)) {
    return { ok: false, reason: "slot_taken" };
  }

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
      booked_at: new Date().toISOString(),
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
    .select("provider, calendar_id")
    .eq("member_id", args.row.host_member_id)
    .eq("status", "active")
    .maybeSingle();

  const conn = connRow as { provider: string; calendar_id: string | null } | null;
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

  return {
    meetingUrl: created.meetingUrl,
    meetingProvider: created.meetingProvider,
    eventId: created.eventId || null,
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
