/**
 * Centralised date/time helpers for admin surfaces.
 *
 * The codebase had ~8 near-duplicate fmtDate / fmtDaysAgo / formatRelativeTime
 * helpers across dashboards with subtle differences (some "today" vs "just now",
 * some "Mar 12" vs "12 Mar 2025"). This module is the canonical source.
 *
 * All formatters use `en-GB` so dates and times render in 24-hour DD MMM
 * YYYY style throughout the admin, matching the rest of the workspace.
 */

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateNoYearFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/** "12 Mar 2025" — falls back to em-dash when the value is missing. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateFormatter.format(d);
}

/** "12 Mar 2025, 14:30" — em-dash on missing input. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateTimeFormatter.format(d);
}

/** "12 Mar" — current-year-omitted variant for compact UI. */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateNoYearFormatter.format(d);
}

/**
 * "5m ago" / "3h ago" / "2d ago" / "12 Mar 2025" — buckets by age,
 * falling back to the absolute date past 7 days.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDate(iso);
}
