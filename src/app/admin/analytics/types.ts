/**
 * Platform analytics — shapes and the range table.
 *
 * A plain module, deliberately NOT "use server": that boundary may only export
 * async functions, and this exports types, a constant table and nothing
 * callable. Only `npm run build` catches a violation of that rule, so the
 * split is kept structural rather than trusted to memory.
 */

import type { Calibration, CompanyRow, StatCards, Violation } from "./rollup";

export type AnalyticsRange = "30d" | "90d" | "all";

/** Range → days, or null for all time. */
export const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  "30d": 30,
  "90d": 90,
  all: null,
};

export const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Human labels for the metered usage types, used by the coverage note. */
export const USAGE_TYPE_LABELS: Record<string, string> = {
  cv_scored: "CV scoring",
  interview_scored: "Interview scoring",
  whatsapp_sent: "WhatsApp",
};

export type UsageCoverage = {
  /** Earliest metered row of any type, ISO. Null = nothing ever recorded. */
  earliestRecordedAt: string | null;
  /** Per-type first recorded instant, ISO. */
  byType: Record<string, string>;
  /** Types whose recording began after the selected range started. */
  incompleteTypes: string[];
  /** True when usage_events is empty — a different state from "incomplete". */
  neverRecorded: boolean;
};

/**
 * The prompt version each scorer is running RIGHT NOW.
 *
 * Sourced from the scorers' own `PROMPT_VERSION` constants on the server and
 * passed down, rather than imported into the client: those modules pull in the
 * Anthropic SDK and the service-role Supabase client, neither of which may
 * reach a browser bundle. Passing two strings costs nothing and keeps the
 * boundary intact.
 */
export type LiveVersions = {
  cv: string;
  interview: string;
};

export type PlatformHealth = {
  scoringFailures: number;
  fabricationRejections: number;
  interviewScoringFailures: number;
};

export type AnalyticsResult = {
  range: AnalyticsRange;
  generatedAt: string;
  /** ISO instant the range begins, or null for all time. */
  rangeStartsAt: string | null;
  stats: StatCards;
  calibration: Calibration;
  /** Which version each scorer is live on — drives the "Live" chip. */
  liveVersions: LiveVersions;
  companies: CompanyRow[];
  health: PlatformHealth;
  usage: UsageCoverage;
  /**
   * Empty on every healthy request. Non-empty means a figure on the page
   * disagrees with the table beneath it, and the page says so out loud rather
   * than rendering a number it cannot stand behind.
   */
  violations: Violation[];
};
