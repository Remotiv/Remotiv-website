/**
 * The Messages search text, as the two PostgREST filters it travels in (#73).
 *
 * A search is a literal substring: a recruiter typing `50%` finds "50%", not
 * "50" followed by anything. Two layers read the text before Postgres matches
 * it, and each has its own special characters:
 *
 *   LIKE        `%` and `_` are wildcards, and `\` is the escape. Postgres's
 *               default LIKE escape, so no ESCAPE clause is needed, and
 *               PostgREST offers no way to send one.
 *   PostgREST   inside `or=( … )`, a comma, parentheses, a double quote and a
 *               backslash are grammar. A double-quoted value makes the first
 *               three data, and inside the quotes `\` escapes `"` and `\`.
 *
 * ── `*` IS A WILDCARD. Deliberately, and the one exception. ──
 *
 * PostgREST rewrites every `*` in an ilike pattern to `%` before Postgres sees
 * it, quoted or not; measured against staging, `subject.ilike."*"` matched
 * every row. No escape reaches a literal `*` through ilike, and switching
 * operators for it was judged not worth it. So `p*q` also finds "pXq". It can
 * only OVER-match: a recruiter sees too much, never too little. Do not read
 * "the search is literal" as covering `*`.
 *
 * Measured against staging (PostgREST 14.18): a doubled backslash inside a
 * quoted value reaches Postgres as one, and on the plain parameter a double
 * quote is data, not syntax. That is why the two paths below are different
 * functions and must never be swapped.
 */

/**
 * `text` with every LIKE special escaped, in ONE pass.
 *
 * One pass over a character class, so a backslash inserted for `%` is never
 * escaped again. Escaping `%` first and backslashes after would turn `\%` into
 * `\\%`: a literal backslash followed by a wildcard.
 */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * The pattern for the PLAIN `subject=ilike.` parameter: the path taken when no
 * applicant name matches.
 *
 * LIKE-escaped only, and NEVER quoted. On a plain parameter PostgREST takes the
 * value as it stands, so a quote here would be searched for as a character, and
 * URL encoding already keeps a comma or parenthesis from meaning anything.
 */
export function plainSubjectPattern(search: string): string {
  return `%${likeLiteral(search)}%`;
}

/**
 * The value for a `subject.ilike.` term INSIDE `or=( … )`: the path taken when
 * an applicant name matches.
 *
 * The LIKE pattern first, then a separate second pass for PostgREST's quoting:
 * `\` and `"` are escaped and the whole value is double-quoted. A user's single
 * backslash therefore leaves here as four: two for LIKE, each doubled again for
 * the quotes.
 */
export function quotedSubjectPattern(search: string): string {
  return `"${plainSubjectPattern(search).replace(/["\\]/g, "\\$&")}"`;
}

/** The search as one disjunction: the subject matches, or the applicant does. */
export function subjectOrApplicants(search: string, applicationIds: readonly string[]): string {
  return `subject.ilike.${quotedSubjectPattern(search)},application_id.in.(${applicationIds.join(",")})`;
}
