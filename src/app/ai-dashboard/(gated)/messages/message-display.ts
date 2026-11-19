/**
 * How a stored message reads on screen (#62). Display only: nothing here is
 * written back, and sending, delivery and retry never read it.
 *
 * WHATSAPP. A WhatsApp send stores no subject, and its body is the template's
 * name and the values it was sent with, as dispatch.ts writes them:
 * `interview_invitation: {"candidateName":"Ada","companyName":...}`. Meta owns
 * the template's wording, so the stored row never has it and this does not
 * guess it: the body is rebuilt as a plain account of what was sent, from the
 * stored values, and says the candidate saw them in Meta's wording. A body
 * that is not exactly that shape (an unknown template, values that are not
 * strings, broken JSON) is left as stored rather than half-read.
 *
 * SENDER. A row's type comes from its event (actions.ts kindOf), so an
 * interview invite a recruiter clicked Send on is an `interview` row with
 * `sent_by_name` set: it used to read "Automatic" in the list and "Written by
 * <name>" in the detail, and was neither. senderLine and typeLabel give the
 * one answer both places use.
 */
import { MESSAGE_KIND_LABELS, type MessageKind } from "./types";

/** The WhatsApp templates dispatch.ts sends (send.ts WHATSAPP_TEMPLATES), and their names on screen. */
export const WHATSAPP_TEMPLATE_TITLES: Record<string, string> = {
  interview_invitation: "Interview invitation",
  interview_reminder: "Interview reminder",
};

const VAR_KEYS = ["candidateName", "companyName", "jobTitle", "minutes", "deadline"] as const;
type TemplateVars = Record<(typeof VAR_KEYS)[number], string>;

/** dispatch.ts's fallback when the applicant has no first name. */
const NO_NAME = "there";

function parseTemplateBody(body: string): { template: string; vars: TemplateVars } | null {
  const m = /^([a-z_]+): (\{[\s\S]*\})$/.exec(body.trim());
  if (!m || !(m[1] in WHATSAPP_TEMPLATE_TITLES)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[2]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const vars = {} as TemplateVars;
  for (const key of VAR_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v !== "string") return null;
    vars[key] = v.trim();
  }
  return { template: m[1], vars };
}

function templateText(template: string, v: TemplateVars): string {
  const to = v.candidateName && v.candidateName !== NO_NAME ? ` to ${v.candidateName}` : "";
  const what =
    template === "interview_reminder"
      ? `Interview reminder sent on WhatsApp${to}.`
      : `Interview invitation sent on WhatsApp${to}.`;
  return [
    what,
    "",
    `Role: ${v.jobTitle} at ${v.companyName}`,
    `Takes about: ${v.minutes} minutes`,
    `Complete by: ${v.deadline}`,
    "",
    "This is a summary of the WhatsApp template message. The exact wording is managed by Meta.",
  ].join("\n");
}

/**
 * The subject and body a row shows. `plain` turns a stored email body into
 * text; it is not applied to a WhatsApp template body, which is not HTML.
 */
export function displayMessage(
  stored: { subject: string | null; body: string | null },
  plain: (html: string) => string,
): { subject: string; body: string; bodySummary?: true } {
  const subject = (stored.subject ?? "").trim();
  const parsed = parseTemplateBody(stored.body ?? "");
  if (parsed) {
    return {
      subject: subject || WHATSAPP_TEMPLATE_TITLES[parsed.template],
      body: templateText(parsed.template, parsed.vars),
      bodySummary: true,
    };
  }
  // No bodySummary key at all: every other row keeps its exact shape.
  return { subject: stored.subject ?? "", body: plain(stored.body ?? "") };
}

type LabelRow = { kind: MessageKind; event: string | null; sentByName: string | null };

/**
 * Nobody sent it: an automatic-type row with no sender recorded. The one rule
 * for "Automatic" in the Messages list, its detail and the applicant drawer.
 * A recruiter who clicked Send on a template is not automatic: their name shows.
 */
export function sentAutomatically(row: LabelRow): boolean {
  return row.kind === "automatic" && !row.sentByName;
}

/**
 * Who sent it, as the detail's eyebrow says it. "Written by" only for a
 * message a person wrote (event 'manual'); a template a person sent is "Sent
 * by". The list says the same through typeLabel and its Sent by column.
 */
export function senderLine(row: LabelRow): string {
  if (row.sentByName) {
    return row.event === "manual" ? `Written by ${row.sentByName}` : `Sent by ${row.sentByName}`;
  }
  if (row.kind === "scheduled") return `${MESSAGE_KIND_LABELS.scheduled} · automatic`;
  if (row.kind === "written") return "Written by your team";
  return "Sent automatically";
}

/**
 * The list's Type pill. Pending and Failed come first, as kindOf decides. An
 * automatic-type row that a person sent is a Template, not Automatic: the Sent
 * by column beside it names them.
 */
export function typeLabel(row: LabelRow): string {
  if (row.kind === "automatic" && !sentAutomatically(row)) return "Template";
  return MESSAGE_KIND_LABELS[row.kind];
}
