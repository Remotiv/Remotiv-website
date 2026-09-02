"use client";

import { LoadFailed } from "./load-failed";
import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Calendar,
  DollarSign,
  Mail,
  Search as SearchIcon,
  Trash2,
  User,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  deleteHireRequest,
  updateHireRequestStatus,
  type HireRequest,
  type HireRequestStatus,
} from "@/app/admin/hire-requests/actions";
import { type UserRole } from "@/app/admin/lib/roles";
import { friendlyError } from "@/app/admin/lib/errors";

const STATUS_FILTERS: ReadonlyArray<"All" | HireRequestStatus> = [
  "All",
  "new",
  "contacted",
  "matched",
  "placed",
  "archived",
];

const STATUS_LABEL: Record<string, string> = {
  All: "All",
  new: "New",
  contacted: "Contacted",
  matched: "Matched",
  placed: "Placed",
  archived: "Archived",
};

const STATUS_BADGE: Record<HireRequestStatus, string> = {
  new:       "bg-blue-100 text-blue-700",
  contacted: "bg-amber-100 text-amber-700",
  matched:   "bg-purple-100 text-purple-700",
  placed:    "bg-green-100 text-green-700",
  archived:  "bg-gray-100 text-gray-400",
};

const STATUS_OPTIONS: ReadonlyArray<HireRequestStatus> = [
  "new",
  "contacted",
  "matched",
  "placed",
  "archived",
];

function humanizeEngagement(type: string): string {
  if (type === "per_hour") return "Per hour";
  if (type === "per_month") return "Per month";
  if (type === "full_time") return "Full time";
  return type || "—";
}

function humanizeTimeline(timeline: string): string {
  if (timeline === "asap") return "ASAP";
  if (timeline === "within_2_weeks") return "Within 2 weeks";
  if (timeline === "within_1_month") return "Within 1 month";
  if (timeline === "flexible") return "Flexible";
  return timeline || "—";
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function HireRequestsDashboard({
  email,
  userRole,
  initialRequests,
  loadFailed,
}: {
  email: string;
  userRole: UserRole;
  initialRequests: HireRequest[];
  /** The read failed. Distinct from "there are no requests". */
  loadFailed: boolean;
}) {
  const [requests, setRequests] = useState<HireRequest[]>(initialRequests);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => setRequests(initialRequests), [initialRequests]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    setPage(1);
  }, [search, filterStatus]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      if (filterStatus !== "All" && r.status !== filterStatus) return false;
      if (q) {
        const blob = `${r.full_name} ${r.email} ${r.company} ${r.candidate_name ?? ""} ${r.project_description}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [requests, search, filterStatus]);

  const pageItems = paginate(filtered, page);

  const totalCount = requests.length;
  const newCount = requests.filter((r) => r.status === "new").length;

  async function handleStatusChange(id: string, next: HireRequestStatus) {
    const prev = requests.find((r) => r.id === id);
    if (!prev) return;

    setRequests((rows) =>
      rows.map((r) => (r.id === id ? { ...r, status: next } : r)),
    );

    const result = await updateHireRequestStatus(id, next);
    if (!result.success) {
      setRequests((rows) =>
        rows.map((r) => (r.id === id ? { ...r, status: prev.status } : r)),
      );
      setToast(`Status update failed: ${friendlyError(result.error)}`);
      return;
    }
    setToast(`Marked as ${STATUS_LABEL[next] ?? next}`);
  }

  async function handleDelete(id: string, candidateName: string | null) {
    const label = candidateName ? `the request for ${candidateName}` : "this hire request";
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    const snapshot = requests;
    setRequests((rows) => rows.filter((r) => r.id !== id));

    const result = await deleteHireRequest(id);
    if (!result.success) {
      setRequests(snapshot);
      setToast(`Delete failed: ${friendlyError(result.error)}`);
      return;
    }
    setToast("Hire request deleted");
  }

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-400">Hire Requests</p>
          <h1 className="font-heading text-2xl font-bold text-gray-900">
            Connect with Talent requests
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {totalCount} total · {newCount} new
          </p>
        </div>

        {/* Search + status filter pills */}
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative max-w-md flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, company, candidate, project…"
              className="h-11 w-full rounded-xl border border-gray-200 bg-white pl-10 pr-3 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-remotiv-purple"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((s) => {
              const active = filterStatus === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus(s)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-remotiv-purple text-white"
                      : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
                  }`}
                >
                  {STATUS_LABEL[s] ?? s}
                </button>
              );
            })}
          </div>
        </div>

        {/* List */}
        <div className="flex flex-col gap-3">
          {loadFailed ? (
            <LoadFailed what="hire requests" />
          ) : pageItems.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-14 text-center">
              <p className="text-sm font-medium text-gray-600">
                {requests.length === 0
                  ? "No hire requests yet."
                  : "No requests match your filters."}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {requests.length === 0
                  ? "When clients submit Connect with Talent, they'll appear here."
                  : "Try clearing the search or status filter."}
              </p>
            </div>
          ) : (
            pageItems.map((r) => (
              <article
                key={r.id}
                className="rounded-2xl border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.02)]"
              >
                {/* Header: name + company + status + date */}
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-heading text-base font-bold text-gray-900">
                        {r.full_name}
                      </h2>
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                        <Building2 className="size-3.5" strokeWidth={2} />
                        {r.company}
                      </span>
                    </div>
                    <a
                      href={`mailto:${r.email}`}
                      className="mt-1 inline-flex items-center gap-1 text-xs text-remotiv-purple hover:underline"
                    >
                      <Mail className="size-3.5" strokeWidth={2} />
                      {r.email}
                    </a>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_BADGE[r.status]}`}
                    >
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-400">
                      <Calendar className="size-3" strokeWidth={2} />
                      {fmtDate(r.created_at)}
                    </span>
                  </div>
                </div>

                {/* Candidate context */}
                {(r.candidate_name || r.candidate_rate) && (
                  <div className="mb-3 inline-flex items-center gap-2 rounded-lg bg-purple-50 px-3 py-1.5 text-xs text-purple-800">
                    <User className="size-3.5" strokeWidth={2} />
                    Interested in:{" "}
                    <span className="font-semibold">
                      {r.candidate_name ?? "—"}
                      {r.candidate_rate ? ` · ${r.candidate_rate}` : ""}
                    </span>
                  </div>
                )}

                {/* Request facts */}
                <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Engagement
                    </p>
                    <p className="mt-0.5 text-sm text-gray-800">
                      {humanizeEngagement(r.engagement_type)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                    <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      <DollarSign className="size-3" strokeWidth={2} />
                      Budget
                    </p>
                    <p className="mt-0.5 text-sm text-gray-800">
                      {r.budget_range || "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Timeline
                    </p>
                    <p className="mt-0.5 text-sm text-gray-800">
                      {humanizeTimeline(r.timeline)}
                    </p>
                  </div>
                </div>

                {/* Project description */}
                <div className="mb-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                    Project description
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                    {r.project_description || "—"}
                  </p>
                </div>

                {/* Notes (if any) */}
                {r.notes && (
                  <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                      Notes from client
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-amber-900">
                      {r.notes}
                    </p>
                  </div>
                )}

                {/* Actions footer */}
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-3">
                  <label className="flex items-center gap-2 text-xs text-gray-500">
                    Status:
                    <select
                      value={r.status}
                      onChange={(e) =>
                        handleStatusChange(r.id, e.target.value as HireRequestStatus)
                      }
                      className="h-9 cursor-pointer rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-800 outline-none transition-colors focus:border-remotiv-purple"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s] ?? s}
                        </option>
                      ))}
                    </select>
                  </label>

                  {userRole === "super_admin" && (
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id, r.candidate_name)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50"
                    >
                      <Trash2 className="size-3.5" strokeWidth={2} />
                      Delete
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        <div className="mt-6">
          <PaginationControls page={page} setPage={setPage} total={filtered.length} />
        </div>
      </main>

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[60] rounded-xl bg-[#111] px-4 py-3 text-sm font-medium text-white shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
