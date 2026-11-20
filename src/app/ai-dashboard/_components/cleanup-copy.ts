import type { CalendarCleanupAlert } from "@/app/ai-dashboard/(gated)/notification-types";

/**
 * The bell's sentence for a lasting calendar-cleanup alert (#56). No dashes,
 * no candidate data: whose calendar ("your" for the host), and when the event
 * was, in the reader's own zone (the panel renders after hydration, so the
 * browser's zone is the reader's).
 */
export function cleanupAlertText(alert: CalendarCleanupAlert, timeZone?: string): string {
  const whose = alert.mine ? "your" : `${alert.hostName ?? "a team member"}'s`;
  const when = alert.eventStart ? whenOf(alert.eventStart, timeZone) : null;
  return `A calendar event from a deleted applicant may still be in ${whose} Google Calendar${
    when ? ` (${when})` : ""
  }. Please remove it.`;
}

function whenOf(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const opts = timeZone ? { timeZone } : {};
  const date = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...opts,
  });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...opts });
  return `${date.replace(",", "")}, ${time}`;
}
