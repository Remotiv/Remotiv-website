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

/**
 * How many of one applicant's messages the drawer reads.
 *
 * The drawer's timeline merges these with stage history and comments, both of
 * which are uncapped — so a cap that silently truncated would produce a feed
 * showing every stage change beside a partial message trail, with nothing on
 * screen to say so. Hence `truncated` below, and hence a cap high enough that
 * reaching it is remarkable: the busiest applicant on record has nine.
 */
export const APPLICATION_MESSAGE_CAP = 200;

/**
 * One applicant's message trail, and what is known about how complete it is.
 *
 * `ok: false` is "the read failed", which is NOT the same as an empty `rows`.
 * The previous shape returned a bare array and swallowed the query error, so a
 * database failure and an applicant nobody has written to were indistinguishable
 * — and the drawer rendered the reassuring one.
 */
export type ApplicationMessageRead = {
  ok: boolean;
  rows: MessageRow[];
  /** More messages exist than were returned. */
  truncated: boolean;
};

/**
 * One inbound WhatsApp message, as the drawer's Communication tab renders it.
 *
 * No sender identity here, deliberately. The drawer is already headed with the
 * candidate's name, and the only sender field WhatsApp gives us is Meta's
 * profile name — which is whatever the person set on their own account, and
 * frequently not what they applied under. Printed beside the tab header it
 * reads as a mismatch rather than as information. /admin/whatsapp keeps it,
 * because there it is the only thing identifying who sent the message.
 */
export type InboundMessageRow = {
  id: string;
  /** Null for a voice note or an uncaptioned image — see `placeholderFor`. */
  body: string | null;
  messageType: string;
  /** ISO. Our insert time, the same clock `communication_logs.created_at` uses. */
  receivedAt: string;
};

/**
 * Whether this candidate's WhatsApp could be looked for at all.
 *
 * The tab claims to show the conversation, so "we found nothing" and "we could
 * never have found anything" must not render as the same silence.
 */
export type InboundMatchBasis = "phone" | "no-phone-on-file" | "phone-not-normalisable";

/** One applicant's inbound WhatsApp, and what is known about how complete it is. */
export type ApplicationInboundRead = {
  ok: boolean;
  rows: InboundMessageRow[];
  basis: InboundMatchBasis;
  /** More replies exist than were returned. */
  truncated: boolean;
};

/**
 * How many of one applicant's inbound WhatsApp messages the drawer reads.
 *
 * Same cap as the outbound trail because the two are rendered as one list and
 * a reader cannot be expected to hold two different limits in mind.
 */
export const APPLICATION_INBOUND_CAP = APPLICATION_MESSAGE_CAP;

export const MESSAGES_PAGE_SIZE = 20;

/** Server-side caps. Enforced in the action; the inputs mirror them. */
export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;
