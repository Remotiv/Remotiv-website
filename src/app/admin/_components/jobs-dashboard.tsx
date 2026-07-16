"use client";

import { useEffect, useRef, useState } from "react";
import {
  Briefcase,
  CheckCircle,
  ChevronRight,
  PauseCircle,
  Star,
  XCircle,
  Plus,
  MoreHorizontal,
  SlidersHorizontal,
  X,
  AlertTriangle,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { JobOrderCell } from "./job-order-cell";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  createJob,
  updateJob,
  updateJobStatus,
  deleteJob,
  type Job,
  type JobInput,
} from "@/app/admin/jobs/actions";
import {
  type UserRole,
  canEdit,
  canDelete,
} from "@/app/admin/lib/roles";
import type { ScreeningQuestion } from "@/lib/jobs";
import { ScreeningQuestionBuilder } from "./screening-question-builder";

// ── Constants ────────────────────────────────────────────────

const CATEGORIES = ["Engineering", "Design", "Sales", "Marketing", "Data", "Support"] as const;
const EXPERIENCE_LEVELS = ["Entry", "Intermediate", "Expert"] as const;
const CONTRACT_TYPES = ["Full time", "Part time", "Contract"] as const;
const WORK_TYPES = ["Remote", "On-site", "Hybrid"] as const;

const STATUS_META: Record<
  Job["status"],
  { label: string; badge: string; dot: string }
> = {
  open:    { label: "Open",    badge: "bg-remotiv-green/10 text-[#1a9e73]", dot: "bg-remotiv-green" },
  on_hold: { label: "On Hold", badge: "bg-amber-50 text-amber-600",      dot: "bg-amber-400"  },
  closed:  { label: "Closed",  badge: "bg-gray-100 text-gray-500",       dot: "bg-gray-400"   },
};

type StatCardDef = {
  label: string;
  value: number;
  from: string;
  to: string;
  icon: LucideIcon;
};

const EMPTY_FORM: JobInput = {
  title: "",
  company: "",
  company_rating: "4.5",
  location: "",
  salary_min: "",
  salary_max: "",
  salary_currency: "",
  contract_type: "Full time",
  work_type: "Remote",
  category: "Engineering",
  experience_level: "Intermediate",
  language: "English",
  positions: "1",
  description: "",
  responsibilities: "",
  requirements: "",
  screening_questions: [] as ScreeningQuestion[],
  display_order: "",
  status: "open",
};

const INPUT_CLS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";
const LABEL_CLS =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400";

// ── Helpers ──────────────────────────────────────────────────

function fmtSalary(min: number | null, max: number | null, currency: string | null): string {
  if (!min && !max) return "—";
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (min && max) {
    if (min === max) return `${cur} ${fmt(min)}/mo`;
    return `${cur} ${fmt(min)} – ${fmt(max)}/mo`;
  }
  if (min) return `From ${cur} ${fmt(min)}/mo`;
  return `Up to ${cur} ${fmt(max!)}/mo`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Mobile card (replaces the desktop table on <lg) ──────────

/**
 * Compact job card for phone widths (375–414px).
 * Whole surface is one tappable button — opens the edit modal so the
 * three-dot menu actions (Put On Hold / Reopen / Close / Delete) live
 * inside that sheet on mobile.
 */
function JobCardMobile({
  job,
  onClick,
}: {
  job: Job;
  onClick: () => void;
}) {
  const meta = STATUS_META[job.status];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-base font-bold text-gray-900">
              {job.title}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {job.company} · {job.experience_level}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.badge}`}
          >
            {meta.label}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-remotiv-purple/10 px-2 py-0.5 text-[10px] font-medium text-remotiv-purple">
            {job.work_type}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {job.contract_type}
          </span>
          <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-500">
            {job.category}
          </span>
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-gray-500">
          <span className="flex items-center gap-1">
            <MapPin className="size-3" strokeWidth={2} />
            {job.location}
          </span>
          <span>Posted {timeAgo(job.created_at)}</span>
        </div>

        <p className="mt-1.5 text-xs font-semibold text-gray-700">
          {fmtSalary(job.salary_min, job.salary_max, job.salary_currency)}
        </p>
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-sm font-semibold text-remotiv-purple">
        View / Edit job
        <ChevronRight className="size-4" strokeWidth={2.5} />
      </div>
    </button>
  );
}

// ── Mobile filter bottom-sheet group ─────────────────────────

function FilterSheetGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-bold text-[#111]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`min-h-10 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-remotiv-purple text-white"
                  : "border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────

export function JobsDashboard({
  email,
  userRole = "viewer",
  initialJobs,
}: {
  email: string;
  userRole?: UserRole;
  initialJobs: Job[];
}) {
  const canEditJobs = canEdit(userRole);
  const canDeleteJobs = canDelete(userRole);

  const [jobs, setJobs] = useState<Job[]>(initialJobs);
  const [mutating, setMutating] = useState(false);
  // Belt-and-braces guard against double-clicks racing past the disabled
  // attribute — fast double-press would otherwise create two jobs.
  const inFlightRef = useRef(false);
  const [mutError, setMutError] = useState<string | null>(null);

  // Mobile-only UI state. Modal responsiveness is handled with Tailwind
  // `lg:` classes on the modal container — no JS branch needed.
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState<"all" | Job["status"]>("all");
  const [filterWorkType, setFilterWorkType] = useState<string>("all");

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

  function clearAllFilters() {
    setFilterStatus("all");
    setFilterWorkType("all");
  }

  const activeFilterCount =
    (filterStatus !== "all" ? 1 : 0) + (filterWorkType !== "all" ? 1 : 0);

  const filteredJobs = jobs.filter((j) => {
    if (filterStatus !== "all" && j.status !== filterStatus) return false;
    if (filterWorkType !== "all" && j.work_type !== filterWorkType) return false;
    return true;
  });

  // ── Three-dot menus ───────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (openMenuId === null) return;
    function close() { setOpenMenuId(null); }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenuId]);

  // ── Modal (add / edit) ────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [form, setForm] = useState<JobInput>(EMPTY_FORM);

  function openAddModal() {
    setEditingJob(null);
    setForm(EMPTY_FORM);
    setMutError(null);
    setShowModal(true);
  }

  function openEditModal(job: Job) {
    setEditingJob(job);
    setForm({
      title: job.title,
      company: job.company,
      company_rating: String(job.company_rating),
      location: job.location,
      salary_min: job.salary_min != null ? String(job.salary_min) : "",
      salary_max: job.salary_max != null ? String(job.salary_max) : "",
      salary_currency: job.salary_currency ?? "",
      contract_type: job.contract_type,
      work_type: job.work_type,
      category: job.category,
      experience_level: job.experience_level,
      language: job.language,
      positions: String(job.positions ?? 1),
      description: job.description ?? "",
      responsibilities: job.responsibilities ?? "",
      requirements: job.requirements ?? "",
      screening_questions: job.screening_questions ?? [],
      display_order: job.display_order != null ? String(job.display_order) : "",
      status: job.status,
    });
    setMutError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingJob(null);
    setForm(EMPTY_FORM);
    setMutError(null);
  }

  function set<K extends keyof JobInput>(key: K, value: JobInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setMutating(true);
    setMutError(null);

    try {
      if (editingJob) {
        const result = await updateJob(editingJob.id, form);
        if (!result.success) { setMutError(result.error); return; }
        setJobs((prev) => prev.map((j) => (j.id === editingJob.id ? result.data : j)));
      } else {
        const result = await createJob(form);
        if (!result.success) { setMutError(result.error); return; }
        setJobs((prev) => [result.data, ...prev]);
      }
      closeModal();
    } finally {
      inFlightRef.current = false;
      setMutating(false);
    }
  }

  // ── Status mutations ──────────────────────────────────────
  async function handleSetStatus(job: Job, status: Job["status"]) {
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status } : j)));
    await updateJobStatus(job.id, status);
  }

  // ── Delete ────────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    const targetId = confirmDeleteId;
    const snapshot = jobs;
    setJobs((prev) => prev.filter((j) => j.id !== targetId));
    setConfirmDeleteId(null);
    const result = await deleteJob(targetId);
    if (!result.success) {
      setJobs(snapshot);
      setMutError(result.error);
    }
  }

  // ── Derived stats ─────────────────────────────────────────
  const totalJobs    = jobs.length;
  const openCount    = jobs.filter((j) => j.status === "open").length;
  const onHoldCount  = jobs.filter((j) => j.status === "on_hold").length;
  const closedCount  = jobs.filter((j) => j.status === "closed").length;

  // Client-side pagination — see pagination-controls.tsx for rationale.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [filterStatus, filterWorkType]);
  const pageItems = paginate(filteredJobs, page);

  const updateDate = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });

  const STAT_CARDS: StatCardDef[] = [
    { label: "Total Jobs",  value: totalJobs,   from: "#c084fc", to: "#7E47FF", icon: Briefcase   },
    { label: "Open",        value: openCount,   from: "#6ee7c7", to: "#49D7A7", icon: CheckCircle },
    { label: "On Hold",     value: onHoldCount, from: "#fdba74", to: "#f97316", icon: PauseCircle },
    { label: "Closed",      value: closedCount, from: "#93c5fd", to: "#3b82f6", icon: XCircle     },
  ];

  return (
    <div className="min-h-full bg-remotiv-bg font-sans">
      <TopNav email={email} userRole={userRole} />

      <div className="p-4 lg:p-8">
        {/* Page header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-[#111]">Jobs</h1>
            <p className="mt-0.5 text-sm text-gray-400">Manage open positions</p>
          </div>
          {/* Desktop "Post Job" button — mobile uses the FAB instead */}
          {canEditJobs && (
            <button
              type="button"
              onClick={openAddModal}
              className="hidden items-center gap-2 rounded-xl bg-remotiv-purple px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0] lg:flex"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              New Job
            </button>
          )}
        </div>

        {/* Mobile filter trigger + inline "+ New" pill (backup for the FAB) */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <p className="flex-1 text-sm text-gray-500">
            {filteredJobs.length} of {jobs.length} jobs
          </p>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(true)}
            className="relative flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            <SlidersHorizontal className="size-4" strokeWidth={2} />
            Filters
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-remotiv-purple text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          {canEditJobs && (
            <button
              type="button"
              onClick={openAddModal}
              aria-label="Post a new job"
              className="flex min-h-11 items-center gap-1 rounded-xl bg-remotiv-purple px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              New
            </button>
          )}
        </div>

        {/* Stat cards */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-2 lg:gap-4 xl:grid-cols-4">
          {STAT_CARDS.map(({ label, value, from, to, icon: Icon }) => (
            <div
              key={label}
              className="relative overflow-hidden rounded-2xl p-4 text-white lg:p-6"
              style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
            >
              <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
              <div className="pointer-events-none absolute -bottom-4 right-8 size-16 rounded-full bg-white/10" />
              <Icon className="mb-3 size-6 opacity-90 lg:mb-4 lg:size-7" strokeWidth={1.8} />
              <p className="font-heading text-3xl font-bold leading-none lg:text-[2.6rem]">{value}</p>
              <p className="mt-1.5 text-xs font-medium opacity-80 lg:mt-2 lg:text-sm">{label}</p>
              <p className="mt-2 hidden text-[11px] opacity-50 lg:mt-3 lg:block">Update: {updateDate}</p>
            </div>
          ))}
        </div>

        {/* Mobile card list (replaces desktop table on <lg) */}
        <div className="lg:hidden">
          {filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
              <Briefcase className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
              <p className="font-heading text-sm font-semibold text-gray-700">No jobs match your filters</p>
              <p className="mt-1 text-xs text-gray-400">
                {canEditJobs ? "Tap the + button to post a job." : "Try clearing a filter."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {pageItems.map((job) => (
                  <JobCardMobile
                    key={job.id}
                    job={job}
                    onClick={() => (canEditJobs ? openEditModal(job) : undefined)}
                  />
                ))}
              </div>
              <div className="mt-6">
                <PaginationControls page={page} setPage={setPage} total={filteredJobs.length} />
              </div>
            </>
          )}
        </div>

        {/* Desktop table */}
        <div className="hidden rounded-2xl border border-gray-100 bg-white shadow-sm lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-6 py-3.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                    Order
                  </th>
                  {["Title", "Company", "Category", "Location", "Salary", "Type", "Status", "Posted"].map((h) => (
                    <th
                      key={h}
                      className="px-6 py-3.5 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                  {(canEditJobs || canDeleteJobs) && <th className="px-6 py-3.5" />}
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={canEditJobs || canDeleteJobs ? 10 : 9} className="px-6 py-12 text-center text-sm text-gray-400">
                      {jobs.length === 0
                        ? `No jobs posted yet.${canEditJobs ? " Click \"New Job\" to get started." : ""}`
                        : "No jobs match the current filters."}
                    </td>
                  </tr>
                ) : (
                  pageItems.map((job) => {
                    const meta = STATUS_META[job.status];
                    return (
                      <tr key={job.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                        <td className="px-6 py-4">
                          <JobOrderCell jobId={job.id} initial={job.display_order} />
                        </td>
                        <td className="px-6 py-4">
                          <p className="font-semibold text-[#111]">{job.title}</p>
                          <p className="text-xs text-gray-400">{job.experience_level}</p>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-gray-700">{job.company}</p>
                          <p className="flex items-center gap-1 text-xs text-gray-400">
                            <Star className="size-3 fill-amber-400 text-amber-400" strokeWidth={0} />
                            {job.company_rating}
                          </p>
                        </td>
                        <td className="px-6 py-4 text-gray-500">{job.category}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1.5 text-gray-500">
                            <MapPin className="size-3.5 shrink-0" strokeWidth={2} />
                            {job.location}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-gray-500">
                          {fmtSalary(job.salary_min, job.salary_max, job.salary_currency)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="w-fit rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                              {job.contract_type}
                            </span>
                            <span className="w-fit rounded-md bg-remotiv-purple/10 px-2 py-0.5 text-[10px] font-medium text-remotiv-purple">
                              {job.work_type}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${meta.badge}`}>
                            <span className={`size-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-400">
                          {timeAgo(job.created_at)}
                        </td>
                        {(canEditJobs || canDeleteJobs) && (
                          <td className="px-6 py-4">
                            <div className="relative">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenuId(openMenuId === job.id ? null : job.id);
                                }}
                                className="flex size-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                              >
                                <MoreHorizontal className="size-4" strokeWidth={2} />
                              </button>
                              {openMenuId === job.id && (
                                <div className="absolute right-0 top-9 z-20 w-36 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                                  {canEditJobs && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); openEditModal(job); }}
                                      className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                                    >
                                      Edit
                                    </button>
                                  )}
                                  {canEditJobs && job.status !== "on_hold" && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleSetStatus(job, "on_hold"); }}
                                      className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                                    >
                                      Put On Hold
                                    </button>
                                  )}
                                  {canEditJobs && job.status !== "open" && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleSetStatus(job, "open"); }}
                                      className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                                    >
                                      Reopen
                                    </button>
                                  )}
                                  {canEditJobs && job.status !== "closed" && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleSetStatus(job, "closed"); }}
                                      className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                                    >
                                      Close
                                    </button>
                                  )}
                                  {canDeleteJobs && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setConfirmDeleteId(job.id); }}
                                      className="w-full px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-red-50"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {filteredJobs.length > 0 && (
            <div className="border-t border-gray-100 px-6 py-4">
              <PaginationControls page={page} setPage={setPage} total={filteredJobs.length} />
            </div>
          )}
        </div>
      </div>

      {/* ── Add / Edit modal ── full-screen on mobile, centered card on desktop */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 lg:items-center lg:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="flex h-full w-full max-w-full flex-col overflow-hidden bg-white shadow-xl lg:h-auto lg:max-h-[92vh] lg:max-w-lg lg:rounded-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-4 lg:px-6 lg:py-5">
              <h2 className="font-heading text-base font-bold text-[#111]">
                {editingJob ? "Edit Job" : "Post a Job"}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="flex size-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 lg:size-8"
              >
                <X className="size-5 lg:size-4" strokeWidth={2} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto px-4 py-5 lg:px-6">
                <div className="flex flex-col gap-4">
                  {/* Title */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-title">Job Title</label>
                    <input id="jb-title" type="text" required placeholder="e.g. Senior React Developer" className={INPUT_CLS} value={form.title} onChange={(e) => set("title", e.target.value)} />
                  </div>

                  {/* Company + Rating + Positions */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-2">
                      <label className={LABEL_CLS} htmlFor="jb-company">Company</label>
                      <input id="jb-company" type="text" required placeholder="e.g. Cogent Labs" className={INPUT_CLS} value={form.company} onChange={(e) => set("company", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-rating">Rating</label>
                      <input id="jb-rating" type="number" min="0" max="5" step="0.1" placeholder="4.5" className={INPUT_CLS} value={form.company_rating} onChange={(e) => set("company_rating", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-positions">No. of Positions</label>
                      <input id="jb-positions" type="number" min="1" step="1" placeholder="1" className={INPUT_CLS} value={form.positions} onChange={(e) => set("positions", e.target.value)} />
                    </div>
                  </div>

                  {/* Display order */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-display-order">Display order (1 = first, blank = newest)</label>
                    <input id="jb-display-order" type="number" min="1" step="1" placeholder="Blank = newest" className={INPUT_CLS} value={form.display_order} onChange={(e) => set("display_order", e.target.value)} />
                  </div>

                  {/* Category + Experience */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-cat">Category</label>
                      <select id="jb-cat" className={INPUT_CLS} value={form.category} onChange={(e) => set("category", e.target.value)}>
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-exp">Experience</label>
                      <select id="jb-exp" className={INPUT_CLS} value={form.experience_level} onChange={(e) => set("experience_level", e.target.value)}>
                        {EXPERIENCE_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Location */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-loc">Location</label>
                    <input id="jb-loc" type="text" required placeholder="e.g. Remote" className={INPUT_CLS} value={form.location} onChange={(e) => set("location", e.target.value)} />
                  </div>

                  {/* Contract + Work type */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-contract">Contract Type</label>
                      <select id="jb-contract" className={INPUT_CLS} value={form.contract_type} onChange={(e) => set("contract_type", e.target.value)}>
                        {CONTRACT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-work">Work Type</label>
                      <select id="jb-work" className={INPUT_CLS} value={form.work_type} onChange={(e) => set("work_type", e.target.value)}>
                        {WORK_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Salary */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-smin">{`Salary Min${form.salary_currency ? ` (${form.salary_currency})` : ""}`}</label>
                      <input id="jb-smin" type="number" min="0" placeholder="e.g. 50000" className={INPUT_CLS} value={form.salary_min} onChange={(e) => set("salary_min", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-smax">{`Salary Max${form.salary_currency ? ` (${form.salary_currency})` : ""}`}</label>
                      <input id="jb-smax" type="number" min="0" placeholder="e.g. 80000" className={INPUT_CLS} value={form.salary_max} onChange={(e) => set("salary_max", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-salary-currency">Currency *</label>
                      <select id="jb-salary-currency" required className={INPUT_CLS} value={form.salary_currency} onChange={(e) => set("salary_currency", e.target.value)}>
                        <option value="">Select currency</option>
                        <option value="USD">USD</option>
                        <option value="PKR">PKR</option>
                      </select>
                    </div>
                  </div>

                  {/* Language + Status */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-lang">Language</label>
                      <input id="jb-lang" type="text" placeholder="English" className={INPUT_CLS} value={form.language} onChange={(e) => set("language", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-status">Status</label>
                      <select id="jb-status" className={INPUT_CLS} value={form.status} onChange={(e) => set("status", e.target.value)}>
                        <option value="open">Open</option>
                        <option value="on_hold">On Hold</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-desc">Description</label>
                    <textarea id="jb-desc" rows={4} placeholder="Describe the role, responsibilities, and requirements..." className={`${INPUT_CLS} resize-none`} value={form.description} onChange={(e) => set("description", e.target.value)} />
                  </div>

                  {/* What you'll do */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-responsibilities">What you'll do</label>
                    <textarea id="jb-responsibilities" rows={4} placeholder="One point per line — press Enter between points" className={`${INPUT_CLS} resize-none`} value={form.responsibilities} onChange={(e) => set("responsibilities", e.target.value)} />
                  </div>

                  {/* What we're looking for */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-requirements">What we're looking for</label>
                    <textarea id="jb-requirements" rows={4} placeholder="One point per line — press Enter between points" className={`${INPUT_CLS} resize-none`} value={form.requirements} onChange={(e) => set("requirements", e.target.value)} />
                  </div>

                  <ScreeningQuestionBuilder
                    value={form.screening_questions}
                    onChange={(qs) => set("screening_questions", qs)}
                  />

                  {mutError && (
                    <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-500">{mutError}</p>
                  )}
                </div>
              </div>

              <div className="shrink-0 border-t border-gray-100 px-4 py-3 flex items-center justify-end gap-3 lg:px-6 lg:py-4">
                <button type="button" onClick={closeModal} className="min-h-11 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={mutating} className="min-h-11 rounded-xl bg-remotiv-purple px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0] disabled:cursor-not-allowed disabled:opacity-60">
                  {mutating ? "Saving…" : editingJob ? "Save Changes" : "Create Job"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Mobile filter bottom sheet ── */}
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

        <div className="flex flex-col gap-5">
          <FilterSheetGroup
            label="Status"
            value={filterStatus}
            onChange={(v) => setFilterStatus(v as "all" | Job["status"])}
            options={[
              { value: "all",     label: "All" },
              { value: "open",    label: "Open" },
              { value: "on_hold", label: "On Hold" },
              { value: "closed",  label: "Closed" },
            ]}
          />
          <FilterSheetGroup
            label="Work Type"
            value={filterWorkType}
            onChange={setFilterWorkType}
            options={[
              { value: "all",     label: "All" },
              { value: "Remote",  label: "Remote" },
              { value: "On-site", label: "On-site" },
              { value: "Hybrid",  label: "Hybrid" },
            ]}
          />
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-6">
          <button
            type="button"
            onClick={clearAllFilters}
            disabled={activeFilterCount === 0}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-gray-200 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear all
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

      {/* ── Floating "Create Job" FAB — mobile only ──
          Gating intentionally minimal: when a modal opens its higher
          z-index covers the FAB, so we don't need to unmount it. The
          simpler condition also rules out any race where one of the
          `!showModal/!filterDrawerOpen/!confirmDeleteId` flags gets
          stuck and silently hides the button. */}
      {canEditJobs && (
        <button
          type="button"
          onClick={openAddModal}
          aria-label="Post a new job"
          className="fixed bottom-6 right-6 z-30 flex size-14 items-center justify-center rounded-full bg-remotiv-purple text-white shadow-2xl transition-all hover:bg-[#6a38e0] active:scale-95 lg:hidden"
        >
          <Plus className="size-7 text-white" strokeWidth={2.5} />
        </button>
      )}

      {/* ── Delete confirmation modal ── */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-job-title"
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
          >
            <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle className="size-5 text-red-500" strokeWidth={2} />
            </div>
            <h2 id="delete-job-title" className="font-heading text-base font-bold text-[#111]">Delete job?</h2>
            <p className="mt-2 text-sm text-gray-500">
              This permanently deletes the job. Any candidate applications for it are kept in Applications, with the job title preserved. This action cannot be undone.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button type="button" onClick={() => setConfirmDeleteId(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50">
                Cancel
              </button>
              <button type="button" onClick={handleConfirmDelete} className="rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
