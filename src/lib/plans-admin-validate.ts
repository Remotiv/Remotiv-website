/**
 * Validation for the Plans & Rates forms. Pure and import-free: the same rules
 * run in the browser for instant feedback and on the server as the gate.
 *
 * Inputs are the raw strings from the form. A blank field means "not set" for a
 * rate and "unlimited" for a limit, never zero: zero is a real value someone
 * can type, and it means something different.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_MONEY = 1_000_000;
const MAX_LIMIT = 10_000_000;

function blank(raw: string | undefined | null): boolean {
  return raw === undefined || raw === null || raw.trim() === "";
}

/** A number written plainly: digits, an optional point, no signs, no exponents. */
function plainNumber(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** USD amount or rate. Blank = not set (null). */
export function parseOptionalMoney(
  raw: string | undefined,
  decimals: number,
): Parsed<number | null> {
  if (blank(raw)) return { ok: true, value: null };
  const n = plainNumber(raw as string);
  if (n === null) return { ok: false, error: "Enter a number, like 0.05." };
  if (n > MAX_MONEY) return { ok: false, error: "That is too large." };
  const [, fraction = ""] = (raw as string).trim().split(".");
  if (fraction.length > decimals)
    return { ok: false, error: `Use at most ${decimals} decimal places.` };
  return { ok: true, value: n };
}

/** A monthly allowance. Blank = unlimited (null). Whole numbers only. */
export function parseOptionalLimit(raw: string | undefined): Parsed<number | null> {
  if (blank(raw)) return { ok: true, value: null };
  const t = (raw as string).trim().replace(/,/g, "");
  if (!/^\d+$/.test(t))
    return { ok: false, error: "Enter a whole number, or leave blank for unlimited." };
  const n = Number(t);
  if (n > MAX_LIMIT) return { ok: false, error: "That is too large." };
  return { ok: true, value: n };
}

/* ── pricing settings ───────────────────────────────────────────── */

export type PricingSettingsInput = {
  cv_score_cost: number | null;
  async_interview_cost: number | null;
  whatsapp_message_cost: number | null;
  fixed_monthly_cost: number | null;
  pkr_per_usd: number | null;
  clients_sharing_fixed_cost: number;
  minimum_price: number | null;
  minimum_margin_pct: number | null;
};

export type PricingField = keyof PricingSettingsInput;

/** What the form suggests, shown beside each field and filled only on request. */
export const SUGGESTED_PRICING: Record<PricingField, string> = {
  cv_score_cost: "0.033",
  async_interview_cost: "0.09",
  whatsapp_message_cost: "0.015",
  fixed_monthly_cost: "45",
  pkr_per_usd: "277",
  clients_sharing_fixed_cost: "10",
  minimum_price: "99",
  minimum_margin_pct: "60",
};

export function validatePricingSettings(
  form: Partial<Record<PricingField, string>>,
):
  | { ok: true; value: PricingSettingsInput }
  | { ok: false; errors: Partial<Record<PricingField, string>> } {
  const errors: Partial<Record<PricingField, string>> = {};
  const money = (field: PricingField, decimals: number) => {
    const r = parseOptionalMoney(form[field], decimals);
    if (!r.ok) {
      errors[field] = r.error;
      return null;
    }
    return r.value;
  };

  const cv_score_cost = money("cv_score_cost", 4);
  const async_interview_cost = money("async_interview_cost", 4);
  const whatsapp_message_cost = money("whatsapp_message_cost", 4);
  const fixed_monthly_cost = money("fixed_monthly_cost", 2);
  const minimum_price = money("minimum_price", 2);

  let pkr_per_usd = money("pkr_per_usd", 4);
  if (pkr_per_usd !== null && pkr_per_usd <= 0) {
    errors.pkr_per_usd = "The exchange rate must be above zero.";
    pkr_per_usd = null;
  }

  // Below 100, or the floor price (cost / (1 - margin)) has no value.
  let minimum_margin_pct = money("minimum_margin_pct", 2);
  if (minimum_margin_pct !== null && minimum_margin_pct >= 100) {
    errors.minimum_margin_pct = "The minimum margin must be below 100%.";
    minimum_margin_pct = null;
  }

  let clients_sharing_fixed_cost = 1;
  const clientsRaw = (form.clients_sharing_fixed_cost ?? "").trim();
  if (!/^\d+$/.test(clientsRaw) || Number(clientsRaw) < 1) {
    errors.clients_sharing_fixed_cost = "Enter a whole number of at least 1.";
  } else if (Number(clientsRaw) > 100_000) {
    errors.clients_sharing_fixed_cost = "That is too large.";
  } else {
    clients_sharing_fixed_cost = Number(clientsRaw);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      cv_score_cost,
      async_interview_cost,
      whatsapp_message_cost,
      fixed_monthly_cost,
      pkr_per_usd,
      clients_sharing_fixed_cost,
      minimum_price,
      minimum_margin_pct,
    },
  };
}

/* ── company plans ──────────────────────────────────────────────── */

export type CompanyPlanInput = {
  planName: string;
  /** NULL = unlimited. */
  cvScoringLimit: number | null;
  /** NULL = unlimited. Counts invitations sent. */
  asyncInterviewLimit: number | null;
  /** USD per month. NULL = no price recorded. */
  quotedPrice: number | null;
  notes: string | null;
};

export type PlanField =
  | "planName"
  | "cvScoringLimit"
  | "asyncInterviewLimit"
  | "quotedPrice"
  | "notes";

export function validateCompanyPlan(
  form: Partial<Record<PlanField, string>>,
):
  | { ok: true; value: CompanyPlanInput }
  | { ok: false; errors: Partial<Record<PlanField, string>> } {
  const errors: Partial<Record<PlanField, string>> = {};

  const planName = (form.planName ?? "").trim() || "Custom";
  if (planName.length > 80) errors.planName = "Keep the plan name to 80 characters.";

  const cv = parseOptionalLimit(form.cvScoringLimit);
  if (!cv.ok) errors.cvScoringLimit = cv.error;
  const asyncLimit = parseOptionalLimit(form.asyncInterviewLimit);
  if (!asyncLimit.ok) errors.asyncInterviewLimit = asyncLimit.error;
  const price = parseOptionalMoney(form.quotedPrice, 2);
  if (!price.ok) errors.quotedPrice = price.error;

  const notesRaw = (form.notes ?? "").trim();
  if (notesRaw.length > 2000) errors.notes = "Keep notes to 2,000 characters.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      planName,
      cvScoringLimit: cv.ok ? cv.value : null,
      asyncInterviewLimit: asyncLimit.ok ? asyncLimit.value : null,
      quotedPrice: price.ok ? price.value : null,
      notes: notesRaw === "" ? null : notesRaw,
    },
  };
}

/** Postgres uuid shape, so a malformed company id never reaches the database. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
