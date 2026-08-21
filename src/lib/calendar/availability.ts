import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getAccessToken } from "./connections";
import { getProvider } from "./provider";
import {
  addLocalDays,
  DAY_MS,
  HOUR_MS,
  localWeekday,
  MINUTE_MS,
  wallClockAt,
  zonedWallToUtc,
} from "./timezone";

/**
 * Which slots a candidate may book.
 *
 * ── The pipeline, in order ───────────────────────────────────
 *
 *   working hours (host's zone)      what the host has said they will work
 *     ∩ booking window               14 days out, no further
 *     − notice window                nothing inside 24 hours
 *     − busy (provider free/busy)    real commitments, with a buffer
 *     = offered slots                as UTC instants
 *
 * ── Everything after the first step is UTC arithmetic ────────
 *
 * Working hours are the ONLY place a wall clock appears. Each day's window is
 * converted to a pair of UTC instants once, and every operation after that —
 * stepping, buffering, subtracting busy, comparing — is integer millisecond
 * arithmetic on instants. There is no "add an hour to 2:30pm" anywhere, which
 * is the operation that breaks twice a year.
 *
 * That also makes the DST behaviour fall out correctly rather than needing
 * special cases: a local 09:00-17:00 window on a spring-forward day converts
 * to seven real hours, and to nine on a fall-back day, because that is how
 * many hours those days actually have.
 */

/** Nothing sooner than this. A candidate needs time to prepare and travel. */
export const MIN_NOTICE_MS = 24 * HOUR_MS;
/** Dead time either side of a meeting, so back-to-backs are not offered. */
export const BUFFER_MS = 15 * MINUTE_MS;
/** How far ahead a candidate may book. */
export const BOOKING_WINDOW_DAYS = 14;
/**
 * The cadence slot starts are aligned to. Offers read 09:00, 09:15, 09:30 —
 * never 09:07.
 */
export const SLOT_GRID_MINUTES = 15;

/**
 * How far apart two offered starts sit, for a given duration.
 *
 * ── Why this is derived and not a constant ───────────────────
 *
 * A fixed 30-minute grid was fine while every interview was 30 or 60. With a
 * free-form duration it breaks: a 45-minute interview on a 30-minute grid
 * offers 09:00 and 09:30, and those two OVERLAP — 09:00–09:45 runs through
 * 09:30. Both would appear as choosable, one would silently disappear the
 * moment the other was taken, and the page would have advertised more
 * availability than exists.
 *
 * So the step is the duration itself, rounded UP to the grid so the times stay
 * human:
 *
 *   15 min → step 15 → 09:00, 09:15, 09:30 …
 *   30 min → step 30 → 09:00, 09:30, 10:00 …   (unchanged)
 *   45 min → step 45 → 09:00, 09:45, 10:30 …
 *   60 min → step 60 → 09:00, 10:00, 11:00 …   (unchanged)
 *   50 min → step 60 → 09:00, 10:00, 11:00 …   (rounded up; never overlaps)
 *
 * Offered slots therefore never overlap each other, and the two common
 * durations behave exactly as they did before.
 *
 * The BUFFER is deliberately not added here. It is not dead time the host owes
 * every gap — it is a margin around REAL commitments, applied in subtractBusy.
 * Adding it to the step would space a 30-minute interview 45 minutes apart and
 * quietly cut a 9-5 day's offers by a third for no gain, since a booked slot
 * removes its neighbours through free/busy on the very next read anyway.
 */
export function slotStepMinutes(durationMinutes: number): number {
  const grid = SLOT_GRID_MINUTES;
  return Math.max(grid, Math.ceil(durationMinutes / grid) * grid);
}

/**
 * Cap on how many slots are OFFERED, and why there is one.
 *
 * A host with an empty calendar and 9-5 hours has roughly 160 half-hour starts
 * over fourteen days. Rendering all of them is technically correct and
 * unusable: it reads as a wall of identical buttons, gives no reason to prefer
 * any, and makes the page feel like work. See `thinSlots` — the cap is applied
 * by spreading across days, not by truncating, so a candidate who can only do
 * Fridays still sees Fridays.
 */
export const MAX_SLOTS_OFFERED = 40;
/** At most this many per day, so one empty day cannot swallow the whole cap. */
export const MAX_SLOTS_PER_DAY = 6;

export type WorkingRule = { weekday: number; startMinute: number; endMinute: number };

/** Mon-Fri, 09:00-17:00 in the host's own zone. Used until they set their own. */
export const DEFAULT_WORKING_RULES: WorkingRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

export type Slot = {
  /** ISO instant. The only representation that crosses a boundary. */
  startIso: string;
  endIso: string;
};

export type AvailabilityResult =
  | { ok: true; slots: Slot[]; hostTimezone: string; truncated: boolean }
  /**
   * Availability could not be established. NOT an empty list — see below.
   */
  | { ok: false; reason: "no_connection" | "revoked" | "unreadable"; hostTimezone: string | null };

/* ───────────────────────── working hours ───────────────────── */

/**
 * The host's rules, or the job's override, or the default.
 *
 * Precedence is job → member → default. A job override exists because a role
 * can need hours the recruiter does not normally work — a night-shift support
 * role interviewed in the candidate's evening — without rewriting the
 * recruiter's own defaults for every other job they run.
 */
export function resolveWorkingRules(
  memberRules: WorkingRule[],
  jobOverride: unknown,
): WorkingRule[] {
  const parsed = parseRules(jobOverride);
  if (parsed.length > 0) return parsed;
  if (memberRules.length > 0) return memberRules;
  return DEFAULT_WORKING_RULES;
}

/** Validate a jsonb override into rules, dropping anything malformed. */
export function parseRules(raw: unknown): WorkingRule[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkingRule[] = [];
  for (const entry of raw) {
    const e = entry as { weekday?: unknown; startMinute?: unknown; endMinute?: unknown };
    const weekday = Number(e?.weekday);
    const startMinute = Number(e?.startMinute);
    const endMinute = Number(e?.endMinute);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) continue;
    if (startMinute < 0 || endMinute > 24 * 60 || endMinute <= startMinute) continue;
    out.push({ weekday, startMinute, endMinute });
  }
  return out;
}

/* ──────────────────────── slot generation ──────────────────── */

export type BusyInterval = { start: number; end: number };

/**
 * Build candidate slots from working hours alone — no calendar involved.
 *
 * Exported separately from the provider call so it is testable without a
 * network, and so the provider failure path cannot be confused with the
 * empty-hours path.
 */
export function generateSlots(args: {
  now: number;
  hostTimezone: string;
  rules: WorkingRule[];
  durationMinutes: number;
}): number[] {
  const { now, hostTimezone, rules, durationMinutes } = args;
  const durationMs = durationMinutes * MINUTE_MS;
  const earliest = now + MIN_NOTICE_MS;
  const latest = now + BOOKING_WINDOW_DAYS * DAY_MS;

  const byWeekday = new Map<number, WorkingRule[]>();
  for (const rule of rules) {
    byWeekday.set(rule.weekday, [...(byWeekday.get(rule.weekday) ?? []), rule]);
  }

  const starts: number[] = [];
  // Start from the host's local date TODAY, then walk calendar days. Walking
  // by +24h would drift onto the wrong local date across a transition.
  const today = wallClockAt(now, hostTimezone);

  // +1 so the final partial day inside the window is still considered.
  for (let dayOffset = 0; dayOffset <= BOOKING_WINDOW_DAYS + 1; dayOffset += 1) {
    const date = addLocalDays(today, dayOffset);
    const dayRules = byWeekday.get(localWeekday(date)) ?? [];

    for (const rule of dayRules) {
      const open = zonedWallToUtc(
        { ...date, hour: Math.floor(rule.startMinute / 60), minute: rule.startMinute % 60 },
        hostTimezone,
      );
      const close = zonedWallToUtc(
        { ...date, hour: Math.floor(rule.endMinute / 60), minute: rule.endMinute % 60 },
        hostTimezone,
      );

      /*
       * A working-hours BOUNDARY that lands in the spring-forward gap is
       * clamped to the instant the clock jumps to — "we open at 02:00" on a
       * day with no 02:00 sensibly means "we open when the day starts". A
       * SLOT at a non-existent time is a different matter and is dropped
       * below, because offering a candidate a time their clock will never
       * show is how you get someone dialling in an hour late.
       */
      const stepMs = slotStepMinutes(durationMinutes) * MINUTE_MS;
      for (let start = open.ms; start + durationMs <= close.ms; start += stepMs) {
        if (start < earliest) continue;
        if (start > latest) break;
        // The gap check: does this instant read back as a real wall time?
        const local = wallClockAt(start, hostTimezone);
        const roundTrip = zonedWallToUtc(local, hostTimezone);
        if (roundTrip.skipped) continue;
        starts.push(start);
      }
    }
  }

  // A fall-back day can generate the same instant twice if two rules overlap.
  return [...new Set(starts)].sort((a, b) => a - b);
}

/**
 * Remove anything colliding with a busy interval, buffer included.
 *
 * The buffer is applied to the BUSY side rather than the slot side so it
 * behaves symmetrically: a meeting ending at 10:00 blocks a 10:00 start, and a
 * meeting starting at 11:00 blocks a slot that would end at 11:00.
 */
export function subtractBusy(
  starts: number[],
  busy: BusyInterval[],
  durationMinutes: number,
): number[] {
  if (busy.length === 0) return starts;
  const durationMs = durationMinutes * MINUTE_MS;

  return starts.filter((start) => {
    const end = start + durationMs;
    return !busy.some((b) => start < b.end + BUFFER_MS && end > b.start - BUFFER_MS);
  });
}

/**
 * Reduce a wall of slots to a choosable set.
 *
 * ── Why this is not a truncation ─────────────────────────────
 *
 * Taking the first 40 of 160 slots would offer the next four days and hide the
 * other ten — which silently removes every option for a candidate who is busy
 * this week, and does it invisibly. Instead this takes up to
 * MAX_SLOTS_PER_DAY from EACH day, spread evenly across that day's available
 * starts, so morning and afternoon both survive and every day with any
 * availability is represented.
 *
 * The result is an offer a person can actually read: a few times a day, across
 * the whole window, rather than every legal instant.
 */
export function thinSlots(
  starts: number[],
  hostTimezone: string,
): { slots: number[]; truncated: boolean } {
  if (starts.length === 0) return { slots: [], truncated: false };

  const byDay = new Map<string, number[]>();
  for (const start of starts) {
    const w = wallClockAt(start, hostTimezone);
    const key = `${w.year}-${w.month}-${w.day}`;
    byDay.set(key, [...(byDay.get(key) ?? []), start]);
  }

  const days = [...byDay.values()];

  /*
   * The per-day budget is derived from the TOTAL cap and the number of days
   * that actually have availability, so the sum fits without a tail slice.
   *
   * An earlier version took MAX_SLOTS_PER_DAY from every day and then sliced
   * the result to the total — which quietly deleted the last few days of the
   * fortnight, the exact truncation this function exists to avoid. A candidate
   * who is away this week would have been shown nothing they could take.
   * Floor of 1 so no day with availability disappears entirely.
   */
  const perDay = Math.max(
    1,
    Math.min(MAX_SLOTS_PER_DAY, Math.floor(MAX_SLOTS_OFFERED / days.length)),
  );

  const picked: number[] = [];
  for (const dayStarts of days) {
    if (dayStarts.length <= perDay) {
      picked.push(...dayStarts);
      continue;
    }
    if (perDay === 1) {
      // One slot: take the middle of the day rather than the first, which is
      // usually the least convenient hour for both sides.
      const middle = dayStarts[Math.floor(dayStarts.length / 2)];
      if (middle !== undefined) picked.push(middle);
      continue;
    }
    // Evenly spaced, so the first and last of the day are both kept and the
    // rest spread across it rather than clustering in the morning.
    const step = (dayStarts.length - 1) / (perDay - 1);
    for (let i = 0; i < perDay; i += 1) {
      const value = dayStarts[Math.round(i * step)];
      if (value !== undefined) picked.push(value);
    }
  }

  const unique = [...new Set(picked)].sort((a, b) => a - b);
  return { slots: unique, truncated: unique.length < starts.length };
}

/* ─────────────────────── the whole pipeline ────────────────── */

/**
 * Everything a candidate may book with this host.
 *
 * ── A connection we cannot read is NOT an empty calendar ─────
 *
 * When the connection is missing, revoked, or the provider call fails, this
 * returns `ok: false` with a reason — never `slots: []`.
 *
 * The distinction is the whole point. Offering slots we could not check
 * against a calendar we cannot read is worse than offering none: it produces
 * confident double-bookings, and the recruiter finds out when two people
 * arrive. Returning an empty list would be almost as bad in the other
 * direction — the candidate reads "no times available", waits, and nobody
 * learns the integration is broken. `ok: false` lets the page say "we can't
 * show times right now" and lets the recruiter's settings page say the
 * calendar needs reconnecting, which are the two things that get it fixed.
 */
export async function fetchAvailability(args: {
  hostMemberId: string;
  jobId: string | null;
  durationMinutes: number;
  now?: number;
}): Promise<AvailabilityResult> {
  const now = args.now ?? Date.now();
  const service = createServiceClient();

  const { data: connRow } = await service
    .from("calendar_connections")
    .select("provider, calendar_id, timezone, status")
    .eq("member_id", args.hostMemberId)
    .eq("status", "active")
    .maybeSingle();

  const conn = connRow as {
    provider: string;
    calendar_id: string | null;
    timezone: string | null;
    status: string;
  } | null;

  if (!conn) return { ok: false, reason: "no_connection", hostTimezone: null };

  // A calendar with no zone cannot be reasoned about — session 1 stores null
  // rather than guessing UTC, and this is where that refusal is honoured.
  const hostTimezone = conn.timezone;
  if (!hostTimezone) return { ok: false, reason: "unreadable", hostTimezone: null };

  const [{ data: ruleRows }, { data: jobRow }] = await Promise.all([
    service
      .from("availability_rules")
      .select("weekday, start_minute, end_minute")
      .eq("member_id", args.hostMemberId)
      .order("weekday", { ascending: true }),
    args.jobId
      ? service.from("jobs").select("booking_hours_override").eq("id", args.jobId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const memberRules: WorkingRule[] = (
    (ruleRows ?? []) as {
      weekday: number;
      start_minute: number;
      end_minute: number;
    }[]
  ).map((r) => ({ weekday: r.weekday, startMinute: r.start_minute, endMinute: r.end_minute }));

  const rules = resolveWorkingRules(
    memberRules,
    (jobRow as { booking_hours_override?: unknown } | null)?.booking_hours_override,
  );

  const candidates = generateSlots({
    now,
    hostTimezone,
    rules,
    durationMinutes: args.durationMinutes,
  });
  if (candidates.length === 0) {
    return { ok: true, slots: [], hostTimezone, truncated: false };
  }

  // THE SEAM. Never refreshes inline — see connections.ts.
  const accessToken = await getAccessToken(args.hostMemberId, conn.provider as "google");
  if (!accessToken) return { ok: false, reason: "revoked", hostTimezone };

  const provider = getProvider(conn.provider);
  if (!provider?.freeBusy) return { ok: false, reason: "unreadable", hostTimezone };

  let busy: BusyInterval[];
  try {
    busy = await provider.freeBusy(accessToken, {
      calendarId: conn.calendar_id ?? "primary",
      startMs: now,
      endMs: now + (BOOKING_WINDOW_DAYS + 1) * DAY_MS,
    });
  } catch (err) {
    // Deliberately NOT an empty slot list. See the note above.
    console.error("[calendar] free/busy read failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "unreadable", hostTimezone };
  }

  const free = subtractBusy(candidates, busy, args.durationMinutes);
  const { slots, truncated } = thinSlots(free, hostTimezone);

  const durationMs = args.durationMinutes * MINUTE_MS;
  return {
    ok: true,
    hostTimezone,
    truncated,
    slots: slots.map((start) => ({
      startIso: new Date(start).toISOString(),
      endIso: new Date(start + durationMs).toISOString(),
    })),
  };
}
