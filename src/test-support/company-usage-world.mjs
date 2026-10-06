/**
 * A two-company database for the client usage tests, built on fake-postgrest.
 *
 * Unlike most fakes here, this one HONOURS the filters the code sends, the way
 * PostgREST would, because the point of these tests is that the code sends the
 * right ones:
 *
 *   eq("id" | "company_id", x)  only that company's rows; with no company
 *                               filter, every company's rows come back, so a
 *                               missing filter shows up as another company's
 *                               figures rather than passing quietly
 *   eq("type", t)               only that usage type; missing, both types
 *   gte("created_at", t)        only rows at or after t; missing, last month too
 *   range(a, b)                 that slice, as pageAll asks
 *
 * The usage rows straddle the month boundary in Asia/Karachi: 19:30 UTC on 30
 * September is already 1 October there and counts; 18:30 UTC is still 30
 * September and does not. A UTC month start would get both wrong.
 *
 * Test-only. Nothing in the application imports this.
 */
import { call, fakeService } from "./fake-postgrest.mjs";

export const COMPANY = "co-acme";
export const OTHER = "co-other";

const IN_OCTOBER_KARACHI = "2026-09-30T19:30:00.000Z";
const SEPTEMBER_KARACHI = "2026-09-30T18:30:00.000Z";

export const DB = {
  companies: [
    { id: COMPANY, is_internal: false },
    { id: OTHER, is_internal: false },
  ],
  company_plans: [
    {
      company_id: COMPANY,
      plan_name: "Growth",
      cv_scoring_limit: 300,
      async_interview_limit: 50,
      quoted_price: "199.00",
      currency: "USD",
    },
    {
      company_id: OTHER,
      plan_name: "Enterprise",
      cv_scoring_limit: 5000,
      async_interview_limit: 900,
      quoted_price: "5000.00",
      currency: "USD",
    },
  ],
  usage_events: [
    // Acme, October in Karachi: 82 AI scores (one row carries quantity 2), 24 invitations.
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `cv-${i}`,
      company_id: COMPANY,
      type: "cv_scored",
      quantity: 1,
      created_at: "2026-10-10T08:00:00.000Z",
    })),
    {
      id: "cv-q2",
      company_id: COMPANY,
      type: "cv_scored",
      quantity: 2,
      created_at: IN_OCTOBER_KARACHI,
    },
    ...Array.from({ length: 24 }, (_, i) => ({
      id: `inv-${i}`,
      company_id: COMPANY,
      type: "interview_sent",
      quantity: 1,
      created_at: "2026-10-12T08:00:00.000Z",
    })),
    // Acme, still September in Karachi: never counted.
    {
      id: "cv-sep",
      company_id: COMPANY,
      type: "cv_scored",
      quantity: 40,
      created_at: SEPTEMBER_KARACHI,
    },
    {
      id: "inv-sep",
      company_id: COMPANY,
      type: "interview_sent",
      quantity: 7,
      created_at: SEPTEMBER_KARACHI,
    },
    // Another company's October usage: never Acme's.
    {
      id: "o-cv",
      company_id: OTHER,
      type: "cv_scored",
      quantity: 999,
      created_at: "2026-10-10T08:00:00.000Z",
    },
    {
      id: "o-inv",
      company_id: OTHER,
      type: "interview_sent",
      quantity: 333,
      created_at: "2026-10-10T08:00:00.000Z",
    },
    // Not a capped metric: never counted as either.
    {
      id: "x",
      company_id: COMPANY,
      type: "interview_scored",
      quantity: 500,
      created_at: "2026-10-10T08:00:00.000Z",
    },
  ],
};

const eqValue = (calls, col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];

/**
 * @param {{ db?: typeof DB, failing?: string | null }} [opts]
 *   failing: a table whose read returns a database error with RAW_ERROR.
 */
export const RAW_ERROR = 'permission denied for table "company_plans" (SQLSTATE 42501)';

export function usageWorld({ db = DB, failing = null } = {}) {
  return fakeService((table, calls) => {
    if (table === failing) return { data: null, error: { message: RAW_ERROR } };
    let rows = db[table];
    if (!rows) throw new Error(`unexpected table ${table}`);
    const companyCol = table === "companies" ? "id" : "company_id";
    const company = eqValue(calls, companyCol);
    if (company !== undefined) rows = rows.filter((r) => r[companyCol] === company);
    const type = eqValue(calls, "type");
    if (type !== undefined) rows = rows.filter((r) => r.type === type);
    const gte = call(calls, "gte");
    if (gte) rows = rows.filter((r) => r[gte[1]] >= gte[2]);

    // Only the selected columns come back, as PostgREST would.
    const select = call(calls, "select")?.[1];
    if (select) {
      const cols = select.split(",").map((c) => c.trim());
      rows = rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
    }

    if (calls.some((c) => c[0] === "maybeSingle")) {
      // With no company filter this is a different company's row - the leak made visible.
      return {
        data: company === undefined ? (rows.at(-1) ?? null) : (rows[0] ?? null),
        error: null,
      };
    }
    const range = call(calls, "range");
    return { data: range ? rows.slice(range[1], range[2] + 1) : rows, error: null };
  });
}
