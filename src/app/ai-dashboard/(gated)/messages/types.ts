/**
 * Shapes shared between the Messages server actions and the two clients that
 * render them (the page, and the drawer's history section).
 *
 * A separate module because actions.ts carries "use server" — every export
 * there is compiled into a server action, so a type cannot live in it.
 */

/** How a message reads in the UI. Derived, never stored. */
export type MessageKind = "written" | "automatic" | "scheduled" | "failed";

export const MESSAGE_TAB_KEYS = ["all", "written", "automatic", "scheduled"] as const;
export type MessageTab = (typeof MESSAGE_TAB_KEYS)[number];

export const MESSAGE_KIND_LABELS: Record<MessageKind, string> = {
  written: "Written",
  automatic: "Automatic",
  scheduled: "Scheduled",
  failed: "Failed",
};

/** One row of the Messages table, and one entry in the drawer's history. */
export type MessageRow = {
  id: string;
  applicationId: string | null;
  candidateName: string;
  candidateEmail: string;
  jobId: string | null;
  jobTitle: string;
  subject: string;
  /** Plain text, already stripped of the HTML shell for reading on screen. */
  body: string;
  event: string;
  status: string;
  kind: MessageKind;
  /**
   * Display name of the person who wrote a manual message.
   *
   * Null for automatic mail, which has no author, and for manual messages sent
   * before communication_logs.sent_by_name existed.
   */
  sentByName: string | null;
  /** ISO. Null until it actually leaves. */
  sentAt: string | null;
  /** ISO. When a queued message is due. */
  scheduledFor: string | null;
  createdAt: string;
};

/**
 * Workspace-wide counts.
 *
 * These come from HEAD count queries over the whole company, NOT from the page
 * of rows on screen — a tab that said "8" because eight rows happened to be
 * rendered was the first build's bug. `all` is the footer total and the All
 * tab; the three below it partition it exactly.
 */
export type MessageAggregates = {
  all: number;
  written: number;
  automatic: number;
  scheduled: number;
  /** Hero only: delivered vs. attempted. */
  sent: number;
  failed: number;
  sentThisWeek: number;
};

export type MessagePage = {
  rows: MessageRow[];
  /** Total matching the ACTIVE filters — drives pagination, not the tabs. */
  matching: number;
};

/** A candidate the composer can write to. */
export type MessageRecipient = {
  applicationId: string;
  name: string;
  email: string;
  jobTitle: string;
};

/** One of the company's saved 'manual' templates. */
export type ManualTemplate = {
  id: string;
  subject: string;
  body: string;
  /** Derived from the subject — message_templates has no name column. */
  label: string;
};

export const MESSAGES_PAGE_SIZE = 20;

/** Server-side caps. Enforced in the action; the inputs mirror them. */
export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;
