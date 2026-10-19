/**
 * The candidate's name out of a CV before it goes to Remotiv's question
 * writer or to the AI Video Interview provider.
 *
 * The full name, the surname and the usual variants become [candidate]:
 *   - "Alex Example", any case, with any spacing, after a title ("Mr", "Ms",
 *     "Dr", "Engr", ...)
 *   - "Example, Alex" and "EXAMPLE Alex"
 *   - initials and the surname: "A. Example", "A Example", "A. B. Example"
 *   - the first given name and the surname when there are middle names
 *     ("Muhammad Example" for "Muhammad Ali Example")
 *   - the surname on its own
 *
 * The first name on its own stays: the provider is given it separately to
 * greet the candidate, and a first name such as "Will" or "Grace" is also an
 * ordinary word. A surname that is also a word ("Baker") goes wherever it
 * appears; over-removing a word costs less than leaking a name.
 *
 * A first-name field holding the whole name ("Ali Khan", last name empty) is
 * split into given name and surname, so the surname is still found.
 *
 * Run AFTER sanitizeCvForInterview: contact details first, then the name.
 * Pure: no logging, no I/O.
 */

export const CANDIDATE_TAG = "[candidate]";

export type CandidateName = { firstName: string | null; lastName: string | null };

const TITLES = String.raw`(?:mr|mrs|ms|miss|mx|dr|engr|eng|prof|sir|madam|syed|hafiz)\.?\s+`;
/** Surname particles that are never removed on their own. */
const PARTICLES: ReadonlySet<string> = new Set([
  "van",
  "von",
  "der",
  "den",
  "de",
  "da",
  "di",
  "del",
  "la",
  "le",
  "bin",
  "binte",
  "bint",
  "al",
  "el",
  "ul",
  "ud",
]);

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tokens = (s: string | null) =>
  (s ?? "")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
/** Tokens as one pattern, matching any run of spaces, hyphens or dots between them. */
const seq = (ts: readonly string[]) => ts.map(escapeRe).join(String.raw`[\s.\-]+`);

/** The given names and surname to look for, after splitting a whole name held in the first-name field. */
function nameParts(name: CandidateName): { given: string[]; surname: string[] } {
  let given = tokens(name.firstName);
  let surname = tokens(name.lastName);
  if (surname.length === 0 && given.length >= 2) {
    surname = given.slice(1);
    given = given.slice(0, 1);
  }
  return { given, surname };
}

/** The patterns, longest first, so a full name is replaced before its surname alone. */
function patterns(name: CandidateName): RegExp[] {
  const { given, surname } = nameParts(name);
  if (surname.length === 0) return [];
  const last = seq(surname);
  const out: string[] = [];
  if (given.length > 0) {
    out.push(`(?:${TITLES})?${seq([...given, ...surname])}`);
    out.push(String.raw`${last}\s*,?\s+${seq(given)}`);
    if (given.length > 1) out.push(`(?:${TITLES})?${seq([given[0], ...surname])}`);
    const initials = given.map((g) => escapeRe(g[0])).join(String.raw`\.?\s*`);
    out.push(String.raw`(?:${TITLES})?${initials}\.?\s+${last}`);
  }
  out.push(`(?:${TITLES})${last}`);
  out.push(last);
  const lastToken = surname[surname.length - 1];
  if (surname.length > 1 && lastToken.length >= 3 && !PARTICLES.has(lastToken.toLowerCase())) {
    out.push(escapeRe(lastToken));
  }
  return out.map((p) => new RegExp(`${B}${p}${E}`, "giu"));
}

/** The text with the candidate's full name, surname and variants replaced by [candidate]. */
export function removeCandidateName(
  text: string | null | undefined,
  name: CandidateName,
): { text: string; removed: number } {
  let out = String(text ?? "");
  let removed = 0;
  for (const re of patterns(name)) {
    out = out.replace(re, () => {
      removed += 1;
      return CANDIDATE_TAG;
    });
  }
  return { text: out, removed };
}

/** Whether the text still names the candidate: the full name or the surname, in any case. */
export function mentionsCandidateName(text: string, name: CandidateName): boolean {
  return patterns(name).some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
