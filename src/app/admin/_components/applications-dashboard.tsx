"use client";

import { useState, useEffect, useMemo } from "react";
import {
  FileText,
  Star,
  XCircle,
  HelpCircle,
  TrendingUp,
  MoreHorizontal,
  Download,
  ExternalLink,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Send,
  X,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import {
  updateApplicationStatus,
  addComment,
  deleteApplication,
  fetchComments,
  type JobApplication,
  type ApplicationStatus,
  type ApplicationComment,
} from "@/app/admin/applications/actions";
import { type UserRole, canDelete } from "@/app/admin/lib/roles";

// ── Constants ────────────────────────────────────────────────

type StatCardDef = {
  label: string;
  value: number;
  trend: string;
  up: boolean;
  from: string;
  to: string;
  icon: LucideIcon;
};

const STATUS_META: Record<
  ApplicationStatus,
  { label: string; badge: string; dot: string }
> = {
  new:         { label: "New",           badge: "bg-gray-100 text-gray-500",       dot: "bg-gray-400"   },
  shortlisted: { label: "Shortlisted",   badge: "bg-[#49D7A7]/10 text-[#1a9e73]", dot: "bg-[#49D7A7]" },
  not_a_fit:   { label: "Not a Good Fit", badge: "bg-red-50 text-red-500",         dot: "bg-red-400"    },
  maybe:       { label: "Maybe",          badge: "bg-amber-50 text-amber-600",      dot: "bg-amber-400"  },
};

const INPUT_CLS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

// ── Helpers ──────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Stat Card ────────────────────────────────────────────────

function StatCard({ card }: { card: StatCardDef }) {
  const Icon = card.icon;
  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${card.from} ${card.to} p-6 text-white`}
    >
      <div className="pointer-events-none absolute -right-4 -top-4 size-28 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -bottom-6 -right-6 size-36 rounded-full bg-white/10" />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-white/80">{card.label}</p>
          <p className="mt-1 text-4xl font-bold">{card.value}</p>
        </div>
        <div className="rounded-xl bg-white/20 p-2.5">
          <Icon className="size-5" strokeWidth={2} />
        </div>
      </div>
      <div className="relative mt-4 flex items-center gap-1.5">
        <TrendingUp className="size-3.5" strokeWidth={2} />
        <span className="text-xs font-medium text-white/90">{card.trend}</span>
      </div>
    </div>
  );
}

// ── Comments Panel ───────────────────────────────────────────

function CommentsPanel({
  application,
  authorName,
  onClose,
}: {
  application: JobApplication;
  authorName: string;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<ApplicationComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchComments(application.id).then((c) => {
      setComments(c);
      setLoading(false);
    });
  }, [application.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    const result = await addComment(application.id, text.trim(), authorName);
    if (result.success) {
      setComments((prev) => [...prev, result.data]);
      setText("");
    }
    setSubmitting(false);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
        <div>
          <p className="text-sm font-semibold text-gray-800">
            {application.first_name} {application.last_name}
          </p>
          <p className="text-xs text-gray-400">{application.email}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-center text-sm text-gray-400">Loading…</p>
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageSquare className="mb-3 size-8 text-gray-200" strokeWidth={1.5} />
            <p className="text-sm text-gray-400">No comments yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {comments.map((c) => (
              <div key={c.id} className="rounded-xl bg-gray-50 px-4 py-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-700">{c.author_name}</span>
                  <span className="text-[10px] text-gray-400">
                    {fmtDate(c.created_at)} · {fmtTime(c.created_at)}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-gray-600">{c.comment}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-gray-100 px-6 py-4">
        <textarea
          rows={3}
          placeholder="Write a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${INPUT_CLS} resize-none`}
        />
        <button
          type="submit"
          disabled={submitting || !text.trim()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#7E47FF] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send className="size-4" strokeWidth={2} />
          {submitting ? "Posting…" : "Post Comment"}
        </button>
      </form>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────

export function ApplicationsDashboard({
  email,
  userRole = "viewer",
  initialApplications,
}: {
  email: string;
  userRole?: UserRole;
  initialApplications: JobApplication[];
}) {
  const canDel = canDelete(userRole);

  const [apps, setApps] = useState<JobApplication[]>(initialApplications);
  const [toast, setToast] = useState<string | null>(null);

  // ── Menus ─────────────────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (openMenuId === null) return;
    function close() { setOpenMenuId(null); }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenuId]);

  // ── Toast ─────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Delete confirm ────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<JobApplication | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await deleteApplication(deleteTarget.id);
    if (result.success) {
      setApps((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    }
    setDeleting(false);
  }

  // ── Comments panel ────────────────────────────────────────
  const [commentTarget, setCommentTarget] = useState<JobApplication | null>(null);

  // ── Status update ─────────────────────────────────────────
  async function handleSetStatus(app: JobApplication, status: ApplicationStatus) {
    setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, status } : a)));
    await updateApplicationStatus(app.id, status);
  }

  // ── Filters ───────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [filterJob, setFilterJob] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  const jobRoles = useMemo(() => {
    const roles = new Set(apps.map((a) => a.job_title).filter(Boolean) as string[]);
    return Array.from(roles).sort();
  }, [apps]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return apps.filter((a) => {
      if (q) {
        const name = `${a.first_name} ${a.last_name}`.toLowerCase();
        if (!name.includes(q) && !a.email.toLowerCase().includes(q)) return false;
      }
      if (filterJob !== "all" && a.job_title !== filterJob) return false;
      if (filterStatus !== "all" && a.status !== filterStatus) return false;
      return true;
    });
  }, [apps, search, filterJob, filterStatus]);

  // ── Stats ─────────────────────────────────────────────────
  const totalApps     = apps.length;
  const shortlisted   = apps.filter((a) => a.status === "shortlisted").length;
  const notAFit       = apps.filter((a) => a.status === "not_a_fit").length;
  const maybe         = apps.filter((a) => a.status === "maybe").length;

  const statCards: StatCardDef[] = [
    {
      label: "Total Applications",
      value: totalApps,
      trend: "+12% this month",
      up: true,
      from: "from-[#7E47FF]",
      to: "to-[#9886fe]",
      icon: FileText,
    },
    {
      label: "Shortlisted",
      value: shortlisted,
      trend: "+8% this month",
      up: true,
      from: "from-[#49D7A7]",
      to: "to-[#3bc494]",
      icon: Star,
    },
    {
      label: "Not a Good Fit",
      value: notAFit,
      trend: "-5% this month",
      up: false,
      from: "from-[#F97316]",
      to: "to-[#FB923C]",
      icon: XCircle,
    },
    {
      label: "Maybe",
      value: maybe,
      trend: "+3% this month",
      up: true,
      from: "from-[#3B82F6]",
      to: "to-[#60A5FA]",
      icon: HelpCircle,
    },
  ];

  return (
    <div className="min-h-screen bg-[#f8f4f1]">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-xl px-8 py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-400">Applications</p>
          <h1 className="font-heading text-2xl font-bold text-gray-900">
            Applications
          </h1>
        </div>

        {/* Stat Cards */}
        <div className="mb-8 grid grid-cols-4 gap-5">
          {statCards.map((c) => (
            <StatCard key={c.label} card={c} />
          ))}
        </div>

        {/* Table Card */}
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-6 py-4">
            <input
              type="text"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-64 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none placeholder:text-gray-400 focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
            />
            <select
              value={filterJob}
              onChange={(e) => setFilterJob(e.target.value)}
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
            >
              <option value="all">All Job Roles</option>
              {jobRoles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
            >
              <option value="all">All Statuses</option>
              <option value="new">New</option>
              <option value="shortlisted">Shortlisted</option>
              <option value="not_a_fit">Not a Good Fit</option>
              <option value="maybe">Maybe</option>
            </select>
            <span className="ml-auto text-xs text-gray-400">
              {filtered.length} of {apps.length} applications
            </span>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Name</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Email</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Phone</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">LinkedIn</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Job Role</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">CV</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Status</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Applied</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-16 text-center text-sm text-gray-400">
                      No applications found
                    </td>
                  </tr>
                ) : (
                  filtered.map((app) => {
                    const meta = STATUS_META[app.status];
                    const menuOpen = openMenuId === app.id;

                    return (
                      <tr key={app.id} className="border-b border-gray-50 transition-colors hover:bg-gray-50/50">
                        <td className="px-6 py-4">
                          <span className="font-medium text-gray-800">
                            {app.first_name} {app.last_name}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-500">{app.email}</td>
                        <td className="px-6 py-4 text-gray-500">{app.phone}</td>
                        <td className="px-6 py-4">
                          <a
                            href={app.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-[#0A66C2]/10 px-2.5 py-1 text-xs font-medium text-[#0A66C2] transition-colors hover:bg-[#0A66C2]/20"
                          >
                            <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z" />
                                <circle cx="4" cy="4" r="2" />
                              </svg>
                            Profile
                          </a>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-gray-700">
                            {app.job_title ?? <span className="text-gray-300">—</span>}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <a
                              href={app.cv_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg bg-[#7E47FF]/10 px-2.5 py-1 text-xs font-medium text-[#7E47FF] transition-colors hover:bg-[#7E47FF]/20"
                            >
                              <ExternalLink className="size-3" strokeWidth={2} />
                              View
                            </a>
                            <a
                              href={app.cv_url}
                              download
                              className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200"
                            >
                              <Download className="size-3" strokeWidth={2} />
                              Download
                            </a>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
                            <span className={`size-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-400">{fmtDate(app.created_at)}</td>
                        <td className="px-6 py-4">
                          <div className="relative">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuId((p) => (p === app.id ? null : app.id));
                              }}
                              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                            >
                              <MoreHorizontal className="size-4" strokeWidth={2} />
                            </button>

                            {menuOpen && (
                              <div
                                className="absolute right-0 top-8 z-20 w-48 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => { handleSetStatus(app, "shortlisted"); setOpenMenuId(null); }}
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-green-50 hover:text-green-700"
                                >
                                  <span className="size-2 rounded-full bg-[#49D7A7]" />
                                  Shortlist
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { handleSetStatus(app, "not_a_fit"); setOpenMenuId(null); }}
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-red-50 hover:text-red-600"
                                >
                                  <span className="size-2 rounded-full bg-red-400" />
                                  Not a Good Fit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { handleSetStatus(app, "maybe"); setOpenMenuId(null); }}
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-amber-50 hover:text-amber-600"
                                >
                                  <span className="size-2 rounded-full bg-amber-400" />
                                  Maybe
                                </button>
                                <div className="border-t border-gray-100" />
                                <button
                                  type="button"
                                  onClick={() => { setToast("Coming soon!"); setOpenMenuId(null); }}
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50"
                                >
                                  Move to Talent
                                </button>
                                <button
                                  type="button"
                                  disabled
                                  className="flex w-full cursor-not-allowed items-center gap-2.5 px-4 py-2.5 text-sm text-gray-300"
                                >
                                  Move to Client
                                </button>
                                <div className="border-t border-gray-100" />
                                <button
                                  type="button"
                                  onClick={() => { setCommentTarget(app); setOpenMenuId(null); }}
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50"
                                >
                                  <MessageSquare className="size-3.5" strokeWidth={2} />
                                  Add Comment
                                </button>
                                {canDel && (
                                  <>
                                    <div className="border-t border-gray-100" />
                                    <button
                                      type="button"
                                      onClick={() => { setDeleteTarget(app); setOpenMenuId(null); }}
                                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-500 hover:bg-red-50"
                                    >
                                      <Trash2 className="size-3.5" strokeWidth={2} />
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* Comments Panel */}
      {commentTarget && (
        <div className="fixed inset-0 z-40 flex">
          <button
            type="button"
            className="flex-1 bg-black/20"
            onClick={() => setCommentTarget(null)}
            aria-label="Close comments panel"
          />
          <div className="flex h-full w-[420px] shrink-0 flex-col bg-white shadow-2xl">
            <div className="shrink-0 border-b border-gray-100 px-6 py-4">
              <p className="font-heading text-base font-semibold text-gray-900">Comments</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CommentsPanel
                application={commentTarget}
                authorName={email.split("@")[0] ?? "Admin"}
                onClose={() => setCommentTarget(null)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-red-50">
                <AlertTriangle className="size-7 text-red-500" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-gray-900">Delete Application?</h3>
              <p className="mt-2 text-sm text-gray-500">
                This will permanently delete the application from{" "}
                <span className="font-semibold text-gray-700">
                  {deleteTarget.first_name} {deleteTarget.last_name}
                </span>
                . This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
