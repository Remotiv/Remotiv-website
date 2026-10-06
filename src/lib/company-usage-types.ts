import {
  type CompanyRole,
  canCreateJobs,
  canManageBilling,
} from "@/app/ai-dashboard/lib/company-roles";

/**
 * A company's own view of its plan and usage: the shapes, the thresholds, the
 * copy and who sees what. Pure, so the rules are testable without a database
 * and importable from a component without pulling in a server client.
 *
 * The figures themselves come from lib/company-usage.ts, which reads the exact
 * rows consume_allowance counts. Nothing here reads, writes or enforces.
 */

export type CappedMetric = "cv_scored" | "interview_sent";

/**
 * Where a figure stands against its monthly limit.
 *   unlimited - no limit applies (no plan, or the plan sets none): never warns
 *   ok        - below 80%
 *   warn      - 80% or more, still below the limit
 *   paused    - at or over the limit, including a limit of 0
 */
export type QuotaLevel = "unlimited" | "ok" | "warn" | "paused";

/**
 * Integer arithmetic only: used >= 80% of limit is used * 5 >= limit * 4, so
 * no fraction is ever compared for equality. Both inputs are whole numbers
 * (usage_events.quantity and the plan limits are integers).
 */
export function quotaLevel(used: number, limit: number | null): QuotaLevel {
  if (limit === null) return "unlimited";
  if (used >= limit) return "paused";
  if (used * 5 >= limit * 4) return "warn";
  return "ok";
}

export type MetricUsage = {
  metric: CappedMetric;
  used: number;
  /** null = unlimited this month. */
  limit: number | null;
  level: QuotaLevel;
};

export function metricUsage(metric: CappedMetric, used: number, limit: number | null): MetricUsage {
  return { metric, used, limit, level: quotaLevel(used, limit) };
}

/* ── copy ───────────────────────────────────────────────────────── */

export const USAGE_LOAD_ERROR = "Usage couldn't be loaded.";
export const UNLIMITED_THIS_MONTH = "Unlimited this month";
export const NEED_MORE = "Need more? Contact your Remotiv account manager.";

export const METRIC_LABEL: Record<CappedMetric, string> = {
  cv_scored: "AI-scored applicants",
  interview_sent: "Async interview invitations sent",
};

const METER_NOUN: Record<CappedMetric, string> = {
  cv_scored: "AI-scored applicants",
  interview_sent: "async interview invitations",
};

/** "82 / 300" or "12 / Unlimited". */
export function usedOfLimit(m: MetricUsage): string {
  return `${m.used} / ${m.limit === null ? "Unlimited" : m.limit}`;
}

/** One Overview meter line, e.g. "82 / 300 AI-scored applicants". */
export function meterLine(m: MetricUsage): string {
  return `${usedOfLimit(m)} ${METER_NOUN[m.metric]}`;
}

/** The warning for a metric at 80% or at its limit, or null when there is none. */
export function quotaWarning(m: MetricUsage, resetDate: string): string | null {
  if (m.level === "warn") {
    return m.metric === "cv_scored"
      ? "You've used 80% of this month's AI scoring."
      : "You've used 80% of this month's async interview invitations.";
  }
  if (m.level === "paused") {
    return m.metric === "cv_scored"
      ? `AI scoring paused until ${resetDate}. Applications still arrive and can be reviewed by hand.`
      : `Async interview invitations paused until ${resetDate}.`;
  }
  return null;
}

export type QuotaWarning = { metric: CappedMetric; level: "warn" | "paused"; text: string };

export function quotaWarnings(metrics: MetricUsage[], resetDate: string): QuotaWarning[] {
  return metrics.flatMap((m) => {
    const text = quotaWarning(m, resetDate);
    return text && (m.level === "warn" || m.level === "paused")
      ? [{ metric: m.metric, level: m.level, text }]
      : [];
  });
}

/* ── who sees what ──────────────────────────────────────────────── */

export type UsageSurfaces = {
  /** The Settings "Plan & usage" card: plan name and usage. */
  settingsCard: boolean;
  /** The quoted price, inside that card. Billing roles only. */
  price: boolean;
  /** The small meter on Overview. */
  overviewMeter: boolean;
  /** The 80% and 100% banner on Applicants. */
  applicantsBanner: boolean;
};

/**
 * Decided on the server, before anything is read: a role that may not see a
 * surface gets no query and no payload for it, not a hidden element.
 *
 *   owner           card, price, meter, Applicants banner
 *   admin           card, meter, Applicants banner; never the price
 *   recruiter       meter, Applicants banner; no card
 *   hiring_manager  nothing
 *
 * The meter and the banner follow canCreateJobs: the roles that can spend a
 * credit (re-score, send an interview) see the month's figures, and the
 * warning where those actions happen. A hiring manager can do neither and is
 * scoped to assigned jobs, so company-wide usage is not theirs to read.
 */
export function usageSurfacesFor(role: CompanyRole): UsageSurfaces {
  return {
    settingsCard: role === "owner" || role === "admin",
    price: canManageBilling(role),
    overviewMeter: canCreateJobs(role),
    applicantsBanner: canCreateJobs(role),
  };
}

/* ── what each surface receives ─────────────────────────────────── */

export type UsageError = { kind: "error" };

export type PlanUsageCardView = {
  kind: "card";
  /** null when the company has no plan: the card reads "Unlimited this month". */
  planName: string | null;
  /**
   * Present ONLY for a billing role. For anyone else the key does not exist in
   * the payload at all; null means a billing role is looking at a plan with no
   * recorded price.
   */
  price?: { amount: number; currency: string } | null;
  metrics: MetricUsage[];
  /** e.g. "1 November 2026", from the shared Karachi helper. */
  resetDate: string;
  warnings: QuotaWarning[];
};

export type OverviewMeterView = {
  kind: "meter";
  metrics: MetricUsage[];
  /** Whether this viewer can open the Settings card the meter links to. */
  linksToCard: boolean;
};

export type ApplicantsBannerView = { kind: "banner"; warnings: QuotaWarning[] };

/** null = this viewer gets nothing for the surface. */
export type SettingsUsage = PlanUsageCardView | UsageError | null;
export type OverviewUsage = OverviewMeterView | UsageError | null;
export type ApplicantsUsage = ApplicantsBannerView | null;
