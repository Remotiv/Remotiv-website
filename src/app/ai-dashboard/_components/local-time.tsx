"use client";

import { useSyncExternalStore } from "react";

/**
 * A time on the dashboard in the VIEWER's own time zone, with its zone named:
 * "4 Nov, 18:00 BST". Never a server's zone and never a bare UTC string.
 *
 * The zone is the browser's, so the server cannot know it. <LocalTime> renders
 * an empty <time> on the server and in the hydrating render (React guarantees
 * that pass sees getServerSnapshot), then fills it on the client: the first
 * client pass matches the HTML by construction, so there is no hydration
 * mismatch. The instant is always in dateTime.
 */

const NEVER_CHANGES = () => () => {};

/** The browser's time zone; null on the server and while hydrating. */
export function useViewerTimeZone(): string | null {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => viewerTimeZone(),
    () => null,
  );
}

/** The browser's time zone. Client code only (an event handler, or after hydration). */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The zone's short name at that instant: "BST" or "GMT" for London, "EDT" or
 * "EST" for New York. en-GB names British zones and en-US American ones; a zone
 * neither names (Asia/Karachi) is labelled by its offset, "GMT+5".
 */
function zoneLabel(date: Date, timeZone: string): string {
  let offset = "";
  for (const locale of ["en-GB", "en-US"]) {
    const name =
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    if (!/^(GMT|UTC)[+-]/.test(name)) return name;
    offset ||= name;
  }
  return offset;
}

/** "4 Nov, 18:00 GMT+5": day, short month, 24-hour time and the zone, in `timeZone`. */
export function formatLocalTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
  return `${day}, ${time} ${zoneLabel(date, timeZone)}`;
}

/** An instant in the viewer's local time, named zone included. Empty until the client knows the zone. */
export function LocalTime({ iso }: { iso: string }) {
  const timeZone = useViewerTimeZone();
  return (
    <time dateTime={iso} data-local-time>
      {timeZone ? formatLocalTime(iso, timeZone) : null}
    </time>
  );
}
