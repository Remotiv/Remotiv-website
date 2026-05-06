"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Briefcase,
  Plus,
  Search as SearchIcon,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { TopNav } from "./top-nav";
import {
  createBatch,
  type ActiveClient,
  type BatchStatus,
  type ClientBatch,
} from "@/app/admin/client-batches/actions";
import { type UserRole } from "@/app/admin/lib/roles";

const STATUS_FILTERS: Array<"All" | BatchStatus> = ["All", "active", "closed", "archived"];

const STATUS_LABEL: Record<string, string> = {
  All: "All",
  active: "Active",
  closed: "Closed",
  archived: "Archived",
};

const STATUS_BADGE: Record<BatchStatus, { badge: string; dot: string }> = {
  active:   { badge: "bg-green-100 text-green-700",  dot: "bg-green-500" },
  closed:   { badge: "bg-blue-100 text-blue-700",    dot: "bg-blue-500"  },
  archived: { badge: "bg-gray-100 text-gray-500",    dot: "bg-gray-400"  },
};

function fmtDaysAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function StatCard({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm">
      <p className={`text-[10px] font-semibold uppercase tracking-widest ${tint}`}>{label}</p>
      <p className="mt-2 font-heading text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function BatchCard({ batch }: { batch: ClientBatch }) {
  const meta = STATUS_BADGE[batch.status];
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${meta.badge}`}>
          <span className={`size-1.5 rounded-full ${meta.dot}`} />
          {STATUS_LABEL[batch.status] ?? batch.status}
        </span>
        <span className="text-[10px] text-gray-300">Created {fmtDaysAgo(batch.created_at)}</span>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          {batch.client_name}
        </p>
        <p className="mt-1 font-heading text-base font-bold text-gray-900">{batch.batch_name}</p>
        {batch.position_title && (
          <p className="mt-0.5 text-xs text-gray-500">Position: {batch.position_title}</p>
        )}
      </div>

      <p className="flex items-center gap-1 text-xs font-medium text-gray-500">
        <Users className="size-3" strokeWidth={2} />
        {batch.candidate_count} {batch.candidate_count === 1 ? "Candidate" : "Candidates"}
      </p>

      <Link
        href={`/admin/client-batches/${batch.id}`}
        className="mt-auto flex items-center justify-center gap-1.5 rounded-xl bg-remotiv-purple/10 px-4 py-2 text-xs font-semibold text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
      >
        Manage Batch →
      </Link>
    </div>
  );
}

function CreateBatchModal({
  activeClients,
  defaultClientId,
  onClose,
}: {
  activeClients: ActiveClient[];
  defaultClientId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [clientId, setClientId] = useState(defaultClientId ?? "");
  const [batchName, setBatchName] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Belt-and-braces guard. createBatch isn't reversible from the UI; a
  // double-click would land the admin in the first batch's detail page
  // while leaving an extra sibling batch behind.
  const inFlightRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);
    if (!clientId) return setError("Select a client.");
    if (!batchName.trim()) return setError("Batch name is required.");
    if (!positionTitle.trim()) return setError("Position title is required.");

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const result = await createBatch({
        client_id: clientId,
        batch_name: batchName.trim(),
        position_title: positionTitle.trim(),
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.push(`/admin/client-batches/${result.data.id}`);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={() => !submitting && onClose()}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative my-4 flex w-full max-w-[480px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="relative shrink-0 border-b border-gray-100 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2 className="font-heading text-lg font-bold text-gray-900">Create New Batch</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Provisions an empty pipeline. Add candidates after creation.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">
              Client <span className="ml-0.5 text-red-500">*</span>
            </span>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={inputCls}
            >
              <option value="">Select client…</option>
              {activeClients.map((c) => (
                <option key={c.id} value={c.id}>{c.company_name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">
              Batch Name <span className="ml-0.5 text-red-500">*</span>
            </span>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="e.g. Software Engineer Batch #1"
              className={inputCls}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">
              Position Title <span className="ml-0.5 text-red-500">*</span>
            </span>
            <input
              type="text"
              value={positionTitle}
              onChange={(e) => setPositionTitle(e.target.value)}
              placeholder="e.g. Full Stack Developer"
              className={inputCls}
            />
          </div>
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-xl bg-remotiv-purple px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              {submitting ? "Creating…" : "Create Batch"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ClientBatchesDashboard({
  email,
  userRole,
  initialBatches,
  activeClients,
  filterClientId,
  filterClientName,
}: {
  email: string;
  userRole: UserRole;
  initialBatches: ClientBatch[];
  activeClients: ActiveClient[];
  filterClientId: string | null;
  filterClientName: string | null;
}) {
  const [batches] = useState<ClientBatch[]>(initialBatches);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [showCreate, setShowCreate] = useState(false);

  // Mobile filter drawer state
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  useEffect(() => {
    if (!filterDrawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFilterDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [filterDrawerOpen]);
  const activeFilterCount = filterStatus !== "All" ? 1 : 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return batches.filter((b) => {
      if (filterStatus !== "All" && b.status !== filterStatus) return false;
      if (q) {
        const blob = `${b.batch_name} ${b.position_title} ${b.client_name}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [batches, search, filterStatus]);

  const totalCount    = batches.length;
  const activeCount   = batches.filter((b) => b.status === "active").length;
  const closedCount   = batches.filter((b) => b.status === "closed").length;
  const archivedCount = batches.filter((b) => b.status === "archived").length;

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        {filterClientId && (
          <p className="mb-3 flex items-center gap-2 text-xs text-gray-400">
            <Link href="/admin/clients" className="inline-flex items-center gap-1 hover:text-remotiv-purple">
              <ArrowLeft className="size-3" strokeWidth={2} />
              All Clients
            </Link>
            <span>/</span>
            <span className="text-gray-700">{filterClientName ?? "Client"}</span>
            <span>/</span>
            <span className="text-gray-700">Batches</span>
          </p>
        )}

        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs text-gray-400">Client Batches</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">
              {filterClientName ? `${filterClientName} — Batches` : "Client Batches"}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              {totalCount} total · {activeCount} active · {closedCount} closed · {archivedCount} archived
            </p>
          </div>

          {/* Desktop search + New Batch */}
          <div className="hidden items-center gap-3 lg:flex">
            <div className="flex flex-1 items-center gap-2 rounded-2xl bg-white p-2 shadow-sm lg:w-[360px]">
              <SearchIcon className="ml-2 size-4 shrink-0 text-gray-400" strokeWidth={2} />
              <input
                type="text"
                placeholder="Search by batch name, position, or client…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex shrink-0 items-center gap-2 rounded-xl bg-remotiv-purple px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              New Batch
            </button>
          </div>
        </div>

        {/* Mobile search + Filters + New Batch row */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <div className="relative flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="text"
              placeholder="Search batches…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-10 pr-4 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-remotiv-purple/40 focus:ring-2 focus:ring-remotiv-purple/20"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(true)}
            aria-label="Open filters"
            className="relative flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            <SlidersHorizontal className="size-4" strokeWidth={2} />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-remotiv-purple text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            aria-label="New batch"
            className="flex min-h-11 items-center gap-1 rounded-xl bg-remotiv-purple px-3 py-3 text-sm font-semibold text-white hover:opacity-90"
          >
            <Plus className="size-4" strokeWidth={2.5} />
            New
          </button>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total Batches" value={totalCount}    tint="text-gray-400" />
          <StatCard label="Active"        value={activeCount}   tint="text-green-600" />
          <StatCard label="Closed"        value={closedCount}   tint="text-blue-600" />
          <StatCard label="Archived"      value={archivedCount} tint="text-gray-500" />
        </div>

        <div className="mb-6 hidden flex-wrap gap-2 lg:flex">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterStatus(s)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                filterStatus === s
                  ? "bg-remotiv-purple text-white"
                  : "border border-gray-200 bg-white text-gray-500 hover:border-remotiv-purple/30 hover:text-gray-700"
              }`}
            >
              {STATUS_LABEL[s] ?? s}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
            <Briefcase className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-sm font-semibold text-gray-700">
              {batches.length === 0 ? "No batches yet" : "No batches match your filters"}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {batches.length === 0
                ? "Click \"New Batch\" to create the first pipeline."
                : "Try clearing a filter or broadening your search."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {filtered.map((b) => (
              <BatchCard key={b.id} batch={b} />
            ))}
          </div>
        )}
      </main>

      {/* Mobile filter bottom sheet */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 lg:hidden ${
          filterDrawerOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        onClick={() => setFilterDrawerOpen(false)}
        aria-hidden="true"
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          filterDrawerOpen ? "translate-y-0" : "translate-y-full"
        }`}
        aria-hidden={!filterDrawerOpen}
      >
        <div className="mb-6 flex items-center justify-between">
          <h3 className="font-heading text-lg font-bold text-[#111]">
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-2 rounded-full bg-remotiv-purple/10 px-2 py-0.5 text-xs font-semibold text-remotiv-purple">
                {activeFilterCount}
              </span>
            )}
          </h3>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(false)}
            aria-label="Close filters"
            className="flex size-11 items-center justify-center rounded-xl bg-gray-50 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        <div>
          <p className="mb-2 text-sm font-bold text-[#111]">Status</p>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((s) => {
              const active = filterStatus === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterStatus(s)}
                  className={`min-h-10 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-remotiv-purple text-white"
                      : "border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {STATUS_LABEL[s] ?? s}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-6">
          <button
            type="button"
            onClick={() => setFilterStatus("All")}
            disabled={activeFilterCount === 0}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-gray-200 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(false)}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            Apply
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateBatchModal
          activeClients={activeClients}
          defaultClientId={filterClientId}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
