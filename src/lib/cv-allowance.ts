import "server-only";
import { karachiMonthWindow } from "@/lib/plans-usage-types";
import { pageAll } from "@/lib/supabase/paging";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The CV-scoring allowance, from the application's side.
 *
 * consume_allowance and release_allowance (migration 037) are the authority:
 * the worker reserves a slot before every paid score and gives it back when no
 * scorecard is saved. Everything else here is ADVISORY - the Re-score actions
 * read it to avoid queueing work that would only be refused, and the worker
 * gates every queued job regardless, because capacity can change between the
 * read and the run.
 *
 * Rules the database applies, and which the advisory read mirrors:
 *   - an internal company is unlimited;
 *   - a company with no plan is unlimited;
 *   - a plan with no CV scoring limit is unlimited;
 *   - otherwise the limit is counted against usage_events of type cv_scored
 *     since the start of the calendar month in Asia/Karachi.
 */

type Service = ReturnType<typeof createServiceClient>;

export const CV_SCORED_METRIC = "cv_scored";

/** What Re-score says when the advisory read finds no room. Fixed; no figures. */
export const RESCORE_NO_ALLOWANCE_MESSAGE =
  "No AI scoring is left this month. Re-score once the monthly limit resets or the plan limit is raised.";

/* ── the authoritative gate ─────────────────────────────────────── */

type ConsumeRow = {
  allowed: boolean;
  unlimited: boolean | null;
  reason: string | null;
  used: number | null;
  allowance: number | null;
  usage_id: string | null;
  period_start: string | null;
};

export type CvReservation =
  | { allowed: true; usageId: string; unlimited: boolean; reason: string }
  | { allowed: false; used: number; allowance: number | null };

/**
 * Reserve one CV-scoring slot for this application, or learn there is none.
 *
 * Throws when the database gave no decision. No decision means no paid call:
 * the queue retries the job, and nothing was reserved, so nothing needs
 * releasing.
 */
export async function consumeCvAllowance(
  service: Service,
  companyId: string,
  applicationId: string,
): Promise<CvReservation> {
  const { data, error } = await service.rpc("consume_allowance", {
    p_company: companyId,
    p_metric: CV_SCORED_METRIC,
    p_ref: applicationId,
  });
  if (error) {
    console.error("[cv-allowance] consume_allowance failed:", error);
    throw new Error("ai_cv_score: the scoring allowance could not be checked");
  }
  const row = (Array.isArray(data) ? data[0] : data) as ConsumeRow | null | undefined;
  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("ai_cv_score: the scoring allowance returned no decision");
  }
  if (!row.allowed) {
    return { allowed: false, used: row.used ?? 0, allowance: row.allowance };
  }
  if (typeof row.usage_id !== "string" || row.usage_id === "") {
    throw new Error("ai_cv_score: the scoring allowance granted a slot without an id");
  }
  return {
    allowed: true,
    usageId: row.usage_id,
    unlimited: row.unlimited === true,
    reason: row.reason ?? "",
  };
}

/**
 * Give a reserved slot back. Never throws: it runs while another error may be
 * on its way out, and must not replace it. A failed release leaves the slot
 * counted - the company is charged one score too many, never one too few - and
 * says so in the log.
 */
export async function releaseCvAllowance(service: Service, usageId: string): Promise<void> {
  try {
    const { data, error } = await service.rpc("release_allowance", { p_usage_id: usageId });
    if (error) {
      console.error("[cv-allowance] release_allowance failed; the slot stays counted:", {
        usageId,
        error,
      });
    } else if (data !== true) {
      console.warn("[cv-allowance] release_allowance removed no row", { usageId });
    }
  } catch (err) {
    console.error("[cv-allowance] release_allowance threw; the slot stays counted:", {
      usageId,
      err,
    });
  }
}

/* ── the advisory read ──────────────────────────────────────────── */

export type CvCapacity =
  | { kind: "unlimited" }
  | { kind: "limited"; limit: number; used: number; available: number }
  /** The read failed. Treated as room: the worker's gate still decides. */
  | { kind: "unknown" };

export async function readCvCapacity(
  service: Service,
  companyId: string,
  now: Date = new Date(),
): Promise<CvCapacity> {
  try {
    const [company, plan] = await Promise.all([
      service.from("companies").select("is_internal").eq("id", companyId).maybeSingle(),
      service
        .from("company_plans")
        .select("cv_scoring_limit")
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);
    if (company.error || plan.error) {
      throw new Error("allowance read failed", { cause: company.error ?? plan.error });
    }
    const isInternal = (company.data as { is_internal: boolean | null } | null)?.is_internal;
    const limit = (plan.data as { cv_scoring_limit: number | null } | null)?.cv_scoring_limit;
    if (isInternal === true || limit === null || limit === undefined) return { kind: "unlimited" };

    // Counted from the start of the Karachi month with no upper bound, exactly
    // as consume_allowance counts.
    const rows = await pageAll<{ quantity: number | null }>(
      (from, to) =>
        service
          .from("usage_events")
          .select("quantity")
          .eq("company_id", companyId)
          .eq("type", CV_SCORED_METRIC)
          .gte("created_at", karachiMonthWindow(now).startIso)
          .order("id")
          .range(from, to),
      { scope: "cv-allowance", label: "cv_scored usage" },
    );
    const used = rows.reduce((sum, r) => sum + (r.quantity ?? 0), 0);
    return { kind: "limited", limit, used, available: Math.max(0, limit - used) };
  } catch (err) {
    const cause = err instanceof Error && err.cause ? err.cause : err;
    console.error("[cv-allowance] capacity read failed; the worker will decide:", cause);
    return { kind: "unknown" };
  }
}

/** How many of `wanted` scores to queue now. Only a known, limited allowance holds any back. */
export function scoresToQueue(capacity: CvCapacity, wanted: number): number {
  return capacity.kind === "limited" ? Math.min(capacity.available, wanted) : wanted;
}

/**
 * Applications with no saved scorecard first, then re-scores, each group in
 * its original order. When the allowance cannot cover everyone, the scarce
 * slots go to applicants who have no score at all.
 */
export function unscoredFirst(ids: string[], scored: ReadonlySet<string>): string[] {
  return [...ids.filter((id) => !scored.has(id)), ...ids.filter((id) => scored.has(id))];
}
