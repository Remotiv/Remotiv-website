/**
 * Platform analytics — the arithmetic.
 *
 * A PURE module: no Supabase, no Next, no React. Everything here is
 * data-in/data-out so `rollup.test.ts` can import it directly under
 * `node --test` and assert the reconciliation invariants without a database,
 * a server, or a test framework dependency.
 *
 * ── Why the invariants need code, not care ───────────────────
 *
 * The page's stated purpose is "the unit maths visible". A figure that does
 * not reconcile with the table under it does more damage here than a missing
 * figure would: it tells the reader the arithmetic is decorative. The handoff
 * records two arithmetic defects caught in review of the mock alone.
 *
 * Two mechanisms keep it honest, and neither is diligence:
 *
 *   1. EVERY PARTITION IS TOTAL. A row with no category, no prompt version or
 *      no named reviewer is bucketed into an explicit "Uncategorised" /
 *      "Unknown" / "Unattributed" row — never dropped. Sums then equal the
 *      total by construction, not by coincidence. This is the single most
 *      likely way real data breaks a mock's invariants: the mock had no nulls.
 *
 *   2. MONEY IS INTEGER MICRO-DOLLARS. Rates like $0.021 are not
 *      representable in binary floating point, so summing them per company and
 *      comparing to a separately-summed total is a coin flip at the cent. All
 *      money below is integer µ$ (1e-6 USD) and is divided exactly once, at
 *      render. Nothing rounds until it is a string.
 */

/** 1 US dollar in micro-dollars. Money is integer µ$ everywhere below. */
export const MICRO = 1_000_000;

/**
 * Per-unit rates, in micro-dollars.
 *
 * These are DECLARED unit rates applied to recorded usage — not per-call
 * billing. `application_scores` does carry real `input_tokens` / `output_tokens`,
 * so an exact token-priced figure is possible later for the two scoring lines;
 * it is not possible for WhatsApp or transcription, which have no token
 * counts, so a blended rate is the only basis that covers all four lines
 * consistently. The page says so in its footer rather than implying precision
 * it does not have.
 */
export const RATES_MICRO = {
  cv_scored: 21_000, // $0.021 per CV scored
  interview_scored: 12_000, // $0.012 per interview scored
  whatsapp_sent: 10_000, // $0.010 per delivered message
  transcription_minute: 6_000, // $0.006 per minute
} as const;

/**
 * Calibration thresholds.
 *
 * Below OVERRIDES_TO_CALIBRATE the whole section refuses to render means. This
 * is the state the platform is actually in today, so it is the state that had
 * to be designed properly rather than the one bolted on afterwards.
 */
export const MIN_OVERRIDES_TO_CALIBRATE = 100;
export const MIN_OVERRIDES_PER_CATEGORY = 15;
export const MIN_OVERRIDES_PER_REVIEWER = 20;

/** Bucket labels for rows whose partition key is null. Never dropped. */
export const UNCATEGORISED = "Uncategorised";
export const UNKNOWN_VERSION = "Unknown version";
export const UNATTRIBUTED = "Unattributed";

/* ────────────────────────── inputs ────────────────────────── */

/**
 * One scored row, from `application_scores` or `interview_session_scores`.
 * Both tables share this shape, which is why calibration can span them.
 */
export type ScoreRow = {
  kind: "cv" | "interview";
  companyId: string | null;
  /** Resolved from jobs.category. Null for a row whose job is gone. */
  category: string | null;
  promptVersion: string | null;
  overall: number | null;
  /** Non-null iff a human overrode the model. */
  adjusted: number | null;
  /** adjusted_by_name. May be null on an override — see UNATTRIBUTED. */
  reviewer: string | null;
};

/** One usage_events row, already narrowed to the selected range. */
export type UsageRow = {
  companyId: string;
  type: string;
  quantity: number;
};

export type CompanyInput = {
  id: string;
  name: string;
  isInternal: boolean;
  /** Latest activity of any kind, ISO. Null when there has never been any. */
  lastActivityAt: string | null;
  jobs: number;
  emails: number;
  /** Minutes of audio with transcript_status = 'done'. */
  transcribedMinutes: number;
  /**
   * Sessions the candidate SUBMITTED in the range, from
   * interview_sessions.submitted_at — recorded since the feature shipped and
   * independent of whether the AI ever scored them.
   */
  interviewsSubmitted: number;
  /** Applications with a score row whose status = 'failed'. */
  failedScores: number;
  /** Of those, the ones the evidence verifier rejected. */
  fabricationRejections: number;
  /** Applications with no score row because the job has scoring switched off. */
  unscoredByChoice: number;
  /** Published jobs with scoring disabled. */
  jobsWithScoringOff: number;
};

/* ────────────────────────── outputs ───────────────────────── */

export type CategoryRow = {
  category: string;
  scored: number;
  overrides: number;
  /** Null when this category has no overrides — renders an em-dash, not a 0. */
  mean: number | null;
};

export type ReviewerRow = {
  name: string;
  overrides: number;
  bias: number;
  /** Set once there is a spread to compare against. */
  tag: "strict" | "generous" | null;
};

export type VersionRow = {
  version: string;
  /**
   * Which scorer wrote this version. The two scorers keep INDEPENDENT version
   * sequences — cv-scoring-v10 and interview-scoring-v3 are both current — so
   * a single "latest" row is a category error: there are always two.
   * "mixed" is unreachable in practice and exists so an unrecognised version
   * string is still bucketed rather than dropped.
   */
  kind: "cv" | "interview" | "mixed";
  scored: number;
  overrides: number;
  overridePct: number;
  mean: number | null;
};

export type Calibration = {
  scored: number;
  overrides: number;
  overridePct: number;
  mean: number | null;
  /** Distinct named reviewers. 1 drives the single-reviewer state. */
  reviewerCount: number;
  state: "thin" | "solo" | "full";
  categories: CategoryRow[];
  reviewers: ReviewerRow[];
  versions: VersionRow[];
};

export type CompanyRow = {
  id: string;
  name: string;
  isInternal: boolean;
  dormantDays: number | null;
  jobs: number;
  cvs: number;
  /**
   * Interviews CANDIDATES SUBMITTED. The volume figure.
   *
   * Deliberately separate from `interviewsScored`: a company can submit
   * interviews without a single one being scored — because scoring is gated
   * behind AI_INTERVIEW_SCORING_ENABLED, because the job has it off, or simply
   * because the meter did not exist yet. Reporting the billable count under
   * the word "Interviews" made a live platform read as a dead one.
   */
  interviews: number;
  /** Interviews the AI scored — the billable count, and what cost is built on. */
  interviewsScored: number;
  emails: number;
  whatsapp: number;
  transcribedMinutes: number;
  /** Integer µ$. Divide by MICRO exactly once, at render. */
  costMicro: number;
  money: MoneyLine[];
  issues: Issue[];
  /** True when the company recorded no usage at all in the range. */
  zeroUsage: boolean;
};

export type MoneyLine = {
  label: string;
  /** The unit maths, rendered in mono: "128 × $0.021". */
  workings: string;
  amountMicro: number;
};

export type Issue = {
  tone: "bad" | "warn";
  title: string;
  detail: string;
};

export type StatCards = {
  companies: number;
  activeCompanies: number;
  cvsScored: number;
  /** Interviews submitted — the headline. */
  interviews: number;
  /** Of those, how many the AI scored. Shown as the sub-line, never alone. */
  interviewsScored: number;
  transcribedMinutes: number;
  publishedJobs: number;
  spendMicro: number;
  /** Null when nothing was scored — an em-dash, never a division by zero. */
  costPerCvMicro: number | null;
};

/* ────────────────────── calibration maths ─────────────────── */

/** An override is a row where a human wrote a score of their own. */
export function isOverride(row: ScoreRow): boolean {
  return row.adjusted !== null && row.overall !== null;
}

/** How far the human moved the model. Positive = the human scored higher. */
export function delta(row: ScoreRow): number {
  return (row.adjusted ?? 0) - (row.overall ?? 0);
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return round1(sum / values.length);
}

/** One decimal place, the precision every figure on the page is shown at. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Partition by job category.
 *
 * TOTAL by construction: a null category becomes UNCATEGORISED rather than
 * being filtered out, so `sum(scored)` equals the corpus and the invariant
 * holds on real data as well as on the mock's.
 *
 * Sorted by override count so the categories carrying the argument sit at the
 * top, with the no-override rows last — they are context, not findings.
 */
export function byCategory(rows: ScoreRow[]): CategoryRow[] {
  const buckets = new Map<string, { scored: number; deltas: number[] }>();

  for (const row of rows) {
    const key = row.category?.trim() || UNCATEGORISED;
    const bucket = buckets.get(key) ?? { scored: 0, deltas: [] };
    bucket.scored += 1;
    if (isOverride(row)) bucket.deltas.push(delta(row));
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([category, b]) => ({
      category,
      scored: b.scored,
      overrides: b.deltas.length,
      mean: meanOf(b.deltas),
    }))
    .sort((a, b) => b.overrides - a.overrides || b.scored - a.scored);
}

/**
 * Partition overrides by the person who made them.
 *
 * Denominator note: these are OVERRIDES ATTRIBUTED, not reviews performed —
 * the same distinction the handoff draws — so they sum to the override count,
 * never to the scored count.
 *
 * The strict/generous tags are only assigned when there is more than one
 * reviewer. With a single reviewer their bias IS the platform mean, so calling
 * them "strict" would be measuring them against themselves.
 */
export function byReviewer(rows: ScoreRow[]): ReviewerRow[] {
  const buckets = new Map<string, number[]>();

  for (const row of rows) {
    if (!isOverride(row)) continue;
    const key = row.reviewer?.trim() || UNATTRIBUTED;
    buckets.set(key, [...(buckets.get(key) ?? []), delta(row)]);
  }

  const list = [...buckets.entries()].map(([name, deltas]) => ({
    name,
    overrides: deltas.length,
    bias: meanOf(deltas) ?? 0,
  }));

  const named = list.filter((r) => r.name !== UNATTRIBUTED);
  const overall = meanOf(list.flatMap((r) => Array(r.overrides).fill(r.bias) as number[]));

  return list
    .map((r) => ({
      ...r,
      tag: tagFor(r, named.length, overall),
    }))
    .sort((a, b) => b.overrides - a.overrides);
}

/**
 * "Strict" and "generous" mean *relative to the other reviewers*, and only
 * once someone has enough overrides for their mean to be worth a label.
 */
function tagFor(
  reviewer: { name: string; overrides: number; bias: number },
  namedCount: number,
  overall: number | null,
): "strict" | "generous" | null {
  if (namedCount < 2 || overall === null) return null;
  if (reviewer.name === UNATTRIBUTED) return null;
  if (reviewer.overrides < MIN_OVERRIDES_PER_REVIEWER) return null;
  const gap = reviewer.bias - overall;
  if (gap <= -3) return "strict";
  if (gap >= 3) return "generous";
  return null;
}

/**
 * Partition by prompt version. Also total by construction — a row written
 * before the column existed buckets into UNKNOWN_VERSION.
 *
 * Grouped by SCORER first, then newest version first within each scorer. The
 * two sequences are independent and interleaving them by number alone would
 * read as one history that goes v10 → v3 → v9, which is not a history at all.
 */
export function byVersion(rows: ScoreRow[]): VersionRow[] {
  const buckets = new Map<string, { kind: VersionRow["kind"]; scored: number; deltas: number[] }>();

  for (const row of rows) {
    const key = row.promptVersion?.trim() || UNKNOWN_VERSION;
    const bucket = buckets.get(key) ?? { kind: row.kind, scored: 0, deltas: [] };
    // A version string is written by exactly one scorer, so this only differs
    // if the two ever collide on a value — in which case say so rather than
    // silently attributing the row to whichever arrived first.
    if (bucket.kind !== row.kind) bucket.kind = "mixed";
    bucket.scored += 1;
    if (isOverride(row)) bucket.deltas.push(delta(row));
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([version, b]) => ({
      version,
      kind: b.kind,
      scored: b.scored,
      overrides: b.deltas.length,
      overridePct: b.scored === 0 ? 0 : Math.round((b.deltas.length / b.scored) * 100),
      mean: meanOf(b.deltas),
    }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        versionRank(b.version) - versionRank(a.version) ||
        a.version.localeCompare(b.version),
    );
}

/**
 * Trailing version number: "cv-scoring-v10" → 10.
 *
 * Anchored to the END, not the start. The previous `/^v(\d+)/` matched a bare
 * "v10" and nothing this codebase actually writes — every real value is
 * "<scorer>-scoring-vN" — so every row ranked -1, the comparator returned 0 for
 * every pair, and the "sort" silently degraded to insertion order. That is what
 * put the oldest CV version at the top of the table.
 */
function versionRank(version: string): number {
  const match = /v(\d+)\s*$/i.exec(version.trim());
  return match ? Number(match[1]) : -1;
}

/** Assemble the calibration view model, including which of the three states. */
export function buildCalibration(rows: ScoreRow[]): Calibration {
  const overrides = rows.filter(isOverride);
  const categories = byCategory(rows);
  const reviewers = byReviewer(rows);
  const versions = byVersion(rows);
  const named = reviewers.filter((r) => r.name !== UNATTRIBUTED);

  let state: Calibration["state"] = "full";
  if (overrides.length < MIN_OVERRIDES_TO_CALIBRATE) {
    state = "thin";
  } else if (named.length <= 1) {
    state = "solo";
  }

  return {
    scored: rows.length,
    overrides: overrides.length,
    overridePct: rows.length === 0 ? 0 : Math.round((overrides.length / rows.length) * 100),
    mean: meanOf(overrides.map(delta)),
    reviewerCount: named.length,
    state,
    categories,
    reviewers,
    versions,
  };
}

/**
 * Bar width as a percentage of the FULL track, for a diverging bar drawn from
 * the centre. Capped at 50 so neither side can cross the zero line — the cap
 * is the reason the axis stays readable, not a safety net.
 */
export function barWidthPct(mean: number, maxAbs: number): number {
  if (maxAbs <= 0) return 0;
  return Math.min(50, round1((Math.abs(mean) / maxAbs) * 50));
}

/** The largest absolute category mean, ignoring categories with no overrides. */
export function maxAbsMean(categories: CategoryRow[]): number {
  return categories.reduce(
    (max, c) => (c.mean === null ? max : Math.max(max, Math.abs(c.mean))),
    0,
  );
}

/* ─────────────────────── cost and health ──────────────────── */

/** Whole minutes, rounded up: a 40-second answer still costs a minute. */
export function minutesFromSeconds(seconds: number): number {
  return Math.ceil(seconds / 60);
}

/**
 * Build one company's row, including the money panel whose lines must sum to
 * the row's own cost.
 *
 * Only lines with a non-zero quantity are emitted. A zero line would render as
 * "0 × $0.021 · $0.00", which reads as a rendering fault rather than as
 * information — and the zero-usage state below says it in words instead.
 */
export function buildCompanyRow(company: CompanyInput, usage: UsageRow[], now: Date): CompanyRow {
  const qty = (type: string) =>
    usage
      .filter((u) => u.companyId === company.id && u.type === type)
      .reduce((a, u) => a + u.quantity, 0);

  const cvs = qty("cv_scored");
  // Billable count, from usage_events. NOT the same population as the
  // submitted count below — see CompanyRow.interviews.
  const interviewsScored = qty("interview_scored");
  const whatsapp = qty("whatsapp_sent");
  const minutes = company.transcribedMinutes;

  const money: MoneyLine[] = [];
  const line = (label: string, units: number, rate: number, unitLabel: string) => {
    if (units <= 0) return;
    money.push({
      label,
      workings: `${units.toLocaleString("en-US")}${unitLabel} × ${formatMicro(rate)}`,
      amountMicro: units * rate,
    });
  };

  line("CV scoring", cvs, RATES_MICRO.cv_scored, "");
  line("Interview scoring", interviewsScored, RATES_MICRO.interview_scored, "");
  line("Transcription", minutes, RATES_MICRO.transcription_minute, " min");
  line("WhatsApp", whatsapp, RATES_MICRO.whatsapp_sent, "");

  const costMicro = money.reduce((a, m) => a + m.amountMicro, 0);

  return {
    id: company.id,
    name: company.name,
    isInternal: company.isInternal,
    dormantDays: dormantDays(company.lastActivityAt, now),
    jobs: company.jobs,
    cvs,
    interviews: company.interviewsSubmitted,
    interviewsScored,
    emails: company.emails,
    whatsapp,
    transcribedMinutes: minutes,
    costMicro,
    money,
    issues: buildIssues(company, now),
    zeroUsage: money.length === 0,
  };
}

/** Days since anything happened, or null while the company is still active. */
export function dormantDays(lastActivityAt: string | null, now: Date): number | null {
  if (!lastActivityAt) return null;
  const then = new Date(lastActivityAt).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days >= 14 ? days : null;
}

/**
 * What you would raise on a check-in call — and nothing else.
 *
 * Ordered worst-first: a rejected scorecard is a correctness problem, a
 * disabled feature they are paying for is a commercial one, dormancy is a
 * churn signal. An empty list is a good state and renders as one.
 */
export function buildIssues(company: CompanyInput, now: Date): Issue[] {
  const issues: Issue[] = [];

  if (company.fabricationRejections > 0) {
    issues.push({
      tone: "bad",
      title: `${company.fabricationRejections} ${plural(company.fabricationRejections, "scorecard")} rejected for unverifiable quotes`,
      detail:
        "The verifier caught the model quoting something absent from the CV. Nothing was stored.",
    });
  }

  const otherFailures = company.failedScores - company.fabricationRejections;
  if (otherFailures > 0) {
    issues.push({
      tone: "warn",
      title: `${otherFailures} ${plural(otherFailures, "scoring run")} failed`,
      detail: "Not fabrication — a model or extraction error. The applicant has no card.",
    });
  }

  if (company.unscoredByChoice > 0 && company.jobsWithScoringOff > 0) {
    issues.push({
      tone: "warn",
      title: `${company.unscoredByChoice} applicants unscored — scoring turned off on ${company.jobsWithScoringOff} ${plural(company.jobsWithScoringOff, "job")}`,
      detail: "They're paying for a feature they've disabled.",
    });
  }

  const dormant = dormantDays(company.lastActivityAt, now);
  if (dormant !== null) {
    issues.push({
      tone: "warn",
      title: `No activity in ${dormant} days`,
      detail: "Nothing published, scored or sent since then · churn risk.",
    });
  }

  return issues;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * Roll the per-company rows up into the five stat cards.
 *
 * The cards are DERIVED from the table rather than queried separately. That is
 * the whole defence against the defect class the handoff flags: two figures
 * computed by two paths will eventually disagree, and on this page a
 * disagreement is self-refuting. There is only one path.
 */
export function buildStats(rows: CompanyRow[], publishedJobs: number): StatCards {
  const cvsScored = rows.reduce((a, r) => a + r.cvs, 0);
  const spendMicro = rows.reduce((a, r) => a + r.costMicro, 0);

  return {
    companies: rows.length,
    activeCompanies: rows.filter((r) => r.dormantDays === null && !r.zeroUsage).length,
    cvsScored,
    interviews: rows.reduce((a, r) => a + r.interviews, 0),
    interviewsScored: rows.reduce((a, r) => a + r.interviewsScored, 0),
    transcribedMinutes: rows.reduce((a, r) => a + r.transcribedMinutes, 0),
    publishedJobs,
    spendMicro,
    costPerCvMicro: cvsScored === 0 ? null : Math.round(spendMicro / cvsScored),
  };
}

/* ────────────────────────── format ────────────────────────── */

/**
 * µ$ → "$0.021". Three decimals below a cent, two at or above it: "$0.02" for
 * a per-CV rate would hide the difference between $0.021 and $0.025, which is
 * exactly the difference the cost-per-CV card exists to show.
 */
export function formatMicro(micro: number): string {
  const dollars = micro / MICRO;
  if (dollars !== 0 && Math.abs(dollars) < 0.1) {
    return `$${dollars.toFixed(3)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/* ──────────────────── reconciliation checks ───────────────── */

export type Violation = { invariant: string; expected: number; actual: number };

/**
 * Every equality the page's credibility rests on, checked in one place.
 *
 * Returns violations rather than throwing: a mismatch must not blank a page
 * that is otherwise correct, and the server action logs what comes back. The
 * test asserts this returns empty for a range of generated inputs, so a future
 * change that drops a null-keyed row fails there rather than in production.
 */
export function reconcile(
  calibration: Calibration,
  companies: CompanyRow[],
  stats: StatCards,
): Violation[] {
  const out: Violation[] = [];
  const check = (invariant: string, expected: number, actual: number) => {
    if (expected !== actual) out.push({ invariant, expected, actual });
  };

  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

  check(
    "categories sum to scored",
    calibration.scored,
    sum(calibration.categories.map((c) => c.scored)),
  );
  check(
    "categories sum to overrides",
    calibration.overrides,
    sum(calibration.categories.map((c) => c.overrides)),
  );
  check(
    "reviewers sum to overrides",
    calibration.overrides,
    sum(calibration.reviewers.map((r) => r.overrides)),
  );
  check(
    "versions sum to scored",
    calibration.scored,
    sum(calibration.versions.map((v) => v.scored)),
  );
  check(
    "versions sum to overrides",
    calibration.overrides,
    sum(calibration.versions.map((v) => v.overrides)),
  );

  check("stat CVs sum to table", stats.cvsScored, sum(companies.map((c) => c.cvs)));
  check("stat interviews sum to table", stats.interviews, sum(companies.map((c) => c.interviews)));
  check(
    "stat interviews scored sum to table",
    stats.interviewsScored,
    sum(companies.map((c) => c.interviewsScored)),
  );
  check("stat spend sums to table", stats.spendMicro, sum(companies.map((c) => c.costMicro)));
  check(
    "stat minutes sum to table",
    stats.transcribedMinutes,
    sum(companies.map((c) => c.transcribedMinutes)),
  );
  check("stat companies count matches table", stats.companies, companies.length);

  for (const company of companies) {
    check(
      `money lines sum to cost for ${company.name}`,
      company.costMicro,
      sum(company.money.map((m) => m.amountMicro)),
    );
  }

  return out;
}
