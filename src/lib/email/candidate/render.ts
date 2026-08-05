import type { MessageEvent } from "./types";

/**
 * Placeholder substitution for candidate templates.
 *
 * The set is deliberately SMALL and closed. Every token here is something a
 * company can reasonably expect to reference and that we can always resolve
 * from the application row — nothing that could be null in normal operation and
 * leave a sentence half-finished.
 */
export type Placeholders = {
  /** "Sara" — first word of the candidate's name. */
  candidate_first_name: string;
  /** "Sara Ahmed" — full name as they submitted it. */
  candidate_name: string;
  /** The job title as it appeared when they applied. */
  job_title: string;
  /** The hiring company's name, NOT Remotiv's. */
  company_name: string;
};

export const PLACEHOLDER_KEYS: ReadonlyArray<keyof Placeholders> = [
  "candidate_first_name",
  "candidate_name",
  "job_title",
  "company_name",
];

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/**
 * Replace `{{token}}` with its value.
 *
 * An UNKNOWN token renders as an empty string, never as the raw `{{whatever}}`.
 * A candidate seeing `Hi {{frist_name}},` learns that a machine wrote it and
 * that nobody proof-read it; an empty gap reads as an ordinary typo at worst.
 * Once template editing ships, the editor should reject unknown tokens at save
 * time so this fallback stays a safety net rather than a routine outcome.
 *
 * Whitespace inside the braces is tolerated (`{{ job_title }}`) because a human
 * typing a token will add it, and failing on that would be gratuitous.
 */
export function renderTemplate(
  template: string,
  values: Placeholders,
): string {
  return template.replace(TOKEN, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase() as keyof Placeholders;
    const value = values[key];
    return typeof value === "string" ? value : "";
  });
}

/**
 * Render one template's subject and body against a set of values.
 *
 * THE single place a candidate template becomes copy. The dispatcher calls it
 * to build a real email and the Settings editor calls it to build the preview,
 * so a preview that reads differently from what will be sent is not something
 * the two can drift into — there is only one implementation to drift.
 *
 * Subject is plain text and takes raw values; the body is HTML, so its values
 * are escaped at substitution. That asymmetry is the whole reason this is a
 * function rather than two calls a caller is trusted to get right.
 */
export function renderCopy(
  template: { subject: string; body: string },
  values: Placeholders,
): { subject: string; body: string } {
  return {
    subject: renderTemplate(template.subject, values),
    body: renderTemplate(template.body, escapePlaceholders(values)),
  };
}

/** First word of a name, falling back to the whole string then to "there". */
export function firstNameOf(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return "there";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function buildPlaceholders(input: {
  firstName: string | null;
  lastName: string | null;
  jobTitle: string;
  companyName: string;
}): Placeholders {
  const full = [input.firstName, input.lastName]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return {
    candidate_first_name: firstNameOf(full),
    candidate_name: full || "there",
    job_title: input.jobTitle.trim() || "the role",
    company_name: input.companyName.trim() || "the company",
  };
}

/**
 * Minimal HTML escaping for values interpolated into an email body.
 *
 * Template BODIES are authored by us (and later by companies) and may contain
 * markup; the VALUES substituted into them come from candidate-supplied names
 * and job titles, so they are escaped at the point of substitution rather than
 * trusted. An apostrophe in "O'Brien" must not break the document, and a name
 * containing a tag must not become one.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape every placeholder value, for substitution into an HTML body. */
export function escapePlaceholders(values: Placeholders): Placeholders {
  return {
    candidate_first_name: escapeHtml(values.candidate_first_name),
    candidate_name: escapeHtml(values.candidate_name),
    job_title: escapeHtml(values.job_title),
    company_name: escapeHtml(values.company_name),
  };
}

/** Events whose default template exists. 'manual' has no default by design. */
export function hasDefaultTemplate(event: MessageEvent): boolean {
  return event !== "manual";
}
