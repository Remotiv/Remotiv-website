import "server-only";
import type { CompanyPlanInput, PricingSettingsInput } from "@/lib/plans-admin-validate";
import type { PricingRates } from "@/lib/plans-usage-types";
import { pageAll } from "@/lib/supabase/paging";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Plans & Rates: read and edit the pricing settings row and company plans.
 *
 * ── How plans are written ────────────────────────────────────
 *
 * ONLY through set_company_plan and remove_company_plan (migration 037). The
 * service role's direct writes to company_plans are revoked in the database, so
 * these functions are not a convention here, they are the only door. Each call
 * carries the acting admin's user id, which the database records in
 * company_plan_history. A missing actor is refused before any call is made.
 *
 * ── What this never does ─────────────────────────────────────
 *
 * It never calls consume_allowance or release_allowance and never touches
 * scoring, interview invitations or WhatsApp. Saving a plan records limits; it
 * does not enforce them. Enforcement is a later step.
 *
 * Raw database errors are logged here and returned to nobody: callers get a
 * fixed sentence.
 */

type Service = ReturnType<typeof createServiceClient>;

export type WriteResult = { ok: true } | { ok: false; error: string };

export type PlanSnapshot = {
  planName: string;
  cvScoringLimit: number | null;
  asyncInterviewLimit: number | null;
  liveMinutesLimit: number | null;
  quotedPrice: number | null;
  currency: string;
  notes: string | null;
};

export type PlanHistoryEntry = {
  id: number;
  operation: "INSERT" | "UPDATE" | "DELETE";
  changedAt: string;
  /** Resolved for display: an admin's name, or a plain statement that it is unknown. */
  changedBy: string;
  snapshot: PlanSnapshot;
};

/**
 * One row of the Plans & Rates table. History is deliberately absent: it is
 * read for one company at a time, when that company's drawer opens
 * (readPlanHistory), so the page never carries every company's history.
 */
export type AdminCompany = {
  id: string;
  name: string;
  status: string;
  isInternal: boolean;
  plan: PlanSnapshot | null;
};

export type PlansAdminResult =
  | { ok: true; rates: PricingRates; companies: AdminCompany[] }
  | { ok: false; readErrors: { source: string }[] };

export type PlanHistoryResult =
  | { ok: true; entries: PlanHistoryEntry[] }
  | { ok: false; readErrors: { source: string }[] };

export type RatesResult =
  | { ok: true; rates: PricingRates }
  | { ok: false; readErrors: { source: string }[] };

const SAVE_FAILED = "That could not be saved. Nothing was changed. Try again in a moment.";

/** numeric can arrive as a string; NULL stays NULL, never becomes 0. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function snapshotFrom(row: Record<string, unknown>): PlanSnapshot {
  return {
    planName: typeof row.plan_name === "string" ? row.plan_name : "Custom",
    cvScoringLimit: num(row.cv_scoring_limit),
    asyncInterviewLimit: num(row.async_interview_limit),
    liveMinutesLimit: num(row.live_minutes_limit),
    quotedPrice: num(row.quoted_price),
    currency: typeof row.currency === "string" ? row.currency : "USD",
    notes: typeof row.notes === "string" ? row.notes : null,
  };
}

const SETTINGS_COLUMNS =
  "cv_score_cost, async_interview_cost, live_minute_cost, whatsapp_message_cost, fixed_monthly_cost, clients_sharing_fixed_cost, pkr_per_usd, minimum_price, minimum_margin_pct";

function ratesFrom(row: Record<string, unknown>): PricingRates {
  return {
    cvScoreCost: num(row.cv_score_cost),
    asyncInterviewCost: num(row.async_interview_cost),
    liveMinuteCost: num(row.live_minute_cost),
    whatsappMessageCost: num(row.whatsapp_message_cost),
    fixedMonthlyCost: num(row.fixed_monthly_cost),
    clientsSharingFixedCost: Math.max(1, num(row.clients_sharing_fixed_cost) ?? 1),
    pkrPerUsd: num(row.pkr_per_usd),
    minimumPrice: num(row.minimum_price),
    minimumMarginPct: num(row.minimum_margin_pct),
  };
}

/** The pricing settings row alone, for the Quote Builder. */
export async function readPricingRates(service: Service): Promise<RatesResult> {
  const { data, error } = await service
    .from("pricing_settings")
    .select(SETTINGS_COLUMNS)
    .eq("id", "default")
    .maybeSingle();
  if (error || !data) {
    console.error("[plans-admin] pricing settings read failed:", error ?? "row missing");
    return { ok: false, readErrors: [{ source: "pricing settings" }] };
  }
  return { ok: true, rates: ratesFrom(data as Record<string, unknown>) };
}

/**
 * The Plans & Rates table: companies, their current plans, and the rates. All
 * or nothing, like the Usage tab. Plan history is not read here; see
 * readPlanHistory.
 */
export async function readPlansAdmin(service: Service): Promise<PlansAdminResult> {
  const readErrors: { source: string }[] = [];
  async function attempt<T>(
    source: string,
    read: () => PromiseLike<T> | Promise<T>,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      readErrors.push({ source });
      console.error(
        `[plans-admin] read failed (${source}):`,
        err instanceof Error && err.cause ? err.cause : err,
      );
      return null;
    }
  }
  async function one<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
    const { data, error } = await query;
    if (error) throw new Error("query failed", { cause: error });
    return data as T;
  }

  const [companies, plans, rates] = await Promise.all([
    attempt("companies", () =>
      one<
        { id: string; name: string | null; status: string | null; is_internal: boolean | null }[]
      >(service.from("companies").select("id, name, status, is_internal").order("name")),
    ),
    attempt("plans", () =>
      one<Record<string, unknown>[]>(
        service
          .from("company_plans")
          .select(
            "company_id, plan_name, cv_scoring_limit, async_interview_limit, live_minutes_limit, quoted_price, currency, notes",
          ),
      ),
    ),
    attempt("pricing settings", async () => {
      const r = await readPricingRates(service);
      if (!r.ok) throw new Error("pricing settings unavailable");
      return r.rates;
    }),
  ]);

  if (readErrors.length > 0 || !companies || !plans || !rates) {
    return { ok: false, readErrors };
  }

  const planByCompany = new Map(plans.map((p) => [p.company_id as string, snapshotFrom(p)]));

  return {
    ok: true,
    rates,
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name ?? "Unnamed company",
      status: c.status ?? "unknown",
      isInternal: c.is_internal === true,
      plan: planByCompany.get(c.id) ?? null,
    })),
  };
}

/**
 * One company's plan history, newest first, with each actor resolved to an
 * admin's name. Read when that company's drawer opens. Read only.
 */
export async function readPlanHistory(
  service: Service,
  companyId: string,
): Promise<PlanHistoryResult> {
  const failed = (source: string, cause: unknown): PlanHistoryResult => {
    console.error(`[plans-admin] read failed (${source}):`, cause);
    return { ok: false, readErrors: [{ source }] };
  };

  let rows: {
    id: number;
    operation: string;
    snapshot: unknown;
    changed_by: string | null;
    changed_at: string;
  }[];
  try {
    rows = await pageAll(
      (from, to) =>
        service
          .from("company_plan_history")
          .select("id, operation, snapshot, changed_by, changed_at")
          .eq("company_id", companyId)
          .order("changed_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      { scope: "plans-admin", label: "plan history" },
    );
  } catch (err) {
    return failed("plan history", err instanceof Error && err.cause ? err.cause : err);
  }

  // Names only for the people who appear in this history.
  const actorIds = [...new Set(rows.map((r) => r.changed_by).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data, error } = await service
      .from("admin_users")
      .select("user_id, full_name")
      .in("user_id", actorIds);
    if (error) return failed("admin names", error);
    for (const a of (data ?? []) as { user_id: string | null; full_name: string | null }[]) {
      if (a.user_id) names.set(a.user_id, a.full_name?.trim() || "An admin");
    }
  }
  const actorLabel = (id: string | null) =>
    id === null ? "Unknown - a direct database edit" : (names.get(id) ?? `User ${id.slice(0, 8)}`);

  return {
    ok: true,
    entries: rows.map((h) => ({
      id: h.id,
      operation:
        h.operation === "DELETE" ? "DELETE" : h.operation === "INSERT" ? "INSERT" : "UPDATE",
      changedAt: h.changed_at,
      changedBy: actorLabel(h.changed_by),
      snapshot: snapshotFrom((h.snapshot ?? {}) as Record<string, unknown>),
    })),
  };
}

/* ── writes ─────────────────────────────────────────────────────── */

export async function savePricingSettings(
  service: Service,
  actorId: string,
  value: PricingSettingsInput,
): Promise<WriteResult> {
  if (!actorId) return { ok: false, error: SAVE_FAILED };
  const { data, error } = await service
    .from("pricing_settings")
    .update({ ...value, updated_by: actorId })
    .eq("id", "default")
    .select("id");
  if (error || !Array.isArray(data) || data.length !== 1) {
    console.error(
      "[plans-admin] pricing settings save failed:",
      error ?? `updated ${data?.length ?? 0} rows`,
    );
    return { ok: false, error: SAVE_FAILED };
  }
  return { ok: true };
}

/**
 * Create or replace a company's plan through set_company_plan, as `actorId`.
 *
 * The form has no live-minutes field yet, so the plan's existing live-minutes
 * limit is read and passed back unchanged rather than overwritten with blank.
 * Plans are priced in USD.
 */
export async function saveCompanyPlan(
  service: Service,
  actorId: string,
  companyId: string,
  value: CompanyPlanInput,
): Promise<WriteResult> {
  if (!actorId) return { ok: false, error: SAVE_FAILED };

  const { data: existing, error: readError } = await service
    .from("company_plans")
    .select("live_minutes_limit")
    .eq("company_id", companyId)
    .maybeSingle();
  if (readError) {
    console.error("[plans-admin] plan read before save failed:", readError);
    return { ok: false, error: SAVE_FAILED };
  }

  const { error } = await service.rpc("set_company_plan", {
    p_company: companyId,
    p_actor: actorId,
    p_plan_name: value.planName,
    p_cv_scoring_limit: value.cvScoringLimit,
    p_async_interview_limit: value.asyncInterviewLimit,
    p_live_minutes_limit: num(
      (existing as { live_minutes_limit?: unknown } | null)?.live_minutes_limit,
    ),
    p_quoted_price: value.quotedPrice,
    p_currency: "USD",
    p_notes: value.notes,
  });
  if (error) {
    console.error("[plans-admin] set_company_plan failed:", error);
    return { ok: false, error: SAVE_FAILED };
  }
  return { ok: true };
}

/** Return a company to no plan (unlimited) through remove_company_plan, as `actorId`. */
export async function removeCompanyPlan(
  service: Service,
  actorId: string,
  companyId: string,
): Promise<WriteResult> {
  if (!actorId) return { ok: false, error: SAVE_FAILED };
  const { error } = await service.rpc("remove_company_plan", {
    p_company: companyId,
    p_actor: actorId,
  });
  if (error) {
    console.error("[plans-admin] remove_company_plan failed:", error);
    return {
      ok: false,
      error: "The plan could not be removed. Nothing was changed. Try again in a moment.",
    };
  }
  return { ok: true };
}
