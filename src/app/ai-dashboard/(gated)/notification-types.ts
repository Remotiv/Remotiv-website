/**
 * Shapes for the company notification bell.
 *
 * A separate module because notification-actions.ts carries "use server" —
 * every export there is compiled into a server action, so a type cannot live
 * in it.
 */

export type CompanyNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  /** Null when the recipient can no longer open the target. */
  href: string | null;
  read: boolean;
  createdAt: string;
};

/**
 * A lasting alert: a calendar event a deleted applicant may have left in a
 * host's Google Calendar (#56, lib/calendar/cleanups.ts). Pinned in the bell
 * until it is marked removed or cleared automatically; "Mark all as read"
 * does not touch it. No candidate data.
 */
export type CalendarCleanupAlert = {
  id: string;
  /** The viewer is the host: the copy says "your Google Calendar". */
  mine: boolean;
  /** The host's display name when the alert was raised; null if none was known. */
  hostName: string | null;
  /** ISO. The event's start, shown in the reader's own zone. */
  eventStart: string | null;
};
