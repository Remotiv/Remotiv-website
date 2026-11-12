/**
 * Hyphens for AI prose on screen (Applicants, commit D2).
 *
 * The CV scorer writes em and en dashes ("Partial fit, then an em dash, then
 * broad sales experience"), and the product's copy rule is hyphens only. The
 * scorer prompt is parked, and a prompt change could not fix the rows already
 * stored anyway, so the text is normalised where the server shapes it for the
 * client (applicants/actions.ts).
 *
 * Prose only. Never apply this to a CV quote: quotes are verbatim spans a gate
 * checked against the CV, and real CVs use en dashes in ranges ("2019 to
 * 2021" written with one). Never to the employer's must-have wording, human
 * feedback, screening answers or names either.
 *
 * The characters are built from code points: a formatter rewrites \u escapes
 * into glyphs, and this file is meant to hold neither.
 */

const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);

/** An em dash with any spacing around it, joined or not: always " - ". */
const EM_ANY = new RegExp(`\\s*${EM}\\s*`, "g");
/** An en dash used as a pause, with space on both sides: " - ". */
const EN_SPACED = new RegExp(`\\s+${EN}\\s+`, "g");
/** What is left is an en dash joining two things, a range: "-". */
const EN_JOINED = new RegExp(EN, "g");

/**
 * The text with em and en dashes replaced by hyphens.
 *
 * - "Partial fit {em} broad sales"  -> "Partial fit - broad sales"
 * - "Partial fit{em}broad sales"    -> "Partial fit - broad sales"
 * - "Strong {en} but junior"        -> "Strong - but junior"
 * - "2019{en}2021", "3{en}5 years"  -> "2019-2021", "3-5 years"
 *
 * Text without either dash is returned as the same string. A dash at the very
 * start or end does not leave a stray space behind.
 */
export function plainDashes(text: string): string {
  if (!text.includes(EM) && !text.includes(EN)) return text;
  const out = text.replace(EM_ANY, " - ").replace(EN_SPACED, " - ").replace(EN_JOINED, "-");
  return text === text.trim() ? out.trim() : out;
}

/** The same, for a field that may be null. */
export function plainDashesOrNull(text: string | null): string | null {
  return text === null ? null : plainDashes(text);
}
