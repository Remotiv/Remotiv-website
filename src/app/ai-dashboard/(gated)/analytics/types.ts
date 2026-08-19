/**
 * Analytics shapes.
 *
 * A plain module, not "use server": that boundary may only export async
 * functions, and this exports types and the range table.
 */

/** Range → days, or null for all time. Drives the funnel subtitle too. */
export const ANALYTICS_RANGES: Record<string, number | null> = {
  "90d": 90,
  "30d": 30,
  "7d": 7,
  all: null,
};

export type AnalyticsRange = "90d" | "30d" | "7d" | "all";

export const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "90d": "Last 90 days",
  "30d": "Last 30 days",
  "7d": "Last 7 days",
  all: "All time",
};

export type FunnelStage = {
  stage: string;
  label: string;
  count: number;
  /** Average days waited AT this stage, or null when nobody has waited there. */
  avgDays: number | null;
  /** False renders the dashed stub and an em-dash — never a zero. */
  reached: boolean;
};

export type SourceRow = {
  key: string;
  label: string;
  /** A domain we do not recognise: rendered in mono, never bucketed as "Other". */
  unknown: boolean;
  applications: number;
  /** Share of THIS source's applicants who reached shortlist. Nested, not a tick. */
  shortlistPct: number;
  avgScore: number | null;
};

export type JobHealthRow = {
  jobId: string;
  title: string;
  applications: number;
  avgScore: number | null;
  shortlistPct: number;
  oldestDays: number;
  needsLook: boolean;
};

/**
 * One insight row.
 *
 * Split into before/figure/after rather than a string so the lime marker wraps
 * exactly the figure — a templated sentence with markup baked in would be the
 * thing the brief rules out.
 */
export type Insight = {
  tone: "warn" | "good";
  before: string;
  figure: string;
  after: string;
  cta: string;
  href: string;
};

export type StatCard = {
  key: string;
  /** Null renders the em-dash and emptyLabel — never a fabricated 0. */
  value: string | null;
  unit: string;
  emptyLabel: string | null;
  /** Explicit per metric. Time to hire is the one where down is good. */
  goodDirection: "up" | "down";
};

export type AnalyticsResult = {
  /** False renders the whole-page day-one state instead of the body. */
  hasAnyData: boolean;
  insights: Insight[];
  stats: StatCard[];
  funnel: FunnelStage[];
  bottleneckStage: string | null;
  sources: SourceRow[];
  /** False shows the "no tagged links yet" state rather than a Direct-only bar. */
  anyTaggedSource: boolean;
  agreement: {
    total: number;
    acceptedPct: number;
    upPct: number;
    downPct: number;
    avgChange: number | null;
  } | null;
  jobs: JobHealthRow[];
};
