"use client";

import { useId, useMemo, useState } from "react";
import type { AdminCompany } from "@/lib/plans-admin";
import {
  countByFilter,
  FILTERS,
  filterCompanies,
  limitLabel,
  PAGE_SIZE,
  PLAN_STATUS_LABEL,
  type PlanStatus,
  type PlansFilter,
  paginate,
  planStatus,
} from "@/lib/plans-table";
import { formatPkr } from "@/lib/plans-usage-types";
import { cn } from "@/lib/utils";
import { PlanDrawer } from "./_plan-drawer";

/**
 * Every company's plan, as a table: search, a status filter and pages of
 * twenty, all in the browser over rows the page already has. One drawer at a
 * time edits one company; history is read only inside it.
 */

const BADGE =
  "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold";
const STATUS_STYLE: Record<PlanStatus, string> = {
  internal: "bg-remotiv-purple/10 text-remotiv-purple",
  no_plan: "bg-red-50 text-red-700 ring-1 ring-red-200",
  on_plan: "bg-remotiv-green/15 text-gray-800",
};
const HEAD =
  "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500";
const CELL = "px-3 py-3 align-middle text-sm text-gray-800";
const ACTION =
  "inline-flex min-h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50";

export function PlansTable({
  companies,
  pkrPerUsd,
}: {
  companies: AdminCompany[];
  pkrPerUsd: number | null;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PlansFilter>("all");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => countByFilter(companies, query), [companies, query]);
  const shown = useMemo(
    () => paginate(filterCompanies(companies, query, filter), page),
    [companies, query, filter, page],
  );
  // Looked up from the live prop, so a save that refreshes the page refreshes
  // the drawer's plan too. Internal companies never open.
  const open = companies.find((c) => c.id === openId && !c.isInternal) ?? null;

  return (
    <section aria-label="Company plans" className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="w-full lg:max-w-sm">
          <label htmlFor={searchId} className="block text-sm font-medium text-gray-800">
            Search companies
          </label>
          <input
            id={searchId}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-remotiv-purple"
          />
        </div>
        <fieldset>
          <legend className="sr-only">Filter by plan status</legend>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setPage(1);
                }}
                className={cn(
                  "inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold",
                  filter === f.id
                    ? "bg-gray-900 text-white"
                    : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                )}
              >
                {f.label}
                <span className={filter === f.id ? "text-white/70" : "text-gray-400"}>
                  {counts[f.id]}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <caption className="sr-only">
            Company plans, page {shown.page} of {shown.pageCount}
          </caption>
          <thead>
            <tr className="border-b border-gray-100">
              <th scope="col" className={HEAD}>
                Company
              </th>
              <th scope="col" className={HEAD}>
                Status
              </th>
              <th scope="col" className={HEAD}>
                Plan
              </th>
              <th scope="col" className={HEAD}>
                CV scoring limit
              </th>
              <th scope="col" className={HEAD}>
                Async interview limit
              </th>
              <th scope="col" className={HEAD}>
                Quoted price
              </th>
              <th scope="col" className={HEAD}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className={cn(CELL, "py-8 text-center text-gray-500")}>
                  No companies match.
                </td>
              </tr>
            ) : (
              shown.rows.map((c) => {
                const status = planStatus(c);
                return (
                  <tr key={c.id} className="border-b border-gray-50 last:border-b-0">
                    <th scope="row" className={cn(CELL, "text-left font-semibold text-gray-900")}>
                      {c.name}
                      {c.status !== "active" && (
                        <span className="block text-xs font-normal text-gray-500">{c.status}</span>
                      )}
                    </th>
                    <td className={CELL}>
                      <span className={cn(BADGE, STATUS_STYLE[status])}>
                        {PLAN_STATUS_LABEL[status]}
                      </span>
                    </td>
                    <td className={CELL}>
                      {c.plan?.planName ?? <span className="text-gray-400">-</span>}
                    </td>
                    <td className={CELL}>
                      {c.plan ? (
                        limitLabel(c.plan.cvScoringLimit)
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className={CELL}>
                      {c.plan ? (
                        limitLabel(c.plan.asyncInterviewLimit)
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className={CELL}>
                      {c.plan?.quotedPrice != null ? (
                        <>
                          {c.plan.currency} {c.plan.quotedPrice.toLocaleString("en-US")}
                          {pkrPerUsd !== null && c.plan.currency === "USD" && (
                            <span className="block text-xs text-gray-500">
                              {formatPkr(c.plan.quotedPrice, pkrPerUsd)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className={CELL}>
                      {status === "internal" ? (
                        <span className="text-sm text-gray-500">Not needed</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setOpenId(c.id)}
                          aria-label={`${status === "on_plan" ? "Edit plan" : "Create plan"} for ${c.name}`}
                          className={ACTION}
                        >
                          {status === "on_plan" ? "Edit" : "Create plan"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <nav
        aria-label="Company plans pages"
        className="mt-4 flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-sm text-gray-600" aria-live="polite">
          {shown.total === 0
            ? "No companies"
            : `Showing ${shown.from}-${shown.to} of ${shown.total}`}
          <span className="sr-only">, {PAGE_SIZE} per page</span>
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={shown.page <= 1}
            onClick={() => setPage(shown.page - 1)}
            className={cn(ACTION, "disabled:opacity-40")}
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {shown.page} of {shown.pageCount}
          </span>
          <button
            type="button"
            disabled={shown.page >= shown.pageCount}
            onClick={() => setPage(shown.page + 1)}
            className={cn(ACTION, "disabled:opacity-40")}
          >
            Next
          </button>
        </div>
      </nav>

      {open && <PlanDrawer company={open} pkrPerUsd={pkrPerUsd} onClose={() => setOpenId(null)} />}
    </section>
  );
}
