"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
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
  UserCheck,
  Building2,
  Upload,
  CheckCircle,
  Loader2,
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
  type OpenJob,
} from "@/app/admin/applications/actions";
import { type UserRole, canDelete, canEdit } from "@/app/admin/lib/roles";

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
  new:         { label: "New",            badge: "bg-gray-100 text-gray-500",       dot: "bg-gray-400"   },
  shortlisted: { label: "Shortlisted",    badge: "bg-[#49D7A7]/10 text-[#1a9e73]", dot: "bg-[#49D7A7]"  },
  not_a_fit:   { label: "Not a Good Fit", badge: "bg-red-50 text-red-500",          dot: "bg-red-400"    },
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

// ── Slide-in Action + Comments Panel ─────────────────────────

function AppPanel({
  app,
  authorName,
  canDel,
  onClose,
  onSetStatus,
  onDelete,
  onToast,
}: {
  app: JobApplication;
  authorName: string;
  canDel: boolean;
  onClose: () => void;
  onSetStatus: (status: ApplicationStatus) => void;
  onDelete: () => void;
  onToast: (msg: string) => void;
}) {
  const [comments, setComments] = useState<ApplicationComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);

  // Animate in
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Load comments
  useEffect(() => {
    fetchComments(app.id).then((c) => {
      setComments(c);
      setLoadingComments(false);
    });
  }, [app.id]);

  function handleClose() {
    setVisible(false);
    setTimeout(onClose, 300);
  }

  async function handlePostComment(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    const result = await addComment(app.id, text.trim(), authorName);
    if (result.success) {
      setComments((prev) => [...prev, result.data]);
      setText("");
    }
    setSubmitting(false);
  }

  const actionBtn =
    "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors";

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Overlay */}
      <button
        type="button"
        aria-label="Close panel"
        onClick={handleClose}
        className="flex-1 bg-black/30 transition-opacity"
        style={{ opacity: visible ? 1 : 0 }}
      />

      {/* Panel */}
      <div
        className="flex h-full w-80 shrink-0 flex-col bg-white shadow-2xl transition-transform duration-300"
        style={{ transform: visible ? "translateX(0)" : "translateX(100%)" }}
      >
        {/* Panel header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <p className="font-heading text-sm font-semibold text-gray-900">
              {app.first_name} {app.last_name}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              {app.job_title ?? "No job linked"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="ml-2 shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Actions */}
          <div className="px-4 py-3">
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
              Actions
            </p>

            <button
              type="button"
              onClick={() => { onSetStatus("shortlisted"); handleClose(); }}
              className={`${actionBtn} text-green-700 hover:bg-green-50`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-green-100">
                <Star className="size-3.5 text-green-600" strokeWidth={2} />
              </span>
              Shortlist
            </button>

            <button
              type="button"
              onClick={() => { onSetStatus("not_a_fit"); handleClose(); }}
              className={`${actionBtn} text-red-600 hover:bg-red-50`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-red-100">
                <XCircle className="size-3.5 text-red-500" strokeWidth={2} />
              </span>
              Not a Good Fit
            </button>

            <button
              type="button"
              onClick={() => { onSetStatus("maybe"); handleClose(); }}
              className={`${actionBtn} text-amber-600 hover:bg-amber-50`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-amber-100">
                <HelpCircle className="size-3.5 text-amber-500" strokeWidth={2} />
              </span>
              Maybe
            </button>

            <div className="my-2 h-px bg-gray-100" />

            <button
              type="button"
              onClick={() => { onToast("Coming soon!"); handleClose(); }}
              className={`${actionBtn} text-[#7E47FF] hover:bg-[#7E47FF]/5`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-[#7E47FF]/10">
                <UserCheck className="size-3.5 text-[#7E47FF]" strokeWidth={2} />
              </span>
              Move to Talent
            </button>

            <button
              type="button"
              disabled
              className={`${actionBtn} cursor-not-allowed text-gray-300`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-gray-100">
                <Building2 className="size-3.5 text-gray-300" strokeWidth={2} />
              </span>
              Move to Client
            </button>

            <div className="my-2 h-px bg-gray-100" />

            <button
              type="button"
              onClick={() => setText("")}
              className={`${actionBtn} text-blue-600 hover:bg-blue-50`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-blue-100">
                <MessageSquare className="size-3.5 text-blue-500" strokeWidth={2} />
              </span>
              Add Comment
            </button>

            <button
              type="button"
              onClick={() => setText("")}
              className={`${actionBtn} text-blue-600 hover:bg-blue-50`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-blue-100">
                <FileText className="size-3.5 text-blue-500" strokeWidth={2} />
              </span>
              Other Comment
            </button>

            {canDel && (
              <>
                <div className="my-2 h-px bg-gray-100" />
                <button
                  type="button"
                  onClick={() => { onDelete(); handleClose(); }}
                  className={`${actionBtn} text-red-500 hover:bg-red-50`}
                >
                  <span className="flex size-7 items-center justify-center rounded-lg bg-red-100">
                    <Trash2 className="size-3.5 text-red-500" strokeWidth={2} />
                  </span>
                  Delete
                </button>
              </>
            )}
          </div>

          <div className="mx-4 h-px bg-gray-100" />

          {/* Comments */}
          <div className="px-4 py-3">
            <p className="mb-3 px-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
              Comments
            </p>

            {loadingComments ? (
              <p className="py-6 text-center text-xs text-gray-400">Loading…</p>
            ) : comments.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <MessageSquare className="mb-2 size-6 text-gray-200" strokeWidth={1.5} />
                <p className="text-xs text-gray-400">No comments yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {comments.map((c) => (
                  <div key={c.id} className="rounded-xl bg-gray-50 px-3.5 py-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-700">{c.author_name}</span>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        {fmtDate(c.created_at)} · {fmtTime(c.created_at)}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-gray-600">{c.comment}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Comment input — pinned to bottom */}
        <form onSubmit={handlePostComment} className="shrink-0 border-t border-gray-100 px-4 py-4">
          <textarea
            rows={3}
            placeholder="Write a comment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={`${INPUT_CLS} resize-none text-xs`}
          />
          <button
            type="submit"
            disabled={submitting || !text.trim()}
            className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#7E47FF] py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Send className="size-3.5" strokeWidth={2} />
            {submitting ? "Posting…" : "Post Comment"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────

export function ApplicationsDashboard({
  email,
  userRole = "viewer",
  initialApplications,
  openJobs,
}: {
  email: string;
  userRole?: UserRole;
  initialApplications: JobApplication[];
  openJobs: OpenJob[];
}) {
  const canDel = canDelete(userRole);
  const canUpload = canEdit(userRole);
  const router = useRouter();

  const [apps, setApps] = useState<JobApplication[]>(initialApplications);
  const [toast, setToast] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  // keep state in sync with server-refreshed props
  useEffect(() => {
    setApps(initialApplications);
  }, [initialApplications]);

  // ── Slide-in panel ────────────────────────────────────────
  const [panelApp, setPanelApp] = useState<JobApplication | null>(null);

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
  const totalApps   = apps.length;
  const shortlisted = apps.filter((a) => a.status === "shortlisted").length;
  const notAFit     = apps.filter((a) => a.status === "not_a_fit").length;
  const maybe       = apps.filter((a) => a.status === "maybe").length;

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
          <h1 className="font-heading text-2xl font-bold text-gray-900">Applications</h1>
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
            {canUpload && (
              <button
                type="button"
                onClick={() => setShowUpload(true)}
                className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Upload className="size-4" strokeWidth={2} />
                Upload CV
              </button>
            )}
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
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Source</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Status</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Applied</th>
                  <th className="px-6 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-16 text-center text-sm text-gray-400">
                      No applications found
                    </td>
                  </tr>
                ) : (
                  filtered.map((app) => {
                    const meta = STATUS_META[app.status];
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
                          {app.linkedin_url ? (
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
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-gray-700">
                          {app.job_title ?? <span className="text-gray-300">—</span>}
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
                          {app.source === "manual_upload" ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                              <span className="size-1.5 rounded-full bg-blue-500" />
                              Manual
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#49D7A7]/10 px-2.5 py-1 text-xs font-semibold text-[#1a9e73]">
                              <span className="size-1.5 rounded-full bg-[#49D7A7]" />
                              Job Post
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
                            <span className={`size-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-400">{fmtDate(app.created_at)}</td>
                        <td className="px-6 py-4">
                          <button
                            type="button"
                            onClick={() => setPanelApp(app)}
                            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                          >
                            <MoreHorizontal className="size-4" strokeWidth={2} />
                          </button>
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

      {/* Upload CV Modal */}
      {showUpload && (
        <UploadCVModal
          openJobs={openJobs}
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false);
            router.refresh();
          }}
        />
      )}

      {/* Slide-in Panel */}
      {panelApp && (
        <AppPanel
          app={panelApp}
          authorName={email.split("@")[0] ?? "Admin"}
          canDel={canDel}
          onClose={() => setPanelApp(null)}
          onSetStatus={(status) => handleSetStatus(panelApp, status)}
          onDelete={() => setDeleteTarget(panelApp)}
          onToast={setToast}
        />
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

// ── Upload CV Modal ──────────────────────────────────────────

type UploadStage = "upload" | "parsing" | "duplicate" | "review";

type ParsedCv = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
};

type DuplicateApplicant = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  status: ApplicationStatus;
  created_at: string;
  job_title: string | null;
};

const EMPTY_PARSED: ParsedCv = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  linkedin: "",
};

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // Worker via CDN — avoids bundler config for the worker file
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buffer }).promise;

  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null;
    let line = "";
    for (const item of content.items as Array<{ str: string; transform: number[] }>) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (line.trim()) lines.push(line.trim());
        line = item.str;
      } else {
        line += (line ? " " : "") + item.str;
      }
      lastY = y;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

function parseCvText(text: string): ParsedCv {
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const phoneMatch = text.match(/(\+?[\d\s\-().]{7,15})/);
  const linkedinMatch = text.match(/linkedin\.com\/in\/[\w-]+/i);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const nameParts = firstLine.split(/\s+/).filter(Boolean);

  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.slice(1).join(" ");

  return {
    firstName,
    lastName,
    email: emailMatch?.[0] ?? "",
    phone: phoneMatch?.[1]?.trim() ?? "",
    linkedin: linkedinMatch ? `https://${linkedinMatch[0]}` : "",
  };
}

function UploadCVModal({
  openJobs,
  onClose,
  onSuccess,
}: {
  openJobs: OpenJob[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [stage, setStage] = useState<UploadStage>("upload");
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCv>(EMPTY_PARSED);
  const [duplicate, setDuplicate] = useState<DuplicateApplicant | null>(null);
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    linkedin: "",
    jobChoice: "" as string,        // "" | jobId | "__other__"
    jobOther: "",
    notes: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Auto-close on success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(onSuccess, 2000);
    return () => clearTimeout(t);
  }, [success, onSuccess]);

  // Escape closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleFile(file: File | null) {
    if (!file) return;
    setError(null);
    if (file.type !== "application/pdf") {
      setError("Only PDF files are accepted.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("File must be under 5 MB.");
      return;
    }
    setCvFile(file);
    setStage("parsing");

    try {
      const [text, dupResp] = await Promise.all([
        extractPdfText(file),
        Promise.resolve(null), // placeholder — duplicate check runs after we have email/phone
      ]);
      void dupResp;
      const p = parseCvText(text);
      setParsed(p);
      setForm((prev) => ({
        ...prev,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        linkedin: p.linkedin,
      }));

      // Duplicate check
      const dupRes = await fetch("/api/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: p.email, phone: p.phone }),
      });
      const dupJson = await dupRes.json() as {
        exists?: boolean;
        applicant?: DuplicateApplicant | null;
        error?: string;
      };

      if (dupJson.exists && dupJson.applicant) {
        setDuplicate(dupJson.applicant);
        setStage("duplicate");
      } else {
        setStage("review");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read CV.");
      setStage("upload");
      setCvFile(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cvFile) return;
    if (!form.firstName || !form.lastName || !form.email || !form.phone) {
      setError("First name, last name, email, and phone are required.");
      return;
    }
    if (!form.jobChoice) {
      setError("Please select or type a job role.");
      return;
    }
    if (form.jobChoice === "__other__" && !form.jobOther.trim()) {
      setError("Please type the job role.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const fd = new FormData();
      if (form.jobChoice === "__other__") {
        fd.append("job_title_manual", form.jobOther.trim());
      } else {
        fd.append("job_id", form.jobChoice);
      }
      fd.append("first_name",   form.firstName);
      fd.append("last_name",    form.lastName);
      fd.append("email",        form.email);
      fd.append("phone",        form.phone);
      if (form.linkedin.trim()) fd.append("linkedin_url", form.linkedin.trim());
      if (form.notes.trim())    fd.append("notes",        form.notes.trim());
      fd.append("source", "manual_upload");
      fd.append("cv", cvFile);

      const res = await fetch("/api/apply", { method: "POST", body: fd });
      const json = await res.json() as { success?: boolean; error?: string };

      if (!res.ok || json.error) throw new Error(json.error ?? "Submission failed.");

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  function setField<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const INPUT_CLS_LOCAL =
    "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";
  const LABEL_CLS_LOCAL =
    "mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400";

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div className="relative mx-auto my-12 flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="relative shrink-0 rounded-t-2xl bg-[#7E47FF] px-7 py-6 pr-16">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-6 flex size-9 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <p className="font-heading text-xl font-bold text-white">Manual CV Upload</p>
          <p className="mt-0.5 text-sm text-white/70">
            {stage === "upload"    && "Drop a CV PDF to get started"}
            {stage === "parsing"   && "Reading CV…"}
            {stage === "duplicate" && "Possible duplicate found"}
            {stage === "review"    && "Review and submit"}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 px-7 py-6">
          {success ? (
            <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
              <div className="flex size-16 items-center justify-center rounded-full bg-[#49D7A7]/15">
                <CheckCircle className="size-8 text-[#49D7A7]" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-gray-900">
                Applicant added successfully!
              </h3>
              <p className="text-sm text-gray-500">This window will close automatically.</p>
            </div>
          ) : stage === "upload" ? (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  void handleFile(e.dataTransfer.files?.[0] ?? null);
                }}
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 transition-colors ${
                  dragOver
                    ? "border-[#7E47FF] bg-[#7E47FF]/5"
                    : "border-gray-200 bg-gray-50 hover:border-[#7E47FF]/40"
                }`}
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-[#7E47FF]/10">
                  <Upload className="size-5 text-[#7E47FF]" strokeWidth={2} />
                </div>
                <p className="font-heading text-sm font-semibold text-gray-800">
                  Drop CV here or click to browse
                </p>
                <p className="text-xs text-gray-400">PDF only · max 5 MB</p>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              {error && (
                <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
              )}
            </>
          ) : stage === "parsing" ? (
            <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
              <Loader2 className="size-10 animate-spin text-[#7E47FF]" strokeWidth={2} />
              <p className="font-heading text-sm font-semibold text-gray-800">Reading CV…</p>
              <p className="text-xs text-gray-400">Extracting contact details and checking for duplicates</p>
            </div>
          ) : stage === "duplicate" && duplicate ? (
            <div className="flex flex-col gap-5">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle className="size-5 text-amber-600" strokeWidth={2} />
                  <p className="font-heading text-sm font-bold text-amber-800">
                    This applicant may already exist
                  </p>
                </div>
                <div className="space-y-2 text-sm text-amber-900">
                  <p><span className="font-semibold">Name:</span> {duplicate.first_name} {duplicate.last_name}</p>
                  <p><span className="font-semibold">Email:</span> {duplicate.email}</p>
                  <p><span className="font-semibold">Phone:</span> {duplicate.phone}</p>
                  <p><span className="font-semibold">Job Role:</span> {duplicate.job_title ?? "—"}</p>
                  <p><span className="font-semibold">Date Applied:</span> {fmtDate(duplicate.created_at)}</p>
                  <p className="flex items-center gap-2">
                    <span className="font-semibold">Status:</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_META[duplicate.status].badge}`}>
                      <span className={`size-1.5 rounded-full ${STATUS_META[duplicate.status].dot}`} />
                      {STATUS_META[duplicate.status].label}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  View Existing
                </button>
                <button
                  type="button"
                  onClick={() => { setDuplicateAccepted(true); setStage("review"); }}
                  className="flex-1 rounded-xl bg-[#7E47FF] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Continue Anyway
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {duplicateAccepted && (
                <div className="mb-5 flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={2} />
                  <p className="text-xs leading-relaxed text-amber-800">
                    Similar applicant found — verify this is a different application.
                  </p>
                </div>
              )}

              <div className="mb-4 flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                  <span className="size-1.5 rounded-full bg-blue-500" />
                  Manual Upload
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={LABEL_CLS_LOCAL}>First Name</label>
                  <input
                    required
                    type="text"
                    value={form.firstName}
                    onChange={(e) => setField("firstName", e.target.value)}
                    className={INPUT_CLS_LOCAL}
                  />
                </div>
                <div>
                  <label className={LABEL_CLS_LOCAL}>Last Name</label>
                  <input
                    required
                    type="text"
                    value={form.lastName}
                    onChange={(e) => setField("lastName", e.target.value)}
                    className={INPUT_CLS_LOCAL}
                  />
                </div>
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS_LOCAL}>Email</label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setField("email", e.target.value)}
                  className={INPUT_CLS_LOCAL}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS_LOCAL}>Phone Number</label>
                <input
                  required
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setField("phone", e.target.value)}
                  className={INPUT_CLS_LOCAL}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS_LOCAL}>LinkedIn URL <span className="text-gray-300 normal-case">(optional)</span></label>
                <input
                  type="url"
                  value={form.linkedin}
                  placeholder={parsed.linkedin ? "" : "Not found in CV"}
                  onChange={(e) => setField("linkedin", e.target.value)}
                  className={INPUT_CLS_LOCAL}
                />
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS_LOCAL}>Job Role</label>
                <select
                  required
                  value={form.jobChoice}
                  onChange={(e) => setField("jobChoice", e.target.value)}
                  className={INPUT_CLS_LOCAL}
                >
                  <option value="">Select job role…</option>
                  {openJobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.title}</option>
                  ))}
                  <option value="__other__">Other (type manually)</option>
                </select>
                {form.jobChoice === "__other__" && (
                  <input
                    type="text"
                    placeholder="Type the job title…"
                    value={form.jobOther}
                    onChange={(e) => setField("jobOther", e.target.value)}
                    className={`${INPUT_CLS_LOCAL} mt-2`}
                  />
                )}
              </div>

              <div className="mt-4">
                <label className={LABEL_CLS_LOCAL}>Notes <span className="text-gray-300 normal-case">(optional)</span></label>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setField("notes", e.target.value)}
                  className={`${INPUT_CLS_LOCAL} resize-none`}
                />
              </div>

              {cvFile && (
                <p className="mt-4 truncate text-xs text-gray-400">
                  CV: <span className="font-medium text-gray-600">{cvFile.name}</span>
                </p>
              )}

              {error && (
                <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 w-full rounded-xl bg-gray-900 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Add Applicant"}
              </button>

              <button
                type="button"
                onClick={() => { setStage("upload"); setCvFile(null); setDuplicateAccepted(false); setDuplicate(null); }}
                className="mt-2 w-full py-2 text-xs font-medium text-gray-400 transition-colors hover:text-gray-600"
              >
                ← Back
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
