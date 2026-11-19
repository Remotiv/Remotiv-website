import type { MessageRow } from "./types";

/**
 * The clock every time on this page reads (#36), the Applicants page's rule.
 *
 * The server and the browser render this page twice, and a time formatted in
 * each place came out different: the server runs in UTC (Vercel) and the
 * reader's browser in their own zone, so one message read "9 Jan, 12:59" from a
 * UTC server and "9 Jan, 17:59" in a Karachi browser, and "5m ago" could tick
 * to "6m ago" before hydration. React
 * then threw "Hydration failed because the server rendered text didn't match
 * the client" and rebuilt the page. Until hydration both renders use the
 * server's render time in UTC, so they agree; after it, the live clock in the
 * reader's zone.
 */
export type PageClock = { now: number; local: boolean };

/** "in 2 days" / "6h ago": the relative half of the When column. */
export function relative(iso: string | null, clock: PageClock): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = then - clock.now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const unit =
    mins < 60 ? `${mins}m` : hours < 24 ? `${hours}h` : `${days} day${days === 1 ? "" : "s"}`;
  if (mins < 1) return diff >= 0 ? "in a moment" : "just now";
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

/** The exact stamp beneath it, in UTC until hydration, then the reader's zone. */
export function exact(iso: string | null, clock: PageClock): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const zone = clock.local ? {} : { timeZone: "UTC" };
  const day = (t: Date) => t.toLocaleDateString("en-CA", zone);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...zone });
  if (day(d) === day(new Date(clock.now))) return `Today ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone })}, ${time}`;
}

export function whenOf(row: MessageRow, clock: PageClock): { rel: string; exact: string } {
  const stamp =
    row.kind === "scheduled" ? (row.scheduledFor ?? row.createdAt) : (row.sentAt ?? row.createdAt);
  return { rel: relative(stamp, clock), exact: exact(stamp, clock) };
}
