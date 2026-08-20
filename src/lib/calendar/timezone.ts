/**
 * IANA timezone arithmetic, without a date library.
 *
 * ── The rule this module exists to enforce ───────────────────
 *
 * An instant is a number. A wall-clock time is a number PLUS a zone, and it is
 * not a time until you supply the zone. Everything scheduled is stored as UTC
 * plus a named IANA zone; nothing anywhere does arithmetic on a local
 * timestamp, and no local time is ever persisted.
 *
 * The reason is not tidiness. A recruiter in Asia/Karachi (no DST, always
 * +05:00) and a candidate in Europe/London (+00:00 or +01:00 depending on the
 * date) booking across the last Sunday in March must land on the SAME instant.
 * If either side stores "14:00" and reconstructs it later, they reconstruct it
 * against whatever offset is in force at reconstruction time, and the two
 * sides disagree by an hour. The interview is missed and nobody can explain
 * why, because both calendars show what was agreed.
 *
 * ── Why not Date arithmetic ──────────────────────────────────
 *
 * `new Date(y, m, d, h)` interprets its arguments in the SERVER's zone, which
 * on Vercel is UTC and on a laptop is not. Adding 24*60*60*1000 to an instant
 * is correct; adding "one day" to a wall clock is not, because days are 23 or
 * 25 hours twice a year. This module never does the second.
 *
 * `Intl.DateTimeFormat` is the only zone database in the runtime, so offsets
 * are read from it rather than tabulated — a hardcoded table is wrong the next
 * time a government moves a transition, which happens most years somewhere.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A wall-clock reading in some zone. Meaningless without the zone. */
export type WallClock = {
  year: number;
  /** 1-12, NOT the 0-11 that Date uses. */
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/**
 * Formatter cache.
 *
 * Constructing an Intl.DateTimeFormat is expensive relative to using one, and
 * availability builds thousands of slots per request. Keyed by zone.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Is this a zone the runtime actually knows? Guards user-supplied input. */
export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  const value = (timeZone ?? "").trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** What the clock on the wall reads, in `timeZone`, at instant `ms`. */
export function wallClockAt(ms: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * The zone's offset from UTC, in milliseconds, AT a given instant.
 *
 * Positive east of Greenwich. Read by asking what the wall clock says at that
 * instant and comparing to the instant itself — the only way to get a
 * historically and futurely correct answer out of the runtime.
 *
 * `hour: "2-digit"` with `hour12: false` renders midnight as "24" in some ICU
 * versions, which would make this off by a day. Normalised below.
 */
export function offsetMsAt(ms: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  // Seconds are compared too, then the sub-second remainder is discarded: zone
  // offsets have been whole minutes everywhere since 1972.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export type ZonedResult = {
  /** The instant, epoch ms. */
  ms: number;
  /**
   * True when the requested wall time DOES NOT EXIST in that zone — the
   * spring-forward gap, where 02:30 is skipped entirely. `ms` is then the
   * instant the clock jumps to, and the caller must decide: a working-hours
   * boundary can safely clamp, but an offered SLOT at a non-existent time must
   * be dropped rather than silently moved.
   */
  skipped: boolean;
  /**
   * True when the wall time occurs TWICE — the autumn fall-back hour. `ms` is
   * the FIRST (earlier) occurrence, which is the conventional choice and the
   * one every calendar provider makes.
   */
  ambiguous: boolean;
};

/**
 * Wall clock in a zone → the UTC instant.
 *
 * ── How the two-pass correction works ────────────────────────
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so this is circular. It is resolved by guessing:
 *
 *   1. Pretend the wall time is UTC. That is wrong by exactly the offset.
 *   2. Read the offset at that wrong instant and subtract it. For all but the
 *      few hours around a transition, this is already the answer.
 *   3. Read the offset at the CORRECTED instant. If it differs, the guess
 *      landed on the other side of a transition — re-solve with the new
 *      offset.
 *
 * Two passes always suffice, because a second correction could only be needed
 * if two transitions occurred within one offset's distance of each other,
 * which no zone does.
 *
 * The round-trip check at the end is what detects a gap: if converting back
 * does not reproduce the requested wall time, that wall time does not exist.
 */
export function zonedWallToUtc(wall: WallClock, timeZone: string): ZonedResult {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);

  const firstOffset = offsetMsAt(asIfUtc, timeZone);
  let ms = asIfUtc - firstOffset;

  const secondOffset = offsetMsAt(ms, timeZone);
  if (secondOffset !== firstOffset) {
    ms = asIfUtc - secondOffset;
  }

  // Did we land on the wall time we asked for?
  const back = wallClockAt(ms, timeZone);
  const skipped =
    back.year !== wall.year ||
    back.month !== wall.month ||
    back.day !== wall.day ||
    back.hour !== wall.hour ||
    back.minute !== wall.minute;

  /*
   * Ambiguity: on fall-back the same wall time occurs twice, an hour apart.
   *
   * BOTH directions have to be checked, because which of the two the guess
   * lands on depends on where the transition sits relative to UTC midnight —
   * and that differs by zone. London's fall-back is at 01:00 UTC, so the guess
   * lands on the SECOND (GMT) occurrence; New York's is at 06:00 UTC, so the
   * same arithmetic lands on the FIRST (EDT) one. Testing only one side
   * silently missed every American zone.
   *
   * Whichever we landed on, the FIRST occurrence is returned — the
   * conventional choice, and the one calendar providers make.
   */
  const sameWall = (other: WallClock) =>
    other.hour === wall.hour && other.minute === wall.minute && other.day === wall.day;

  const landedOnSecond = !skipped && sameWall(wallClockAt(ms - HOUR_MS, timeZone));
  const landedOnFirst = !skipped && sameWall(wallClockAt(ms + HOUR_MS, timeZone));
  const ambiguous = landedOnSecond || landedOnFirst;

  return { ms: landedOnSecond ? ms - HOUR_MS : ms, skipped, ambiguous };
}

/**
 * The local calendar date `n` days after the local date of `ms`.
 *
 * Walks by CALENDAR DAY in the zone rather than by adding 24 hours, because a
 * DST day is 23 or 25 hours long and adding 24 hours across one lands on the
 * wrong date. Implemented by taking the wall date, adding days in the
 * proleptic Gregorian calendar via Date.UTC (which is pure arithmetic on a
 * date with no zone attached), and reading the parts back.
 */
export function addLocalDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/** Day of week for a local date. 0 = Sunday, matching availability_rules.weekday. */
export function localWeekday(wall: WallClock): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/** "2026-03-29", the local calendar date. Used as a grouping key only. */
export function localDateKey(ms: number, timeZone: string): string {
  const w = wallClockAt(ms, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/**
 * Render an instant for a human, in a named zone.
 *
 * The zone is always passed explicitly and never defaulted to the server's —
 * a server-rendered time in the server's zone is the classic way a scheduling
 * product shows two different people two different times for one meeting.
 */
export function formatInZone(
  ms: number,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...options,
  }).format(new Date(ms));
}

/** "GMT+5", for showing which zone a time is being read in. */
export function zoneAbbreviation(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
