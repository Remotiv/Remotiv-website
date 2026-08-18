/**
 * Where an applicant came from.
 *
 * ── The journey this has to survive ──────────────────────────
 *
 * The utm is on the LANDING url. Someone clicks a tagged LinkedIn post, reads
 * the job, maybe opens two more, comes back, and applies — possibly days later
 * in a tab they never closed. By the time /api/apply runs, the query string is
 * long gone and `document.referrer` says remotiv.work.
 *
 * So attribution is captured the moment a job page mounts and kept in
 * localStorage, not sessionStorage: sessionStorage dies with the tab, and
 * "opened it Monday, applied Wednesday" is the normal case for a job
 * application, not an edge one. The apply modal reads it back and posts it
 * alongside the form.
 *
 * ── First campaign wins, within the window ───────────────────
 *
 * A fresh utm always overwrites: it is an explicit, unambiguous signal that the
 * recruiter's tagged link was clicked, and the most recent click is the one
 * that produced this visit. Anything WEAKER than a utm — a bare referrer, or
 * nothing at all — never overwrites a stored record. Without that rule, landing
 * from LinkedIn and then navigating internally to a second job would rewrite
 * the attribution to Direct, and every campaign would report as Direct.
 *
 * Records expire after ATTRIBUTION_TTL_DAYS so a click six months ago cannot
 * take credit for an unrelated application.
 */

const STORAGE_KEY = "remotiv.attribution.v1";

/** How long a stored attribution stays credible. */
export const ATTRIBUTION_TTL_DAYS = 30;

export type Attribution = {
  /** Normalised channel: "linkedin", "facebook", "direct"… */
  source: string;
  /** utm_medium + utm_campaign, or the raw host for a referrer. Never a path. */
  sourceDetail: string | null;
  /** Referring DOMAIN only. Never a full URL — see toDomain. */
  referrer: string | null;
  /** The path they landed on, e.g. "/jobs/senior-engineer". No query string. */
  landingPath: string | null;
  /** Epoch ms, for the TTL. */
  at: number;
  /** True when a utm was present. Only a utm may overwrite a utm. */
  tagged: boolean;
};

/**
 * Host → channel. One row per family, so linkedin.com, LinkedIn and lnkd.in
 * all land on "linkedin" and the chart shows one bar rather than three.
 *
 * Matched on the registrable-ish suffix, so `l.facebook.com`,
 * `m.facebook.com` and `facebook.com` all resolve without listing every
 * subdomain Facebook invents.
 */
const HOST_CHANNELS: readonly { match: RegExp; channel: string }[] = [
  { match: /(^|\.)(linkedin\.com|lnkd\.in)$/i, channel: "linkedin" },
  { match: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i, channel: "facebook" },
  { match: /(^|\.)(whatsapp\.com|wa\.me)$/i, channel: "whatsapp" },
  { match: /(^|\.)(instagram\.com)$/i, channel: "instagram" },
  { match: /(^|\.)(twitter\.com|x\.com|t\.co)$/i, channel: "x" },
  /* Webmail FIRST: mail.google.com would otherwise match the google rule
     below and report a mailed link as search traffic. */
  { match: /(^|\.)(mail\.google\.com|outlook\.[a-z.]+|mail\.yahoo\.com)$/i, channel: "email" },
  { match: /(^|\.)(google\.[a-z.]+|googleusercontent\.com)$/i, channel: "google" },
  { match: /(^|\.)(bing\.com|duckduckgo\.com|search\.yahoo\.com)$/i, channel: "search" },
  { match: /(^|\.)(indeed\.[a-z.]+)$/i, channel: "indeed" },
  { match: /(^|\.)(glassdoor\.[a-z.]+)$/i, channel: "glassdoor" },
  { match: /(^|\.)(rozee\.pk|mustakbil\.com)$/i, channel: "job_board" },
  { match: /(^|\.)(t\.me|telegram\.org)$/i, channel: "telegram" },
  { match: /(^|\.)(youtube\.com|youtu\.be)$/i, channel: "youtube" },
  { match: /(^|\.)(reddit\.com)$/i, channel: "reddit" },
];

/** The utm_source values a tagged link may carry, mapped the same way. */
const UTM_ALIASES: Record<string, string> = {
  li: "linkedin",
  linkedin: "linkedin",
  "linkedin.com": "linkedin",
  lnkd: "linkedin",
  fb: "facebook",
  facebook: "facebook",
  meta: "facebook",
  wa: "whatsapp",
  whatsapp: "whatsapp",
  ig: "instagram",
  instagram: "instagram",
  twitter: "x",
  x: "x",
  email: "email",
  mail: "email",
  newsletter: "email",
  google: "google",
  adwords: "google",
};

/** Our own hosts. Arriving from ourselves is not a source. */
const INTERNAL = /(^|\.)(remotiv\.work|localhost|127\.0\.0\.1)$/i;

/**
 * Reduce a URL to its host, and nothing else.
 *
 * ── What is stripped, and why ────────────────────────────────
 *
 * Everything except the hostname: the scheme, any userinfo, the port, the PATH,
 * the QUERY STRING and the fragment. A full referrer is where personal data
 * leaks in — a search URL carries the query someone typed, a webmail referrer
 * can carry a message id, and a link from another ATS can carry their candidate
 * id in the path. None of that is needed to answer "which channel was this",
 * and storing it would put third-party personal data in our columns.
 *
 * Lowercased and stripped of a leading "www." so linkedin.com and
 * www.LinkedIn.com are one value.
 */
export function toDomain(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Host or utm_source → channel. Unknown hosts keep their domain as the label. */
export function normaliseChannel(hostOrTag: string | null | undefined): string | null {
  const value = (hostOrTag ?? "").trim().toLowerCase();
  if (!value) return null;

  const alias = UTM_ALIASES[value];
  if (alias) return alias;

  for (const { match, channel } of HOST_CHANNELS) {
    if (match.test(value)) return channel;
  }

  /*
   * An unrecognised host keeps its domain rather than collapsing to "other".
   * A chart reading "other 40%" is useless; one reading "acme-jobs.com 40%"
   * tells a recruiter exactly where to post again. It is already a bare
   * domain, so nothing personal rides along.
   */
  return value.replace(/^www\./, "") || null;
}

/** Read a stored attribution, or null when absent, unparseable or expired. */
export function readAttribution(): Attribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Attribution>;
    if (typeof parsed?.source !== "string" || typeof parsed?.at !== "number") {
      return null;
    }
    const ageDays = (Date.now() - parsed.at) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays > ATTRIBUTION_TTL_DAYS) return null;
    return {
      source: parsed.source,
      sourceDetail: parsed.sourceDetail ?? null,
      referrer: parsed.referrer ?? null,
      landingPath: parsed.landingPath ?? null,
      at: parsed.at,
      tagged: parsed.tagged === true,
    };
  } catch {
    // Private browsing, a full quota, or a value someone hand-edited. An
    // application must never depend on this working.
    return null;
  }
}

/**
 * Work out this visit's attribution and store it, unless a stronger record
 * already exists. Safe to call on every job page mount.
 */
export function captureAttribution(input?: {
  search?: string;
  referrer?: string;
  path?: string;
}): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(input?.search ?? window.location.search);
    const utmSource = params.get("utm_source");
    const utmMedium = params.get("utm_medium");
    const utmCampaign = params.get("utm_campaign");

    const referrerHost = toDomain(input?.referrer ?? document.referrer);
    const external = referrerHost && !INTERNAL.test(referrerHost) ? referrerHost : null;

    const tagged = Boolean(utmSource);
    const existing = readAttribution();

    /*
     * A weaker signal never overwrites a stored one. Only a fresh utm may
     * replace an existing record — see the module comment for why this is the
     * difference between a working chart and one that reads 100% Direct.
     */
    if (existing && !tagged) return;

    const source = tagged
      ? (normaliseChannel(utmSource) ?? "other")
      : external
        ? (normaliseChannel(external) ?? "other")
        : "direct";

    // utm_medium/campaign for a tagged visit; the bare host otherwise. Both are
    // short labels the recruiter chose or a domain — never a path or a query.
    const sourceDetail = tagged
      ? [utmMedium, utmCampaign]
          .map((v) => (v ?? "").trim())
          .filter(Boolean)
          .join(" / ") || null
      : external;

    const record: Attribution = {
      source,
      sourceDetail: sourceDetail ? sourceDetail.slice(0, 120) : null,
      referrer: external,
      // Path only. `window.location.search` is deliberately NOT included: the
      // utm is already distilled into source/sourceDetail, and keeping the raw
      // query would re-introduce whatever else was on the URL.
      landingPath: (input?.path ?? window.location.pathname).slice(0, 200),
      at: Date.now(),
      tagged,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Never throws. Attribution is telemetry attached to an application; an
    // application must not fail because a browser refused localStorage.
  }
}

/** The four form fields /api/apply reads. Empty object when nothing is known. */
export function attributionFields(): Record<string, string> {
  const a = readAttribution();
  if (!a) return {};
  const out: Record<string, string> = { attribution_source: a.source };
  if (a.sourceDetail) out.attribution_detail = a.sourceDetail;
  if (a.referrer) out.attribution_referrer = a.referrer;
  if (a.landingPath) out.attribution_landing_path = a.landingPath;
  return out;
}
