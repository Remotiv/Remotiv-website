/**
 * The Quote Builder's arithmetic. Pure: it reads rates and counts, returns
 * numbers and reasons, and saves nothing.
 *
 *   cost   = applicants x CV rate + completed async x async rate
 *            + WhatsApp messages x WhatsApp rate + fixed cost / clients sharing it
 *   floor  = max(minimum price, cost / (1 - minimum margin))
 *   profit = quoted price - cost
 *   margin = profit / quoted price
 *   verdict: "Below floor" when quoted < floor, otherwise "Healthy"
 *
 * An unknown is never a zero. A rate that is needed and unset withholds the
 * figures that depend on it and says why, rather than quoting on a silent zero.
 * A count of zero needs no rate, because zero of anything is exactly zero.
 *
 * Live AI interviews are deliberately not an input. Their minutes are not
 * metered and pricing_settings has no rate for them, so they will be added here
 * when their metering is.
 *
 * Import-free apart from a type, so node:test loads it bare.
 */
import type { PricingRates } from "./plans-usage-types";

export type QuoteInputs = {
  /** Applicants to score in a month. */
  applicants: number;
  /** Completed async interviews in a month: the cost basis, not invitations. */
  asyncInterviews: number;
  whatsappMessages: number;
  /** The price being considered, USD per month. NULL until entered. */
  quotedPrice: number | null;
};

export type QuoteVerdict = "below_floor" | "healthy";

export type Quote = {
  /** Each cost line in USD, or null when its rate is needed and unset. */
  lines: {
    cv: number | null;
    asyncInterviews: number | null;
    whatsapp: number | null;
    fixedShare: number | null;
  };
  costUsd: number | null;
  floorUsd: number | null;
  profitUsd: number | null;
  /** Percent of the quoted price. Null without a positive quoted price. */
  marginPct: number | null;
  verdict: QuoteVerdict | null;
  /** Everything that withheld a figure, in words, for the page to say. */
  blockedBy: string[];
};

/** count x rate, or null when the rate is needed (count above zero) and unset. */
function line(count: number, rate: number | null, what: string, blocked: string[]): number | null {
  if (count === 0) return 0;
  if (rate === null) {
    blocked.push(`${what} rate not set`);
    return null;
  }
  return count * rate;
}

/** Compare money at cent precision, so 99.999999 does not fall below a 100.00 floor. */
const cents = (usd: number) => Math.round(usd * 100);

export function computeQuote(rates: PricingRates, input: QuoteInputs): Quote {
  const blockedBy: string[] = [];

  const cv = line(input.applicants, rates.cvScoreCost, "CV scoring", blockedBy);
  const asyncInterviews = line(
    input.asyncInterviews,
    rates.asyncInterviewCost,
    "Async interview",
    blockedBy,
  );
  const whatsapp = line(input.whatsappMessages, rates.whatsappMessageCost, "WhatsApp", blockedBy);
  // Every customer carries a share of the platform's fixed cost, so this rate
  // is always needed.
  let fixedShare: number | null = null;
  if (rates.fixedMonthlyCost === null) blockedBy.push("Fixed cost rate not set");
  else fixedShare = rates.fixedMonthlyCost / Math.max(1, rates.clientsSharingFixedCost);

  const costUsd =
    cv !== null && asyncInterviews !== null && whatsapp !== null && fixedShare !== null
      ? cv + asyncInterviews + whatsapp + fixedShare
      : null;

  let floorUsd: number | null = null;
  if (rates.minimumPrice === null) blockedBy.push("Minimum price not set");
  if (rates.minimumMarginPct === null) blockedBy.push("Minimum margin not set");
  else if (rates.minimumMarginPct >= 100) blockedBy.push("Minimum margin must be below 100%");
  if (
    costUsd !== null &&
    rates.minimumPrice !== null &&
    rates.minimumMarginPct !== null &&
    rates.minimumMarginPct < 100
  ) {
    floorUsd = Math.max(rates.minimumPrice, costUsd / (1 - rates.minimumMarginPct / 100));
  }

  const quoted = input.quotedPrice;
  const profitUsd = quoted !== null && costUsd !== null ? quoted - costUsd : null;
  const marginPct =
    profitUsd !== null && quoted !== null && quoted > 0 ? (profitUsd / quoted) * 100 : null;
  const verdict: QuoteVerdict | null =
    quoted !== null && floorUsd !== null
      ? cents(quoted) < cents(floorUsd)
        ? "below_floor"
        : "healthy"
      : null;

  return {
    lines: { cv, asyncInterviews, whatsapp, fixedShare },
    costUsd,
    floorUsd,
    profitUsd,
    marginPct,
    verdict,
    blockedBy,
  };
}

export const VERDICT_LABEL: Record<QuoteVerdict, string> = {
  below_floor: "Below floor",
  healthy: "Healthy",
};
