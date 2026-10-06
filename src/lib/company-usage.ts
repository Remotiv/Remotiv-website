import "server-only";
import { type MetricUsage, metricUsage } from "@/lib/company-usage-types";
import { allowanceResetDate, karachiMonthWindow } from "@/lib/plans-usage-types";
import { pageAll } from "@/lib/supabase/paging";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * One company's plan and this month's capped usage, for the company's own team.
 *
 * READ ONLY. Every query is a SELECT; it never calls consume_allowance or
 * release_allowance and changes nothing about what a company may do.
 *
 * ── Counted exactly as enforcement counts ────────────────────
 *
 * consume_allowance (migration 037) decides with
 *
 *   sum(quantity) from usage_events
 *    where company_id = $1 and type = $metric and created_at >= <Karachi month start>
 *
 * and this reads the same rows the same way: same table, same type, quantity
 * summed, from the same month start (karachiMonthWindow, the shared helper)
 * with no upper bound. So "82 / 300" here is the number the gate checks. It is
 * never a count of scorecards, of sessions created or of interviews completed.
 *
 * The caller passes the company id, and only ever the one from the viewer's
 * own session (see ai-dashboard/lib/company-usage-view.ts). Nothing here takes
 * a company from the browser.
 *
 * ── Failure ──────────────────────────────────────────────────
 *
 * All or nothing, like the admin Usage tab: any failed read returns
 * { ok: false } with no figures, and the raw cause goes to the server log only.
 */

type Service = ReturnType<typeof createServiceClient>;

const BASE_PLAN_COLUMNS = "plan_name, cv_scoring_limit, async_interview_limit";
const PRICE_COLUMNS = "quoted_price, currency";

type PlanRow = {
  plan_name: string | null;
  cv_scoring_limit: number | null;
  async_interview_limit: number | null;
  quoted_price?: number | string | null;
  currency?: string | null;
};

export type CompanyUsageRead =
  | { ok: false }
  | { ok: true; internal: true }
  | {
      ok: true;
      internal: false;
      /** null = no plan: unlimited this month. */
      plan: {
        planName: string;
        /** Only present when the caller asked for the price. */
        price?: { amount: number; currency: string } | null;
      } | null;
      cv: MetricUsage;
      interviews: MetricUsage;
      resetDate: string;
    };

/** numeric arrives as a string; NULL stays NULL. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function readCompanyUsage(
  service: Service,
  companyId: string,
  options: { includePrice: boolean },
  now: Date = new Date(),
): Promise<CompanyUsageRead> {
  try {
    const company = await service
      .from("companies")
      .select("is_internal")
      .eq("id", companyId)
      .maybeSingle();
    if (company.error) throw new Error("company read failed", { cause: company.error });
    if (!company.data) throw new Error(`company ${companyId} not found`);
    // Internal companies are never capped, so there is nothing to show them.
    if ((company.data as { is_internal: boolean | null }).is_internal === true) {
      return { ok: true, internal: true };
    }

    const monthStart = karachiMonthWindow(now).startIso;
    const usage = (type: "cv_scored" | "interview_sent") =>
      pageAll<{ quantity: number | null }>(
        (from, to) =>
          service
            .from("usage_events")
            .select("quantity")
            .eq("company_id", companyId)
            .eq("type", type)
            .gte("created_at", monthStart)
            .order("id")
            .range(from, to),
        { scope: "company-usage", label: `${type} usage` },
      ).then((rows) => rows.reduce((sum, r) => sum + (r.quantity ?? 0), 0));

    const [plan, cvUsed, interviewsUsed] = await Promise.all([
      service
        .from("company_plans")
        // The price is not selected at all unless the caller may show it.
        .select(options.includePrice ? `${BASE_PLAN_COLUMNS}, ${PRICE_COLUMNS}` : BASE_PLAN_COLUMNS)
        .eq("company_id", companyId)
        .maybeSingle(),
      usage("cv_scored"),
      usage("interview_sent"),
    ]);
    if (plan.error) throw new Error("plan read failed", { cause: plan.error });

    const row = plan.data as PlanRow | null;
    const amount = num(row?.quoted_price);
    return {
      ok: true,
      internal: false,
      plan: row
        ? {
            planName: row.plan_name?.trim() || "Custom",
            ...(options.includePrice
              ? { price: amount === null ? null : { amount, currency: row.currency ?? "USD" } }
              : {}),
          }
        : null,
      cv: metricUsage("cv_scored", cvUsed, row ? row.cv_scoring_limit : null),
      interviews: metricUsage(
        "interview_sent",
        interviewsUsed,
        row ? row.async_interview_limit : null,
      ),
      resetDate: allowanceResetDate(now),
    };
  } catch (err) {
    const cause = err instanceof Error && err.cause ? err.cause : err;
    console.error("[company-usage] read failed:", cause);
    return { ok: false };
  }
}
