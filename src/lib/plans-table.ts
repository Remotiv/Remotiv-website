/**
 * The Plans & Rates table's pure rules: each company's plan status, search,
 * the status filter, and pages of twenty. Runs in the browser over rows the
 * page already holds; nothing here reads or writes the database.
 */
import { INTERNAL_LABEL, NO_PLAN_LABEL } from "./plans-usage-types";

export type PlanStatus = "internal" | "no_plan" | "on_plan";

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  internal: INTERNAL_LABEL,
  no_plan: NO_PLAN_LABEL,
  on_plan: "On plan",
};

/** Internal wins over everything: an internal company is exempt whatever its plan says. */
export function planStatus(company: { isInternal: boolean; plan: unknown | null }): PlanStatus {
  if (company.isInternal) return "internal";
  return company.plan === null ? "no_plan" : "on_plan";
}

export type PlansFilter = "all" | PlanStatus;

export const FILTERS: { id: PlansFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "on_plan", label: "On plan" },
  { id: "no_plan", label: "No plan" },
  { id: "internal", label: "Internal" },
];

type Row = { name: string; isInternal: boolean; plan: unknown | null };

/** Case-insensitive match on the company name; a blank query matches everyone. */
export function matchesQuery(row: Row, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return q === "" || row.name.toLocaleLowerCase().includes(q);
}

export function filterCompanies<T extends Row>(rows: T[], query: string, filter: PlansFilter): T[] {
  return rows.filter(
    (r) => matchesQuery(r, query) && (filter === "all" || planStatus(r) === filter),
  );
}

/** How many rows each filter would show, for the current search. */
export function countByFilter(rows: Row[], query: string): Record<PlansFilter, number> {
  const counts: Record<PlansFilter, number> = { all: 0, on_plan: 0, no_plan: 0, internal: 0 };
  for (const r of rows) {
    if (!matchesQuery(r, query)) continue;
    counts.all += 1;
    counts[planStatus(r)] += 1;
  }
  return counts;
}

export const PAGE_SIZE = 20;

export type Page<T> = {
  rows: T[];
  /** 1-based, clamped into range. */
  page: number;
  /** At least 1, so "page 1 of 1" holds even with no rows. */
  pageCount: number;
  total: number;
  /** 1-based positions of the first and last row shown; 0 and 0 when empty. */
  from: number;
  to: number;
};

/** One page of rows. A page past the end shows the last page; below 1 shows the first. */
export function paginate<T>(rows: T[], page: number, size: number = PAGE_SIZE): Page<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const shown = rows.slice(start, start + size);
  return {
    rows: shown,
    page: current,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + shown.length,
  };
}

/** A monthly limit as the table shows it. NULL is unlimited, never zero. */
export function limitLabel(limit: number | null): string {
  return limit === null ? "Unlimited" : limit.toLocaleString("en-US");
}

/** A rate with the precision it was entered at (up to 4 places), e.g. $0.033. */
export function formatRate(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
