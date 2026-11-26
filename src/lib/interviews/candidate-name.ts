import { isOrdinaryWord } from "@/lib/interviews/ordinary-words";

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
 *
 * ── Spelling it the way it was typed (#25) ──────────────────
 *
 * Both the text and the name are read in one Unicode form (NFC), an accent
 * that has no letter of its own stays with its letter, and an apostrophe
 * matches however it was typed (O'Brien, O\u2019Brien). A name in a script
 * written without spaces (Chinese, Japanese, Korean) is found in either order
 * with or without a space (李秀英 for 秀英 李). The text comes back in NFC.
 *
 * NOT covered: a name the transcription spelt differently from how it was
 * typed ("Aleks" for Alex, "Sean OBrien" for Seán O'Brien). Nothing here
 * guesses at spellings; that needs the transcription to be given the name.
 *
 * ── Speech (removeCandidateNameFromSpeech) ───────────────────
 *
 * The live scorer's exchange is speech, not a CV: Sarah greets the candidate
 * by first name and the candidate may say any part of their name. There the
 * first name goes too, in any case, and a first name of several words is ONE
 * [candidate]. A name that is also an ordinary word (ordinary-words.ts: Will,
 * Baker, May, He) or a single Latin letter goes only where it is plainly a
 * name: the full name, after a title, a greeting ("Hi Will,"), "my name is" /
 * "call me", or spoken to ("Will, tell me"), and there only when written with
 * a capital. Everywhere else the word is the candidate's own and stays, so an
 * answer never reads differently because of what its speaker is called.
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

// A combining mark belongs to its letter: "yọ\u0300" is one letter, not a letter and a stray accent.
const B = String.raw`(?<![\p{L}\p{N}\p{M}])`;
const E = String.raw`(?![\p{L}\p{N}\p{M}])`;
/** Between the parts of a name: spaces or hyphens, or one dot. Never a full stop and a new sentence. */
const SEP = String.raw`(?:[\s\-]+|\.)`;
/** An apostrophe, however it was typed or transcribed. */
const APOSTROPHE = /['\u2019\u2018\u02bc`]/g;
const ANY_APOSTROPHE = "['\u2019\u2018\u02bc`]";
/** Scripts written without spaces between the parts of a name, and without capitals. */
const UNSPACED = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

const nfc = (s: string | null | undefined) => String(s ?? "").normalize("NFC");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One name token as a pattern: itself, with any apostrophe for an apostrophe. */
const tok = (t: string) => escapeRe(t).replace(APOSTROPHE, ANY_APOSTROPHE);
const tokens = (s: string | null) =>
  nfc(s)
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}\p{M}]+$/gu, ""))
    .filter(Boolean);
/** Tokens as one pattern, matching any run of spaces or hyphens, or a dot, between them. */
const seq = (ts: readonly string[]) => ts.map(tok).join(SEP);

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

const bounded = (p: string) => new RegExp(`${B}${p}${E}`, "giu");

/**
 * The patterns, longest first, so a full name is replaced before its surname
 * alone. `whole` are the name as a run of parts (the full name in either
 * order, after a title, initials and the surname); `alone` are the surname
 * and its last part on their own.
 */
function patterns(name: CandidateName): { whole: RegExp[]; alone: RegExp[] } {
  const { given, surname } = nameParts(name);
  if (surname.length === 0) return { whole: [], alone: [] };
  const last = seq(surname);
  const whole: RegExp[] = [];
  if (given.length > 0) {
    if ([...given, ...surname].every((t) => UNSPACED.test(t))) {
      // No space, no word edge to rely on: 李秀英 inside a sentence is still the name.
      const g = given.map(tok).join("");
      const l = surname.map(tok).join("");
      whole.push(new RegExp(String.raw`${l}[\s.\-]*${g}|${g}[\s.\-]*${l}`, "gu"));
    }
    whole.push(bounded(`(?:${TITLES})?${seq([...given, ...surname])}`));
    whole.push(bounded(String.raw`${last}\s*,?\s+${seq(given)}`));
    if (given.length > 1) whole.push(bounded(`(?:${TITLES})?${seq([given[0], ...surname])}`));
    const initials = given.map((g) => tok([...g][0])).join(String.raw`\.?\s*`);
    whole.push(bounded(String.raw`(?:${TITLES})?${initials}\.?\s+${last}`));
  }
  whole.push(bounded(`(?:${TITLES})${last}`));
  const alone = [bounded(last)];
  const lastToken = surname[surname.length - 1];
  if (surname.length > 1 && lastToken.length >= 3 && !PARTICLES.has(lastToken.toLowerCase())) {
    alone.push(bounded(tok(lastToken)));
  }
  return { whole, alone };
}

/** The text with the candidate's full name, surname and variants replaced by [candidate]. */
export function removeCandidateName(
  text: string | null | undefined,
  name: CandidateName,
): { text: string; removed: number } {
  let out = nfc(text);
  let removed = 0;
  const { whole, alone } = patterns(name);
  for (const re of [...whole, ...alone]) {
    out = out.replace(re, () => {
      removed += 1;
      return CANDIDATE_TAG;
    });
  }
  return { text: out, removed };
}

/** Whether the text still names the candidate: the full name or the surname, in any case. */
export function mentionsCandidateName(text: string, name: CandidateName): boolean {
  const { whole, alone } = patterns(name);
  const read = nfc(text);
  return [...whole, ...alone].some((re) => {
    re.lastIndex = 0;
    return re.test(read);
  });
}

/* ── speech ───────────────────────────────────────────────────── */

/** Words that are followed by the name of the person spoken to. */
const GREETING = String.raw`(?:hi|hello|hey|dear|welcome|thanks|thank\s+you|good\s+(?:morning|afternoon|evening))[\s,]+`;
/** Words a speaker follows with their own name. */
const SELF = String.raw`(?:(?:my\s+)?name(?:\s+is|${ANY_APOSTROPHE}s)|i\s+am|i${ANY_APOSTROPHE}?m|this\s+is|call(?:s|ed)?\s+me|known\s+as|go(?:es)?\s+by)\s+`;

/** Written as a name is written: a capital first letter, or a script that has none. */
const writtenAsName = (s: string) => {
  const first = [...s][0] ?? "";
  return first.toLowerCase() === first.toUpperCase() || first !== first.toLowerCase();
};

/**
 * One part of the name on its own (the surname, the first name, one word of
 * either). `plain` parts are names and nothing else: removed wherever they
 * stand, in any case. The rest (an ordinary word, a single Latin letter) are
 * removed only where they are plainly a name, written with a capital.
 */
function loneParts(name: CandidateName): {
  plain: string[];
  guarded: { part: string; letter: boolean }[];
} {
  const { given, surname } = nameParts(name);
  // "Mary-Jane" and "Muhammad Ali" are each one first name, of two words.
  const givenWords = given.flatMap((g) => g.split(/[.-]+/)).filter(Boolean);
  const parts = new Map<string, { guarded: boolean; letter: boolean }>();
  const add = (words: readonly string[], onItsOwn = true) => {
    if (words.length === 0) return;
    const one = words.length === 1 ? words[0] : null;
    if (one !== null) {
      if (!onItsOwn && (PARTICLES.has(one.toLowerCase()) || [...one].length < 3)) return;
      const letter = [...one].length === 1 && !UNSPACED.test(one);
      parts.set(tok(one), { guarded: letter || isOrdinaryWord(one), letter });
    } else {
      parts.set(seq(words), { guarded: false, letter: false });
    }
  };
  add(surname);
  if (surname.length > 1) add(surname.slice(-1), false);
  add(givenWords);
  for (const w of givenWords) add([w], givenWords.length === 1);
  // Longest first, so a first name of two words is one [candidate], not two.
  const longestFirst = [...parts].sort((a, b) => b[0].length - a[0].length);
  return {
    plain: longestFirst.filter(([, v]) => !v.guarded).map(([p]) => p),
    guarded: longestFirst
      .filter(([, v]) => v.guarded)
      .map(([part, v]) => ({ part, letter: v.letter })),
  };
}

/**
 * The candidate's name out of a line of SPEECH: an interviewer's line or the
 * candidate's own transcribed answer (the live scorer's exchange). Everything
 * removeCandidateName takes except the bare surname, then each part of the
 * name by the rule in this file's header. Run after sanitizeCvForInterview.
 */
export function removeCandidateNameFromSpeech(
  text: string | null | undefined,
  name: CandidateName,
): { text: string; removed: number } {
  let out = nfc(text);
  let removed = 0;
  const tag = () => {
    removed += 1;
    return CANDIDATE_TAG;
  };
  // A full name made only of ordinary words ("Will Young", "May Long") is two
  // words in a row unless it is written as a name or follows "my name is".
  const { given, surname } = nameParts(name);
  const allWords = [...given, ...surname].every((t) => isOrdinaryWord(t));
  for (const re of patterns(name).whole) {
    if (allWords) {
      const introduced = new RegExp(`(${B}(?:${GREETING}|${SELF}))(?:${re.source})`, "giu");
      out = out.replace(introduced, (_all: string, before: string) => `${before}${tag()}`);
    }
    out = out.replace(re, (all: string) => (allWords && !writtenAsName(all) ? all : tag()));
  }
  const { plain, guarded } = loneParts(name);
  for (const p of plain) out = out.replace(bounded(p), tag);
  for (const { part: p, letter } of guarded) {
    // After a greeting or "my name is"; or spoken to: "Will, tell me" and
    // "Thanks, Will." A single letter is never read as spoken to ("A, B and C").
    const places = [new RegExp(`(${B}(?:${GREETING}|${SELF}))(${p})${E}`, "giu")];
    if (!letter) {
      places.push(
        new RegExp(String.raw`(^\s*|[.!?]\s+)(${p})(?=,)`, "giu"),
        new RegExp(String.raw`(,\s*)(${p})(?=\s*(?:[.!?,]|$))`, "giu"),
      );
    }
    for (const re of places) {
      out = out.replace(re, (all: string, before: string, said: string) =>
        writtenAsName(said) ? `${before}${tag()}` : all,
      );
    }
  }
  return { text: out, removed };
}
