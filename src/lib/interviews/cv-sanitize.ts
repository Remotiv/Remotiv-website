/**
 * Contact details out of a CV before it leaves Remotiv for the AI Video
 * Interview provider.
 *
 * Emails, phone numbers, links and street addresses become [email], [phone],
 * [link] and [address]; skills, job titles, employers, dates, education and
 * project descriptions stay as written. Stored data is never changed: this
 * runs on the copy that is sent.
 *
 * ── Where it comes from ─────────────────────────────────────
 *
 * The email, phone and link rules are the contact stripper built and tested
 * during the CV-scorer work (kept at ~/remotiv-backup/contact-strip/, run on
 * 50 real CVs), unchanged except for the per-kind tags:
 *   - obfuscated emails ("name [at] domain [dot] com") are caught;
 *   - bare domains (no scheme, www or path) go only when they are a personal
 *     hosting or profile site (jane.netlify.app, jane.github.io, linktr.ee);
 *     employer and product domains (acme.com, remotiv.work) stay, and so do
 *     "ASP.NET", "Node.js" and "experience.In 2019";
 *   - a phone number never spans a line break, so a year at the end of one
 *     line cannot join a number on the next;
 *   - a run of years and months ("2020-01 - 2021-03") and an equal-length
 *     number range ("150000-200000") are kept, not read as phone numbers.
 *
 * Two changes, both found on the last 30 days of real CVs (counts only):
 *   - a scheme glued to the word before it ("LinkedInhttps://...", as PDF
 *     extraction produces) is still a link: no word boundary before it;
 *   - a phone number on the same line as dates ("+92 300 1234567 2019-2021")
 *     made one run of more than 15 digits, which was refused whole and kept
 *     the number. Such a run is now split at its spaces: each phone inside is
 *     tagged, and a year or date range never starts or joins one.
 *
 * Addresses are new here. A CV header is a run of short parts split by line
 * breaks or "|", "•", "·"; a part that is an address goes whole:
 *   - a labelled line ("Address:", "Home address -"): the label stays;
 *   - a house, flat, apartment, plot or villa number, "H# 12", "House No. 4";
 *   - a number and a street word ("221B Baker Street", "12 Mall Road"), or a
 *     street word and a number ("Street 5", "Gali 3");
 *   - a P.O. Box.
 * A part longer than ADDRESS_PART_MAX is prose, not a header: only the marker
 * itself goes, so a sentence that mentions a road keeps its skills.
 * Postcodes go only where they read as one: after a known city or a US state
 * code, before "Pakistan", or in UK format after a comma or a UK city. A bare
 * five-digit number ("Served 50000 users") is never a postcode.
 *
 * Pure: no logging, no I/O. Returns counts only, never what was matched.
 */

export const EMAIL_TAG = "[email]";
export const PHONE_TAG = "[phone]";
export const LINK_TAG = "[link]";
export const ADDRESS_TAG = "[address]";

export type CvContactCounts = {
  emails: number;
  phones: number;
  links: number;
  addresses: number;
};
export type SanitizedCv = { text: string; counts: CvContactCounts };

/* ── emails ───────────────────────────────────────────────────── */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
/** "name [at] domain [dot] com", "name(at)domain.com". */
const BRACKETED_EMAIL_RE =
  /[A-Z0-9._%+-]+\s*[[({<]\s*at\s*[\])}>]\s*[A-Z0-9-]+(?:\s*(?:[[({<]\s*dot\s*[\])}>]|\.)\s*[A-Z0-9-]+)+/gi;
/** "name at domain dot com": only with both words and a known ending. */
const SPELLED_EMAIL_RE =
  /\b[A-Z0-9._%+-]+\s+at\s+[A-Z0-9-]+(?:\s+dot\s+[A-Z0-9-]+)*\s+dot\s+(?:com|net|org|io|pk|co|dev|me|ai|uk)\b/gi;

/* ── links ────────────────────────────────────────────────────── */

const URL_STOP = String.raw`[^\s<>()"'[\]{}]`;
/** No \b before the scheme: PDF text glues it to the word before ("LinkedInhttps://"). */
const SCHEME_URL_RE = new RegExp(String.raw`(?:https?|ftp):\/\/${URL_STOP}+`, "gi");
const WWW_URL_RE = new RegExp(String.raw`\bwww\.${URL_STOP}+`, "gi");
const ENDINGS =
  "com|net|org|io|dev|ai|app|me|co|tech|xyz|site|online|info|biz|page|pk|uk|in|ae|us|ca|de|au";
/** linkedin.com/in/..., github.com/...: any case, because a path follows. */
const DOMAIN_PATH_RE = new RegExp(
  String.raw`\b(?:[a-z0-9-]+\.)+(?:${ENDINGS})\/${URL_STOP}*`,
  "gi",
);
/**
 * Personal hosting and profile sites, with no scheme and no path
 * (jane.netlify.app, jane.github.io, linktr.ee/jane). Every other bare domain
 * stays: "acme.com" names an employer, which the interviewer may ask about.
 */
const PROFILE_HOSTS = String.raw`netlify\.app|vercel\.app|github\.io|gitlab\.io|pages\.dev|web\.app|firebaseapp\.com|herokuapp\.com|wixsite\.com|wordpress\.com|blogspot\.com|carrd\.co|notion\.site|framer\.website|webflow\.io`;
const PROFILE_URL_RE = new RegExp(
  String.raw`\b(?:(?:[a-z0-9-]+\.)+(?:${PROFILE_HOSTS})|linktr\.ee|about\.me|bio\.link)\b(?:\/${URL_STOP}*)?`,
  "gi",
);
/** Shaped like domains, but technologies and degrees ("B.Com/M.Com", "B.Tech"). */
const NOT_DOMAINS: ReadonlySet<string> = new Set([
  "asp.net",
  "ado.net",
  "vb.net",
  "ml.net",
  "dot.net",
  "socket.io",
  "b.com",
  "m.com",
  "b.tech",
  "m.tech",
]);

/* ── phones ───────────────────────────────────────────────────── */

/**
 * A digit run with phone separators, on one line. Separators are space, tab,
 * no-break space, dot, dash and brackets; never a slash or comma, so "03/2021"
 * and "5,000" are never candidates. isPhone then decides on the digits.
 */
const PHONE_RE = /\(?\+?\(?\d[\d \t ().-]{5,}\d/g;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function digitGroups(match: string): string[] {
  return match.split(/\D+/).filter(Boolean);
}

/** Years and months only ("2020-01 - 2021-03", "2015 2016 2017"). */
function isDateRun(groups: string[]): boolean {
  return (
    groups.some((g) => /^(?:19|20)\d\d$/.test(g)) &&
    groups.every((g) => g.length <= 2 || /^(?:19|20)\d\d$/.test(g))
  );
}

/** Two equal-length numbers, neither starting with 0: a range ("150000-200000"). */
function isNumberRange(groups: string[]): boolean {
  return (
    groups.length === 2 &&
    groups[0].length === groups[1].length &&
    groups[0].length >= 4 &&
    !groups[0].startsWith("0") &&
    !groups[1].startsWith("0")
  );
}

function isPhone(match: string): boolean {
  const groups = digitGroups(match);
  const digits = groups.join("").length;
  if (digits < 9 || digits > 15) return false;
  if (match.includes("+")) return true;
  return !isDateRun(groups) && !isNumberRange(groups);
}

/* ── addresses ────────────────────────────────────────────────── */

/** Longer than this, a part is prose: only the address marker goes, not the part. */
const ADDRESS_PART_MAX = 160;

/** Line breaks and the separators CV headers use; kept as they are. */
const PART_SPLIT_RE = /(\r?\n|[ \t]*[|•·][ \t]*)/;

/** "Address: ...", "Home address - ...". "Email address:" and "IP address" are not labels. */
const ADDRESS_LABEL_RE =
  /^(\s*(?:(?:home|residential|permanent|current|present|postal|mailing|correspondence)\s+)?(?:address|addr\.)\s*[:–-]\s*)(\S.*?)(\s*)$/i;

/**
 * What makes a part an address. Capitalised unit words only, so prose such as
 * "grew flat 20%" or "Office 365" never qualifies.
 */
const ADDRESS_MARKERS: readonly RegExp[] = [
  /\b(?:House|HOUSE|Flat|FLAT|Apartment|Apt|Plot|PLOT|Villa)\.?\s*(?:No\.?|Number|#)?\s*:?\s*#?\s*\d+[A-Za-z]?\b/,
  /\b(?:house|h\.?)\s*(?:no\.?|#)\s*:?\s*\d+/i,
  /\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][A-Za-z'-]*\s+){0,3}(?:Street|St\.|Road|Rd\.?|Avenue|Ave\.?|Lane|Boulevard|Blvd\.?|Drive|Highway|Crescent|Terrace)(?=\W|$)/,
  /\b(?:Street|St\.|Road|Rd\.?|Lane|Gali)\s*(?:No\.?|#)?\s*\d+\b/,
  /\bP\.?\s?O\.?\s*Box\s*\d+/i,
];

const PK_CITIES =
  "Lahore|Karachi|Islamabad|Rawalpindi|Faisalabad|Multan|Peshawar|Quetta|Sialkot|Gujranwala|Hyderabad|Abbottabad|Bahawalpur|Sargodha|Sukkur|Gujrat|Mardan|Sahiwal";
const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const UK_CITIES =
  "London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Bristol|Liverpool|Sheffield|Cardiff|Belfast|Leicester|Nottingham";

/** Postcodes in context; group 1 is kept, the postcode becomes the tag. */
const POSTCODE_RES: readonly RegExp[] = [
  new RegExp(String.raw`\b((?:${PK_CITIES})\s*,?\s*)\d{5}\b`, "g"),
  new RegExp(String.raw`\b((?:${US_STATES})\s+)\d{5}(?:-\d{4})?\b`, "g"),
  /()\b\d{5}(?=\s*,?\s*Pakistan\b)/g,
  new RegExp(
    String.raw`((?:,|\b(?:${UK_CITIES}))\s+)[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}\b(?=\s*(?:,|$|UK\b|United Kingdom\b|England\b|Scotland\b|Wales\b))`,
    "gm",
  ),
];

/** A year or a date range on its own ("2019", "2019-2021", "(2020)"): never part of a phone. */
const DATE_TOKEN_RE = /^\(?(?:19|20)\d\d(?:[-./]\d{1,4})?\)?$/;
/** E.164 allows 15 digits; a longer run is two or more numbers on one line. */
const PHONE_MAX_DIGITS = 15;

/**
 * A digit run PHONE_RE found, with its phones tagged. A run of more than 15
 * digits is several numbers on one line ("+92 300 1234567 2019-2021"): it is
 * split at its spaces and each phone inside is tagged, starting from each
 * token and taking the longest run that is a phone, never starting at or
 * crossing a year or date range.
 */
function tagPhones(run: string, counts: CvContactCounts): string {
  if (isPhone(run)) {
    counts.phones += 1;
    return PHONE_TAG;
  }
  if (digitGroups(run).join("").length <= PHONE_MAX_DIGITS) return run;
  const parts = run.split(/(\s+)/);
  let out = "";
  let i = 0;
  while (i < parts.length) {
    if (i % 2 === 1 || DATE_TOKEN_RE.test(parts[i])) {
      out += parts[i];
      i += 1;
      continue;
    }
    let best = -1;
    let digits = 0;
    for (let j = i; j < parts.length; j += 2) {
      if (j > i && DATE_TOKEN_RE.test(parts[j])) break;
      digits += digitGroups(parts[j]).join("").length;
      if (digits > PHONE_MAX_DIGITS) break;
      if (isPhone(parts.slice(i, j + 1).join(""))) best = j;
    }
    if (best < 0) {
      out += parts[i];
      i += 1;
    } else {
      counts.phones += 1;
      out += PHONE_TAG;
      i = best + 1;
    }
  }
  return out;
}

function hostOf(url: string): string {
  return url
    .replace(/^(?:https?|ftp):\/\//i, "")
    .split("/")[0]
    .replace(TRAILING_PUNCTUATION, "")
    .toLowerCase();
}

/** Replace `match` with `tag`, keeping sentence punctuation that followed it. */
function tagKeepingTrail(match: string, tag: string): string {
  return tag + (match.match(TRAILING_PUNCTUATION)?.[0] ?? "");
}

/** One part of the text: the same part, or the part with its address tagged. */
function sanitizeAddressPart(part: string, counts: CvContactCounts): string {
  const labelled = part.match(ADDRESS_LABEL_RE);
  if (labelled) {
    const [, label, value, trail] = labelled;
    if (value === ADDRESS_TAG) return part;
    counts.addresses += 1;
    return `${label}${ADDRESS_TAG}${trail}`;
  }
  const marker = ADDRESS_MARKERS.map((re) => part.match(re)).find((m) => m !== null);
  if (marker) {
    counts.addresses += 1;
    const body = part.trim();
    if (body.length <= ADDRESS_PART_MAX) return part.replace(body, ADDRESS_TAG);
    return part.replace(marker[0], ADDRESS_TAG);
  }
  let out = part;
  for (const re of POSTCODE_RES) {
    out = out.replace(re, (_match, kept: string) => {
      counts.addresses += 1;
      return `${kept}${ADDRESS_TAG}`;
    });
  }
  return out;
}

/**
 * The CV with every email, phone number, link and street address replaced by
 * its tag, and how many of each were replaced. Idempotent: a sanitised text
 * comes back unchanged with every count at zero.
 */
export function sanitizeCvForInterview(text: string | null | undefined): SanitizedCv {
  const counts: CvContactCounts = { emails: 0, phones: 0, links: 0, addresses: 0 };
  let out = String(text ?? "");

  for (const re of [EMAIL_RE, BRACKETED_EMAIL_RE, SPELLED_EMAIL_RE]) {
    out = out.replace(re, () => {
      counts.emails += 1;
      return EMAIL_TAG;
    });
  }

  for (const re of [SCHEME_URL_RE, WWW_URL_RE, PROFILE_URL_RE, DOMAIN_PATH_RE]) {
    out = out.replace(re, (match) => {
      if (NOT_DOMAINS.has(hostOf(match))) return match;
      counts.links += 1;
      return tagKeepingTrail(match, LINK_TAG);
    });
  }

  out = out.replace(PHONE_RE, (match) => tagPhones(match, counts));

  out = out
    .split(PART_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : sanitizeAddressPart(part, counts)))
    .join("");

  return { text: out, counts };
}
