import "server-only";
import {
  type CompanyUsage,
  karachiMonthWindow,
  type PlansUsageResult,
  type PricingRates,
  type UsageReadError,
} from "@/lib/plans-usage-types";
import { pageAll } from "@/lib/supabase/paging";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The admin Usage tab's one database read: this calendar month, per company.
 *
 * READ ONLY. Every query here is a SELECT. It never writes, never calls
 * consume_allowance or release_allowance, and never touches a scoring path, so
 * opening the tab cannot spend, reserve or release anything.
 *
 * ── What is counted, and from where ──────────────────────────
 *
 *   AI-scored applicants   usage_events, type cv_scored. One row per scoring
 *                          run, so a re-score counts, which matches the locked
 *                          decision that re-scores consume a credit.
 *   Async invitations      interview_sessions created this month, kind async.
 *                          Each re-send is a new session, so it counts. This
 *                          is what the allowance counts.
 *   Completed async        interview_sessions kind async, status submitted,
 *                          with submitted_at this month. This is what the async
 *                          cost uses. Unambiguous: the submit route is the only
 *                          writer of 'submitted' and stamps submitted_at in the
 *                          same guarded update, and nothing moves a submitted
 *                          session to another status. Two things it does not
 *                          see: answers from an interview that expired
 *                          unsubmitted (transcribed, so they cost, but not
 *                          counted here), and a deleted interview (its row is
 *                          gone).
 *   Live AI interviews     interview_sessions created this month, kind live. A
 *                          count only; minutes are not measured, so nothing is
 *                          compared with a minutes allowance or costed.
 *   WhatsApp delivered     communication_logs, channel whatsapp, status
 *                          delivered or read, by the month the message was
 *                          sent. A message sent on the last evening and read
 *                          the next morning counts in the month it was sent.
 *
 * ── Failure ──────────────────────────────────────────────────
 *
 * All or nothing. If any read fails, the result says which category failed and
 * carries no numbers at all: a page of counts with one source missing looks
 * complete and is wrong, which is worse than a page that says it could not
 * load. The raw database message goes to the server log only.
 */

type Service = ReturnType<typeof createServiceClient>;

type CompanyRow = {
  id: string;
  name: string | null;
  status: string | null;
  is_internal: boolean | null;
};
type PlanRow = {
  company_id: string;
  plan_name: string | null;
  cv_scoring_limit: number | null;
  async_interview_limit: number | null;
  live_minutes_limit: number | null;
  quoted_price: number | string | null;
  currency: string | null;
};
type SettingsRow = {
  cv_score_cost: number | string | null;
  async_interview_cost: number | string | null;
  live_minute_cost: number | string | null;
  whatsapp_message_cost: number | string | null;
  fixed_monthly_cost: number | string | null;
  clients_sharing_fixed_cost: number | null;
  pkr_per_usd: number | string | null;
};

/** Per-company totals. Rows with no company (Remotiv-owned) are not anyone's usage. */
function sumByCompany<R extends { company_id: string | null }>(
  rows: R[],
  amount: (row: R) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.company_id) continue;
    out.set(row.company_id, (out.get(row.company_id) ?? 0) + amount(row));
  }
  return out;
}

/** numeric columns can arrive as strings; NULL stays NULL, never becomes 0. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function readPlansUsage(
  service: Service,
  now: Date = new Date(),
): Promise<PlansUsageResult> {
  const window = karachiMonthWindow(now);
  const readErrors: UsageReadError[] = [];

  /** Run one read; on failure record its category and log the raw cause. */
  async function attempt<T>(source: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      readErrors.push({ source });
      const cause = err instanceof Error && err.cause ? err.cause : err;
      console.error(`[plans-usage] read failed (${source}):`, cause);
      return null;
    }
  }

  /** A single-shot query: throw on error so attempt() records it. */
  async function one<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
    const { data, error } = await query;
    if (error) throw new Error("query failed", { cause: error });
    return data as T;
  }

  const [companies, plans, settings, cvRows, sessionRows, completedRows, whatsappRows] =
    await Promise.all([
      attempt("companies", () =>
        one<CompanyRow[]>(
          service.from("companies").select("id, name, status, is_internal").order("name"),
        ),
      ),
      attempt("plans", () =>
        one<PlanRow[]>(
          service
            .from("company_plans")
            .select(
              "company_id, plan_name, cv_scoring_limit, async_interview_limit, live_minutes_limit, quoted_price, currency",
            ),
        ),
      ),
      attempt("pricing settings", async () => {
        const row = await one<SettingsRow | null>(
          service
            .from("pricing_settings")
            .select(
              "cv_score_cost, async_interview_cost, live_minute_cost, whatsapp_message_cost, fixed_monthly_cost, clients_sharing_fixed_cost, pkr_per_usd",
            )
            .eq("id", "default")
            .maybeSingle(),
        );
        // Migration 037 inserts this row. Its absence is a broken install, not
        // "all rates unset", so it is reported rather than defaulted.
        if (!row) throw new Error("pricing_settings default row is missing");
        return row;
      }),
      attempt("AI scoring usage", () =>
        pageAll<{ company_id: string | null; quantity: number | null }>(
          (from, to) =>
            service
              .from("usage_events")
              .select("company_id, quantity")
              .eq("type", "cv_scored")
              .gte("created_at", window.startIso)
              .lt("created_at", window.endIso)
              .order("id")
              .range(from, to),
          { scope: "plans-usage", label: "cv_scored usage" },
        ),
      ),
      attempt("interview invitations", () =>
        pageAll<{ company_id: string | null; kind: string | null }>(
          (from, to) =>
            service
              .from("interview_sessions")
              .select("company_id, kind")
              .gte("created_at", window.startIso)
              .lt("created_at", window.endIso)
              .order("id")
              .range(from, to),
          { scope: "plans-usage", label: "interview sessions" },
        ),
      ),
      attempt("interview completions", () =>
        pageAll<{ company_id: string | null }>(
          (from, to) =>
            service
              .from("interview_sessions")
              .select("company_id")
              .eq("kind", "async")
              .eq("status", "submitted")
              .gte("submitted_at", window.startIso)
              .lt("submitted_at", window.endIso)
              .order("id")
              .range(from, to),
          { scope: "plans-usage", label: "async completions" },
        ),
      ),
      attempt("WhatsApp deliveries", () =>
        pageAll<{ company_id: string | null }>(
          (from, to) =>
            service
              .from("communication_logs")
              .select("company_id")
              .eq("channel", "whatsapp")
              .in("status", ["delivered", "read"])
              .gte("created_at", window.startIso)
              .lt("created_at", window.endIso)
              .order("id")
              .range(from, to),
          { scope: "plans-usage", label: "whatsapp deliveries" },
        ),
      ),
    ]);

  if (
    readErrors.length > 0 ||
    !companies ||
    !plans ||
    !settings ||
    !cvRows ||
    !sessionRows ||
    !completedRows ||
    !whatsappRows
  ) {
    return { ok: false, window, readErrors };
  }

  const rates: PricingRates = {
    cvScoreCost: num(settings.cv_score_cost),
    asyncInterviewCost: num(settings.async_interview_cost),
    liveMinuteCost: num(settings.live_minute_cost),
    whatsappMessageCost: num(settings.whatsapp_message_cost),
    fixedMonthlyCost: num(settings.fixed_monthly_cost),
    clientsSharingFixedCost: Math.max(1, settings.clients_sharing_fixed_cost ?? 1),
    pkrPerUsd: num(settings.pkr_per_usd),
  };

  const planByCompany = new Map(plans.map((p) => [p.company_id, p]));
  const cv = sumByCompany(cvRows, (r) => r.quantity ?? 1);
  const asyncInv = sumByCompany(
    sessionRows.filter((s) => s.kind === "async"),
    () => 1,
  );
  const live = sumByCompany(
    sessionRows.filter((s) => s.kind === "live"),
    () => 1,
  );
  const completed = sumByCompany(completedRows, () => 1);
  const whatsapp = sumByCompany(whatsappRows, () => 1);

  const result: CompanyUsage[] = companies.map((c) => {
    const p = planByCompany.get(c.id);
    return {
      companyId: c.id,
      name: c.name ?? "Unnamed company",
      status: c.status ?? "unknown",
      isInternal: c.is_internal === true,
      plan: p
        ? {
            planName: p.plan_name ?? "Custom",
            cvScoringLimit: p.cv_scoring_limit,
            asyncInterviewLimit: p.async_interview_limit,
            liveMinutesLimit: p.live_minutes_limit,
            quotedPrice: num(p.quoted_price),
            currency: p.currency ?? "USD",
          }
        : null,
      cvScored: cv.get(c.id) ?? 0,
      asyncInvitations: asyncInv.get(c.id) ?? 0,
      asyncCompleted: completed.get(c.id) ?? 0,
      liveInterviews: live.get(c.id) ?? 0,
      whatsappDelivered: whatsapp.get(c.id) ?? 0,
    };
  });

  return { ok: true, window, rates, companies: result };
}
