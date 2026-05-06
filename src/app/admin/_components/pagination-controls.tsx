"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE = 20;

/**
 * Client-side pagination control for admin dashboards.
 *
 * Why client-side: every list dashboard (talent / remote-talent /
 * applications / jobs / contacts / batch-detail) keeps its filter +
 * search state in `useState` and narrows the list with `useMemo`.
 * Switching to server-side `?page=N` would only paginate raw rows,
 * which would silently break every filter — page 2 would still
 * filter the *next 20 raw rows*, not the next 20 filtered rows.
 *
 * The trade-off: each dashboard still SELECTs its full list once,
 * which is fine until tables hit ~5–10k rows. When that becomes a
 * problem, promote filters to URL search params and convert this
 * to a server-side pagination control.
 */
export function PaginationControls({
  page,
  setPage,
  total,
  pageSize = PAGE_SIZE,
}: {
  page: number;
  setPage: (next: number) => void;
  total: number;
  pageSize?: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(total, safePage * pageSize);
  const prevDisabled = safePage <= 1;
  const nextDisabled = safePage >= totalPages;

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-100 pt-4 sm:flex-row">
      <p className="text-xs text-gray-500">
        Showing <span className="font-semibold text-gray-700">{from}</span>
        {" – "}
        <span className="font-semibold text-gray-700">{to}</span> of{" "}
        <span className="font-semibold text-gray-700">{total}</span>
        <span className="ml-2 hidden text-gray-400 sm:inline">
          · Page {safePage} of {totalPages}
        </span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setPage(safePage - 1)}
          disabled={prevDisabled}
          className={`flex items-center gap-1 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${
            prevDisabled
              ? "cursor-not-allowed bg-gray-50 text-gray-300"
              : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
          }`}
        >
          <ChevronLeft className="size-4" strokeWidth={2.5} />
          Previous
        </button>
        <button
          type="button"
          onClick={() => setPage(safePage + 1)}
          disabled={nextDisabled}
          className={`flex items-center gap-1 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${
            nextDisabled
              ? "cursor-not-allowed bg-gray-50 text-gray-300"
              : "bg-remotiv-purple text-white hover:bg-[#6a38e0]"
          }`}
        >
          Next
          <ChevronRight className="size-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

/**
 * Compute the slice of items visible on the current page.
 * Pure helper — no react state.
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number = PAGE_SIZE,
): T[] {
  const safePage = Math.max(1, page);
  const from = (safePage - 1) * pageSize;
  return items.slice(from, from + pageSize);
}
