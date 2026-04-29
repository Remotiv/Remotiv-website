"use client";

import { useState, useEffect } from "react";
import {
  Briefcase,
  CheckCircle,
  PauseCircle,
  XCircle,
  TrendingUp,
  TrendingDown,
  Plus,
  MoreHorizontal,
  X,
  AlertTriangle,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
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

// ── Constants ────────────────────────────────────────────────

const CATEGORIES = ["Engineering", "Design", "Sales", "Marketing", "Data", "Support"] as const;
const EXPERIENCE_LEVELS = ["Entry", "Intermediate", "Expert"] as const;
const CONTRACT_TYPES = ["Full time", "Part time", "Contract"] as const;
const WORK_TYPES = ["Remote", "On-site", "Hybrid"] as const;

const STATUS_META: Record<
  Job["status"],
  { label: string; badge: string; dot: string }
> = {
  open:    { label: "Open",    badge: "bg-[#49D7A7]/10 text-[#1a9e73]", dot: "bg-[#49D7A7]" },
  on_hold: { label: "On Hold", badge: "bg-amber-50 text-amber-600",      dot: "bg-amber-400"  },
  closed:  { label: "Closed",  badge: "bg-gray-100 text-gray-500",       dot: "bg-gray-400"   },
};

type StatCardDef = {
  label: string;
  value: number;
  trend: string;
  up: boolean;
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
  contract_type: "Full time",
  work_type: "Remote",
  category: "Engineering",
  experience_level: "Intermediate",
  language: "English",
  description: "",
  status: "open",
};

const INPUT_CLS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";
const LABEL_CLS =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400";

// ── Helpers ──────────────────────────────────────────────────

function fmtSalary(min: number | null, max: number | null): string {
  if (!min && !max) return "—";
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (min && max) {
    if (min === max) return `${fmt(min)}/yr`;
    return `${fmt(min)} – ${fmt(max)}/yr`;
  }
  if (min) return `From ${fmt(min)}/yr`;
  return `Up to ${fmt(max!)}/yr`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
  const [mutError, setMutError] = useState<string | null>(null);

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
      contract_type: job.contract_type,
      work_type: job.work_type,
      category: job.category,
      experience_level: job.experience_level,
      language: job.language,
      description: job.description ?? "",
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
    setMutating(true);
    setMutError(null);

    if (editingJob) {
      const result = await updateJob(editingJob.id, form);
      if (!result.success) { setMutError(result.error); setMutating(false); return; }
      setJobs((prev) => prev.map((j) => (j.id === editingJob.id ? result.data : j)));
    } else {
      const result = await createJob(form);
      if (!result.success) { setMutError(result.error); setMutating(false); return; }
      setJobs((prev) => [result.data, ...prev]);
    }

    setMutating(false);
    closeModal();
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
    setJobs((prev) => prev.filter((j) => j.id !== confirmDeleteId));
    setConfirmDeleteId(null);
    await deleteJob(confirmDeleteId);
  }

  // ── Derived stats ─────────────────────────────────────────
  const totalJobs    = jobs.length;
  const openCount    = jobs.filter((j) => j.status === "open").length;
  const onHoldCount  = jobs.filter((j) => j.status === "on_hold").length;
  const closedCount  = jobs.filter((j) => j.status === "closed").length;

  const updateDate = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });

  const STAT_CARDS: StatCardDef[] = [
    { label: "Total Jobs",  value: totalJobs,   trend: "+3",  up: true,  from: "#c084fc", to: "#7E47FF", icon: Briefcase   },
    { label: "Open",        value: openCount,   trend: "+2",  up: true,  from: "#6ee7c7", to: "#49D7A7", icon: CheckCircle },
    { label: "On Hold",     value: onHoldCount, trend: "—",   up: false, from: "#fdba74", to: "#f97316", icon: PauseCircle },
    { label: "Closed",      value: closedCount, trend: "+1",  up: false, from: "#93c5fd", to: "#3b82f6", icon: XCircle     },
  ];

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">
      <TopNav email={email} userRole={userRole} />

      <div className="p-5 lg:p-8">
        {/* Page header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-[#111]">Jobs</h1>
            <p className="mt-0.5 text-sm text-gray-400">Manage open positions</p>
          </div>
          {canEditJobs && (
            <button
              type="button"
              onClick={openAddModal}
              className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              Post Job
            </button>
          )}
        </div>

        {/* Stat cards */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {STAT_CARDS.map(({ label, value, trend, up, from, to, icon: Icon }) => (
            <div
              key={label}
              className="relative overflow-hidden rounded-2xl p-6 text-white"
              style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
            >
              <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
              <div className="pointer-events-none absolute -bottom-4 right-8 size-16 rounded-full bg-white/10" />
              <div className={`absolute right-4 top-4 flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold ${up ? "bg-white/20" : "bg-black/15"}`}>
                {up ? <TrendingUp className="size-3" strokeWidth={2.5} /> : <TrendingDown className="size-3" strokeWidth={2.5} />}
                {trend}
              </div>
              <Icon className="mb-4 size-7 opacity-90" strokeWidth={1.8} />
              <p className="font-heading text-[2.6rem] font-bold leading-none">{value}</p>
              <p className="mt-2 text-sm font-medium opacity-80">{label}</p>
              <p className="mt-3 text-[11px] opacity-50">Update: {updateDate}</p>
            </div>
          ))}
        </div>

        {/* Jobs table */}
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
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
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={canEditJobs || canDeleteJobs ? 9 : 8} className="px-6 py-12 text-center text-sm text-gray-400">
                      No jobs posted yet.{canEditJobs ? " Click \"Post Job\" to get started." : ""}
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => {
                    const meta = STATUS_META[job.status];
                    return (
                      <tr key={job.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                        <td className="px-6 py-4">
                          <p className="font-semibold text-[#111]">{job.title}</p>
                          <p className="text-xs text-gray-400">{job.experience_level}</p>
                        </td>
                        <td className="px-6 py-4">
                          <p className="text-gray-700">{job.company}</p>
                          <p className="text-xs text-gray-400">★ {job.company_rating}</p>
                        </td>
                        <td className="px-6 py-4 text-gray-500">{job.category}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-1.5 text-gray-500">
                            <MapPin className="size-3.5 shrink-0" strokeWidth={2} />
                            {job.location}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-gray-500">
                          {fmtSalary(job.salary_min, job.salary_max)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="w-fit rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                              {job.contract_type}
                            </span>
                            <span className="w-fit rounded-md bg-[#7E47FF]/10 px-2 py-0.5 text-[10px] font-medium text-[#7E47FF]">
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
        </div>
      </div>

      {/* ── Add / Edit modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-5">
              <h2 className="font-heading text-base font-bold text-[#111]">
                {editingJob ? "Edit Job" : "Post a Job"}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="flex size-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="flex flex-col gap-4">
                  {/* Title */}
                  <div>
                    <label className={LABEL_CLS} htmlFor="jb-title">Job Title</label>
                    <input id="jb-title" type="text" required placeholder="e.g. Senior React Developer" className={INPUT_CLS} value={form.title} onChange={(e) => set("title", e.target.value)} />
                  </div>

                  {/* Company + Rating */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className={LABEL_CLS} htmlFor="jb-company">Company</label>
                      <input id="jb-company" type="text" required placeholder="e.g. Cogent Labs" className={INPUT_CLS} value={form.company} onChange={(e) => set("company", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-rating">Rating</label>
                      <input id="jb-rating" type="number" min="0" max="5" step="0.1" placeholder="4.5" className={INPUT_CLS} value={form.company_rating} onChange={(e) => set("company_rating", e.target.value)} />
                    </div>
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
                      <label className={LABEL_CLS} htmlFor="jb-smin">Salary Min (USD)</label>
                      <input id="jb-smin" type="number" min="0" placeholder="e.g. 50000" className={INPUT_CLS} value={form.salary_min} onChange={(e) => set("salary_min", e.target.value)} />
                    </div>
                    <div>
                      <label className={LABEL_CLS} htmlFor="jb-smax">Salary Max (USD)</label>
                      <input id="jb-smax" type="number" min="0" placeholder="e.g. 80000" className={INPUT_CLS} value={form.salary_max} onChange={(e) => set("salary_max", e.target.value)} />
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

                  {mutError && (
                    <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-500">{mutError}</p>
                  )}
                </div>
              </div>

              <div className="shrink-0 border-t border-gray-100 px-6 py-4 flex items-center justify-end gap-3">
                <button type="button" onClick={closeModal} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit" disabled={mutating} className="rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0] disabled:cursor-not-allowed disabled:opacity-60">
                  {mutating ? "Saving…" : editingJob ? "Save Changes" : "Post Job"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete confirmation modal ── */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle className="size-5 text-red-500" strokeWidth={2} />
            </div>
            <h2 className="font-heading text-base font-bold text-[#111]">Delete Job?</h2>
            <p className="mt-2 text-sm text-gray-400">
              This will permanently remove this job posting and it will no longer appear on the public site.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button type="button" onClick={() => setConfirmDeleteId(null)} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50">
                Cancel
              </button>
              <button type="button" onClick={handleConfirmDelete} className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
