/**
 * Plans & Usage, the parts that are safe on both sides of the wire: the shapes
 * the admin Usage tab renders, and the pure rules behind every label on it.
 *
 * Deliberately import-free, so node:test can load it bare and the client could
 * import it without dragging server code along. The database read lives in
 * plans-usage.ts.
 *
 * Read-only by design. Nothing here decides whether work is allowed; that is
 * consume_allowance, in migration 037, which the CV scorer calls before every
 * paid score (src/lib/cv-allowance.ts). This file only describes what has been
 * used and what it is estimated to have cost.
 */

/**
 * The billing month is the calendar month in this zone, the same rule
 * consume_allowance applies in SQL with date_trunc(... at time zone ...).
 */
export const BILLING_TIME_ZONE = "Asia/Karachi";

export type MonthWindow = {
  /** Inclusive. The instant the month began in BILLING_TIME_ZONE. */
  startIso: string;
  /** Exclusive. The instant the next month begins. */
  endIso: string;
  /** e.g. "October 2026". */
  label: string;
};

/** Minutes the zone is ahead of UTC at a given instant, read from the tz database. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // "GMT+05:00", "GMT-03:30", or plain "GMT" for UTC itself.
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/** The UTC instant of local midnight on the 1st of a month in the zone. */
function monthStartInstant(year: number, monthIndex: number, timeZone: string): Date {
  const naiveUtc = Date.UTC(year, monthIndex, 1);
  // Offset read at that local midnight, so a zone with DST would still be right.
  const offset = zoneOffsetMinutes(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offset * 60_000);
}

/** The calendar month containing `now`, in BILLING_TIME_ZONE. */
export function karachiMonthWindow(now: Date): MonthWindow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BILLING_TIME_ZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const monthIndex = Number(parts.find((p) => p.type === "month")?.value) - 1;
  const start = monthStartInstant(year, monthIndex, BILLING_TIME_ZONE);
  const end = monthStartInstant(
    monthIndex === 11 ? year + 1 : year,
    (monthIndex + 1) % 12,
    BILLING_TIME_ZONE,
  );
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: BILLING_TIME_ZONE,
    month: "long",
    year: "numeric",
  }).format(now);
  return { startIso: start.toISOString(), endIso: end.toISOString(), label };
}

/**
 * The day this billing month's allowances reset, e.g. "1 November 2026": the
 * 1st of the next calendar month in BILLING_TIME_ZONE, the same boundary
 * consume_allowance counts from.
 */
export function allowanceResetDate(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BILLING_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(karachiMonthWindow(now).endIso));
}

/* ── allowances ─────────────────────────────────────────────────── */

export const NO_PLAN_LABEL = "No plan - unlimited";
export const INTERNAL_LABEL = "Internal - exempt";

export type AllowanceState =
  /** companies.is_internal: never capped, whatever the plan says. */
  | { kind: "internal"; label: string; flagged: false }
  /** A customer with no company_plans row: unlimited, and flagged for attention. */
  | { kind: "no_plan"; label: string; flagged: true }
  /** A plan exists but sets no limit for this metric. */
  | { kind: "unlimited"; label: string; flagged: false }
  /**
   * A plan with a limit. `over` when usage passed it: the CV scorer stops at the
   * limit, so for CV scoring this means the limit was lowered mid-month.
   */
  | { kind: "limit"; label: string; flagged: false; over: boolean };

export function allowanceState(input: {
  isInternal: boolean;
  hasPlan: boolean;
  limit: number | null;
  used: number;
}): AllowanceState {
  if (input.isInternal) return { kind: "internal", label: INTERNAL_LABEL, flagged: false };
  if (!input.hasPlan) return { kind: "no_plan", label: NO_PLAN_LABEL, flagged: true };
  if (input.limit === null)
    return { kind: "unlimited", label: "Unlimited on this plan", flagged: false };
  const over = input.used > input.limit;
  return {
    kind: "limit",
    label: `${input.used} of ${input.limit}${over ? " - over" : ""}`,
    flagged: false,
    over,
  };
}

/* ── costs ──────────────────────────────────────────────────────── */

export const RATE_NOT_SET = "rate not set";
export const PKR_RATE_NOT_SET = "PKR rate not set";

/** The rates the estimate reads, from pricing_settings. NULL = not entered yet. */
export type PricingRates = {
  cvScoreCost: number | null;
  asyncInterviewCost: number | null;
  liveMinuteCost: number | null;
  whatsappMessageCost: number | null;
  fixedMonthlyCost: number | null;
  clientsSharingFixedCost: number;
  pkrPerUsd: number | null;
  /** The Quote Builder's floor inputs. NULL = not entered yet. */
  minimumPrice: number | null;
  minimumMarginPct: number | null;
};

export type CostLine =
  | { kind: "amount"; usd: number }
  /** The rate is unset. Never rendered as zero. */
  | { kind: "rate_not_set" }
  /** Deliberately not estimated yet (live AI). Never rendered as zero. */
  | { kind: "not_calculated" }
  /** Internal companies carry no share of the fixed cost. */
  | { kind: "not_allocated" };

export function costLine(count: number, rate: number | null): CostLine {
  if (rate === null) return { kind: "rate_not_set" };
  return { kind: "amount", usd: count * rate };
}

/** One company's month, as counted. */
export type CompanyUsage = {
  companyId: string;
  name: string;
  status: string;
  isInternal: boolean;
  plan: {
    planName: string;
    cvScoringLimit: number | null;
    asyncInterviewLimit: number | null;
    liveMinutesLimit: number | null;
    quotedPrice: number | null;
    currency: string;
  } | null;
  /** usage_events cv_scored: every scoring run, re-scores included. */
  cvScored: number;
  /**
   * interview_sessions created this month, kind async: every invitation,
   * re-sends included. What the allowance counts. NOT what the cost uses.
   */
  asyncInvitations: number;
  /**
   * interview_sessions kind async whose submitted_at falls this month. What the
   * async cost uses: transcription and scoring happen after the candidate
   * submits, so an invitation nobody answers costs a message, not an interview.
   */
  asyncCompleted: number;
  /**
   * interview_sessions created this month, kind live. A count only: minutes are
   * not measured, so it is never compared with a minutes allowance or costed.
   */
  liveInterviews: number;
  /** communication_logs whatsapp rows that reached delivered or read. */
  whatsappDelivered: number;
};

export type CostEstimate = {
  cv: CostLine;
  asyncInterviews: CostLine;
  live: CostLine;
  whatsapp: CostLine;
  fixedAllocation: CostLine;
  /**
   * The sum, or null when a line it needs is unknown. A line with a zero count
   * needs no rate: zero of anything is exactly zero, so it never blocks.
   */
  totalUsd: number | null;
  /** What stopped the total, in words, for the page to say. */
  blockedBy: string[];
  /**
   * Rates that are unset but had nothing to multiply this month. The total is
   * still exact, but it is said out loud, so a $0.00 beside a "rate not set"
   * line never reads as a zero rate.
   */
  unsetButUnused: string[];
  /** True when live interviews happened and are, by necessity, not in the total. */
  excludesLive: boolean;
};

export function estimateCost(usage: CompanyUsage, rates: PricingRates): CostEstimate {
  const cv = costLine(usage.cvScored, rates.cvScoreCost);
  // Completed interviews, never invitations: see CompanyUsage.asyncCompleted.
  const asyncInterviews = costLine(usage.asyncCompleted, rates.asyncInterviewCost);
  const whatsapp = costLine(usage.whatsappDelivered, rates.whatsappMessageCost);
  const live: CostLine = { kind: "not_calculated" };
  const fixedAllocation: CostLine = usage.isInternal
    ? { kind: "not_allocated" }
    : rates.fixedMonthlyCost === null
      ? { kind: "rate_not_set" }
      : {
          kind: "amount",
          usd: rates.fixedMonthlyCost / Math.max(1, rates.clientsSharingFixedCost),
        };

  const blockedBy: string[] = [];
  const unsetButUnused: string[] = [];
  let total = 0;
  const add = (line: CostLine, count: number, what: string) => {
    if (line.kind === "amount") total += line.usd;
    else if (line.kind === "rate_not_set") {
      if (count > 0) blockedBy.push(`${what} rate not set`);
      else unsetButUnused.push(what);
    }
  };
  add(cv, usage.cvScored, "CV scoring");
  add(asyncInterviews, usage.asyncCompleted, "Async interview");
  add(whatsapp, usage.whatsappDelivered, "WhatsApp");
  if (!usage.isInternal) add(fixedAllocation, 1, "Fixed cost");

  return {
    cv,
    asyncInterviews,
    live,
    whatsapp,
    fixedAllocation,
    totalUsd: blockedBy.length === 0 ? total : null,
    blockedBy,
    unsetButUnused,
    excludesLive: usage.liveInterviews > 0,
  };
}

export function formatUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** PKR beside a USD amount, or the reason it cannot be shown. Never a silent zero. */
export function formatPkr(usd: number, pkrPerUsd: number | null): string {
  if (pkrPerUsd === null) return PKR_RATE_NOT_SET;
  return `PKR ${Math.round(usd * pkrPerUsd).toLocaleString("en-US")}`;
}

export type CostText = {
  primary: string;
  /** PKR beside a USD amount, or why a total is unavailable. */
  secondary: string | null;
  /** "warn" for anything the admin should fix or read: an unset rate, a blocked total. */
  tone: "amount" | "warn" | "muted";
};

/** Live AI: minutes are not measured, so no allowance is enforced and no cost is calculated. */
export const NOT_CALCULATED_LABEL = "not calculated yet";
export const NOT_TRACKED_YET = "Not tracked yet";
export const NOT_ENFORCED_YET = "Not enforced yet";
export const NOT_ALLOCATED_LABEL = "not allocated - internal";
export const TOTAL_UNAVAILABLE_LABEL = "Total unavailable";

/** What a cost cell says. An unknown amount is named, never shown as $0.00. */
export function costText(line: CostLine, pkrPerUsd: number | null): CostText {
  switch (line.kind) {
    case "amount":
      return {
        primary: formatUsd(line.usd),
        secondary: formatPkr(line.usd, pkrPerUsd),
        tone: "amount",
      };
    case "rate_not_set":
      return { primary: RATE_NOT_SET, secondary: null, tone: "warn" };
    case "not_calculated":
      return { primary: NOT_CALCULATED_LABEL, secondary: null, tone: "muted" };
    case "not_allocated":
      return { primary: NOT_ALLOCATED_LABEL, secondary: null, tone: "muted" };
  }
}

/** What the total cell says: the sum, or that it cannot be given and why. */
export function totalText(estimate: CostEstimate, pkrPerUsd: number | null): CostText {
  if (estimate.totalUsd === null) {
    return {
      primary: TOTAL_UNAVAILABLE_LABEL,
      secondary: estimate.blockedBy.join("; "),
      tone: "warn",
    };
  }
  const pkr = formatPkr(estimate.totalUsd, pkrPerUsd);
  if (estimate.unsetButUnused.length > 0) {
    return {
      primary: formatUsd(estimate.totalUsd),
      secondary: `${pkr}. Not set, and not needed this month: ${estimate.unsetButUnused.join(", ")}.`,
      tone: "amount",
    };
  }
  return { primary: formatUsd(estimate.totalUsd), secondary: pkr, tone: "amount" };
}

/* ── what the page receives ─────────────────────────────────────── */

export type UsageReadError = { source: string };

export type PlansUsageResult =
  | { ok: true; window: MonthWindow; rates: PricingRates; companies: CompanyUsage[] }
  /** Categories only. The raw database messages stay in the server log. */
  | { ok: false; window: MonthWindow; readErrors: UsageReadError[] };
