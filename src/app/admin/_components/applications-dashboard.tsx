"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Star,
  XCircle,
  HelpCircle,
  MoreHorizontal,
  Download,
  ExternalLink,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Clock,
  Search as SearchIcon,
  Send,
  SlidersHorizontal,
  ChevronRight,
  X,
  UserCheck,
  Building2,
  Upload,
  CheckCircle,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import dynamic from "next/dynamic";
import type { AddToBatchSnapshot } from "./add-to-batch-modal";

// Both modals are click-to-open — defer their JS until the user actually
// triggers them. AddToBatchModal pulls a candidate-search subtree;
// MoveToTalentModal is the talent-profile mapping form.
const MoveToTalentModal = dynamic(
  () => import("./move-to-talent-modal").then((m) => ({ default: m.MoveToTalentModal })),
  { ssr: false },
);
const AddToBatchModal = dynamic(
  () => import("./add-to-batch-modal").then((m) => ({ default: m.AddToBatchModal })),
  { ssr: false },
);
import { PaginationControls, paginate } from "./pagination-controls";
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
import { isValidEmail } from "@/app/admin/lib/validators";
import {
  EditableCell,
  extractPdfText,
  isValidLinkedInUrl,
  parseCvText,
  type ParsedCv,
} from "./bulk-upload-shared";

// ── Constants ────────────────────────────────────────────────

type StatCardDef = {
  label: string;
  value: number;
  from: string;
  to: string;
  icon: LucideIcon;
};

const STATUS_META: Record<
  ApplicationStatus,
  { label: string; badge: string; dot: string }
> = {
  new:         { label: "New",            badge: "bg-gray-100 text-gray-500",       dot: "bg-gray-400"   },
  shortlisted: { label: "Shortlisted",    badge: "bg-remotiv-green/10 text-[#1a9e73]", dot: "bg-remotiv-green"  },
  not_a_fit:   { label: "Not a Good Fit", badge: "bg-red-50 text-red-500",          dot: "bg-red-400"    },
  maybe:       { label: "Maybe",          badge: "bg-amber-50 text-amber-600",      dot: "bg-amber-400"  },
};

const INPUT_CLS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";

// LinkedIn URL validity, PDF extraction and parsing all live in
// bulk-upload-shared.tsx so the batch-detail bulk modal can reuse them.

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
  onMoveToTalent,
  onAddToBatch,
  onDelete,
  onToast,
}: {
  app: JobApplication;
  authorName: string;
  canDel: boolean;
  onClose: () => void;
  onSetStatus: (status: ApplicationStatus) => void;
  onMoveToTalent: () => void;
  onAddToBatch: () => void;
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
      {/* Overlay — desktop only. On mobile the panel covers the full viewport
          so a separate dim layer would be invisible. */}
      <button
        type="button"
        aria-label="Close panel"
        onClick={handleClose}
        className="hidden flex-1 bg-black/30 transition-opacity lg:block"
        style={{ opacity: visible ? 1 : 0 }}
      />

      {/* Panel — full-width on mobile, 320px side drawer on desktop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Application details"
        className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl transition-transform duration-300 lg:w-80"
        style={{ transform: visible ? "translateX(0)" : "translateX(100%)" }}
      >
        {/* Panel header */}
        <div className="flex items-start justify-between border-b border-gray-100 px-4 py-4 lg:px-5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-sm font-semibold text-gray-900">
              {app.first_name} {app.last_name}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-400">
              {app.job_title ?? "No job linked"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="ml-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:size-8 lg:p-1.5"
          >
            <X className="size-5 lg:size-4" strokeWidth={2} />
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
              onClick={() => { onAddToBatch(); handleClose(); }}
              className={`${actionBtn} text-remotiv-purple hover:bg-remotiv-purple/5`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-remotiv-purple/10">
                <Send className="size-3.5 text-remotiv-purple" strokeWidth={2} />
              </span>
              Add to Client Batch
            </button>

            <button
              type="button"
              onClick={() => { onMoveToTalent(); handleClose(); }}
              className={`${actionBtn} text-remotiv-purple hover:bg-remotiv-purple/5`}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-remotiv-purple/10">
                <UserCheck className="size-3.5 text-remotiv-purple" strokeWidth={2} />
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
            className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-remotiv-purple py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Send className="size-3.5" strokeWidth={2} />
            {submitting ? "Posting…" : "Post Comment"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Mobile card (replaces the desktop table on <lg) ──────────

const STATUS_DOT: Record<ApplicationStatus, string> = {
  new:         "bg-gray-100 text-gray-500",
  shortlisted: "bg-remotiv-green/10 text-[#1a9e73]",
  not_a_fit:   "bg-red-50 text-red-500",
  maybe:       "bg-amber-50 text-amber-600",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(diffMs / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function appInitials(first: string, last: string): string {
  const f = first?.[0] ?? "";
  const l = last?.[0] ?? "";
  return (f + l).toUpperCase() || "?";
}

/**
 * Compact application card for phone widths (375–414px).
 * Renders only on `<lg`; the desktop table is hidden on mobile.
 * Whole surface is one tappable button — actions live inside the
 * full-screen detail panel so the row stays a single touch target.
 */
function ApplicationCardMobile({
  app,
  onView,
}: {
  app: JobApplication;
  onView: () => void;
}) {
  const meta = STATUS_META[app.status];
  return (
    <button
      type="button"
      onClick={onView}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-remotiv-purple/10 font-heading text-xs font-bold text-remotiv-purple">
            {appInitials(app.first_name, app.last_name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-heading text-base font-bold text-gray-900">
                {app.first_name} {app.last_name}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_DOT[app.status]}`}
              >
                {meta.label}
              </span>
            </div>
            <p className="mt-0.5 truncate text-sm font-semibold text-remotiv-purple">
              {app.job_title || "No job linked"}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-400">{app.email}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {app.source === "manual_upload" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600">
              <span className="size-1.5 rounded-full bg-blue-500" />
              Manual upload
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-remotiv-green/10 px-2 py-0.5 text-[10px] font-semibold text-[#1a9e73]">
              <span className="size-1.5 rounded-full bg-remotiv-green" />
              Job post
            </span>
          )}
          {app.linkedin_url && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#0A66C2]/10 px-2 py-0.5 text-[10px] font-semibold text-[#0A66C2]">
              LinkedIn
            </span>
          )}
          {app.cv_url && (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
              <FileText className="size-2.5" strokeWidth={2.5} />
              CV
            </span>
          )}
        </div>

        <p className="mt-3 text-[11px] text-gray-400">
          Applied {relativeTime(app.created_at)}
        </p>
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-sm font-semibold text-remotiv-purple">
        View application
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

export function ApplicationsDashboard({
  email,
  userRole = "viewer",
  initialApplications,
  openJobs,
  initialSearch = "",
}: {
  email: string;
  userRole?: UserRole;
  initialApplications: JobApplication[];
  openJobs: OpenJob[];
  initialSearch?: string;
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

  // ── Move-to-Talent modal ──────────────────────────────────
  const [moveTarget, setMoveTarget] = useState<JobApplication | null>(null);

  // ── Add-to-Batch modal ────────────────────────────────────
  const [addToBatchTarget, setAddToBatchTarget] = useState<JobApplication | null>(null);

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
  // Pre-populate from `?search=` URL param when navigated from the Smart Search page.
  const [search, setSearch] = useState(initialSearch);
  const [filterJob, setFilterJob] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  // Mobile-only UI state. Detail panel responsiveness is handled with
  // Tailwind `lg:` classes inside AppPanel — no JS branch needed.
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

  function clearAllFilters() {
    setFilterJob("all");
    setFilterStatus("all");
  }

  const activeFilterCount =
    (filterJob !== "all" ? 1 : 0) + (filterStatus !== "all" ? 1 : 0);

  // Lower-cased query the row highlight uses to flag matching rows.
  const searchLower = search.trim().toLowerCase();

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

  // Client-side pagination — see pagination-controls.tsx for rationale.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [search, filterJob, filterStatus]);
  const pageItems = paginate(filtered, page);

  // ── Stats ─────────────────────────────────────────────────
  const totalApps   = apps.length;
  const shortlisted = apps.filter((a) => a.status === "shortlisted").length;
  const notAFit     = apps.filter((a) => a.status === "not_a_fit").length;
  const maybe       = apps.filter((a) => a.status === "maybe").length;

  const statCards: StatCardDef[] = [
    {
      label: "Total Applications",
      value: totalApps,
      from: "from-remotiv-purple",
      to: "to-remotiv-purple-light",
      icon: FileText,
    },
    {
      label: "Shortlisted",
      value: shortlisted,
      from: "from-remotiv-green",
      to: "to-remotiv-green-light",
      icon: Star,
    },
    {
      label: "Not a Good Fit",
      value: notAFit,
      from: "from-[#F97316]",
      to: "to-[#FB923C]",
      icon: XCircle,
    },
    {
      label: "Maybe",
      value: maybe,
      from: "from-[#3B82F6]",
      to: "to-[#60A5FA]",
      icon: HelpCircle,
    },
  ];

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-gray-400">Applications</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">Applications</h1>
            <p className="mt-1 text-sm text-gray-500 lg:hidden">
              {filtered.length} of {apps.length} applications
            </p>
          </div>
          {canUpload && (
            <button
              type="button"
              onClick={() => setShowUpload(true)}
              aria-label="Upload CV"
              className="flex min-h-11 items-center gap-2 rounded-xl bg-remotiv-purple px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 lg:hidden"
            >
              <Upload className="size-4" strokeWidth={2} />
              Upload
            </button>
          )}
        </div>

        {/* Mobile search + filter trigger */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <div className="relative flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="search"
              aria-label="Search"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-10 pr-4 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-remotiv-purple/40 focus:ring-2 focus:ring-remotiv-purple/20"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(true)}
            className="relative flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            <SlidersHorizontal className="size-4" strokeWidth={2} />
            Filters
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-remotiv-purple text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Stat Cards — 2-col on phones, 4-col on desktop */}
        <div className="mb-6 grid grid-cols-2 gap-3 lg:mb-8 lg:grid-cols-4 lg:gap-5">
          {statCards.map((c) => (
            <StatCard key={c.label} card={c} />
          ))}
        </div>

        {/* Mobile card list (replaces desktop table on <lg) */}
        <div className="lg:hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
              <FileText className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
              <p className="font-heading text-sm font-semibold text-gray-700">No applications found</p>
              <p className="mt-1 text-xs text-gray-400">Try clearing a filter or broadening your search.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {pageItems.map((app) => (
                  <ApplicationCardMobile
                    key={app.id}
                    app={app}
                    onView={() => setPanelApp(app)}
                  />
                ))}
              </div>
              <div className="mt-6">
                <PaginationControls page={page} setPage={setPage} total={filtered.length} />
              </div>
            </>
          )}
        </div>

        {/* Desktop table card */}
        <div className="hidden overflow-hidden rounded-2xl bg-white shadow-sm lg:block">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 px-6 py-4">
            <input
              type="search"
              aria-label="Search"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-64 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none placeholder:text-gray-400 focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
            />
            <select
              value={filterJob}
              onChange={(e) => setFilterJob(e.target.value)}
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
            >
              <option value="all">All Job Roles</option>
              {jobRoles.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 outline-none focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
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
                className="flex items-center gap-2 rounded-xl bg-remotiv-purple px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
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
                  pageItems.map((app) => {
                    const meta = STATUS_META[app.status];
                    const isHighlighted =
                      searchLower.length > 0 &&
                      (
                        `${app.first_name} ${app.last_name}`.toLowerCase().includes(searchLower) ||
                        (app.email ?? "").toLowerCase().includes(searchLower)
                      );
                    return (
                      <tr
                        key={app.id}
                        className={`border-b border-gray-50 transition-colors hover:bg-gray-50/50 ${
                          isHighlighted
                            ? "bg-remotiv-purple/5 outline outline-2 -outline-offset-2 outline-remotiv-purple/40"
                            : ""
                        }`}
                      >
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
                              className="inline-flex items-center gap-1 rounded-lg bg-remotiv-purple/10 px-2.5 py-1 text-xs font-medium text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
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
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-remotiv-green/10 px-2.5 py-1 text-xs font-semibold text-[#1a9e73]">
                              <span className="size-1.5 rounded-full bg-remotiv-green" />
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
          {filtered.length > 0 && (
            <div className="border-t border-gray-100 px-6 py-4">
              <PaginationControls page={page} setPage={setPage} total={filtered.length} />
            </div>
          )}
        </div>
      </main>

      {/* Mobile filter bottom sheet — slides up from bottom on <lg */}
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
            onChange={setFilterStatus}
            options={[
              { value: "all",         label: "All" },
              { value: "new",         label: "New" },
              { value: "shortlisted", label: "Shortlisted" },
              { value: "maybe",       label: "Maybe" },
              { value: "not_a_fit",   label: "Not a Good Fit" },
            ]}
          />
          <FilterSheetGroup
            label="Job Role"
            value={filterJob}
            onChange={setFilterJob}
            options={[
              { value: "all", label: "All roles" },
              ...jobRoles.map((r) => ({ value: r, label: r })),
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

      {/* Bulk Upload CV Modal */}
      {showUpload && (
        <BulkUploadCVModal
          openJobs={openJobs}
          onClose={() => setShowUpload(false)}
          onComplete={(msg) => {
            setShowUpload(false);
            setToast(msg);
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
          onMoveToTalent={() => setMoveTarget(panelApp)}
          onAddToBatch={() => setAddToBatchTarget(panelApp)}
          onDelete={() => setDeleteTarget(panelApp)}
          onToast={setToast}
        />
      )}

      {/* Move-to-Talent Modal */}
      {moveTarget && (
        <MoveToTalentModal
          app={moveTarget}
          onClose={() => setMoveTarget(null)}
          onSuccess={(msg) => {
            setMoveTarget(null);
            setPanelApp(null);
            setToast(msg);
            router.refresh();
          }}
        />
      )}

      {/* Add-to-Batch Modal */}
      {addToBatchTarget && (() => {
        const a = addToBatchTarget;
        const snapshot: AddToBatchSnapshot & { full_name: string } = {
          source_type: "application",
          source_id: a.id,
          first_name: a.first_name,
          last_name: a.last_name,
          email: a.email,
          phone: a.phone ?? null,
          linkedin_url: a.linkedin_url ?? null,
          cv_url: a.cv_url ?? null,
          location: null,
          university: null,
          position_applied: a.job_title ?? null,
          total_experience: null,
          current_role: null,
          current_company: null,
          current_salary: null,
          salary_expectations: null,
          notice_period: null,
          full_name: `${a.first_name} ${a.last_name}`.trim(),
        };
        return (
          <AddToBatchModal
            candidate={snapshot}
            onClose={() => setAddToBatchTarget(null)}
            onToast={(msg) => {
              setAddToBatchTarget(null);
              setPanelApp(null);
              setToast(msg);
              router.refresh();
            }}
          />
        );
      })()}

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
// extractPdfText / parseCvText / ParsedCv → bulk-upload-shared.tsx

// ── Bulk Upload CV Modal ─────────────────────────────────────

type BulkStage = "upload" | "processing" | "review";

type RowStatus = "ready" | "submitting" | "done" | "error" | "skipped";

type BulkRow = {
  id: string;
  file: File;
  filename: string;
  selected: boolean;
  // Editable parsed fields
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
  // Raw cleaned CV text — saved server-side for full-text search
  cvText: string;
  // Job choice
  jobChoice: string;   // "" | jobId | "__other__"
  jobOther: string;
  // Duplicate
  duplicate: DuplicateApplicant | null;
  // Submit state
  status: RowStatus;
  errorMsg: string | null;
};

const MAX_BULK = 50;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

function uid(): string {
  return Math.random().toString(36).slice(2, 11);
}

// EditableCell → bulk-upload-shared.tsx (imported above)

function BulkUploadCVModal({
  openJobs,
  onClose,
  onComplete,
}: {
  openJobs: OpenJob[];
  onClose: () => void;
  onComplete: (msg: string) => void;
}) {
  const [stage, setStage] = useState<BulkStage>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Processing progress
  const [processedCount, setProcessedCount] = useState(0);

  // Review rows
  const [rows, setRows] = useState<BulkRow[]>([]);

  // Submitting
  const [submitting, setSubmitting] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [submitTotal, setSubmitTotal] = useState(0);

  // Escape closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  function addFiles(picked: FileList | File[] | null) {
    if (!picked) return;
    setError(null);
    const incoming = Array.from(picked);

    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (f.type !== "application/pdf") {
        rejected.push(`${f.name}: not a PDF`);
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        rejected.push(`${f.name}: over 5 MB`);
        continue;
      }
      accepted.push(f);
    }

    setFiles((prev) => {
      const combined = [...prev, ...accepted];
      if (combined.length > MAX_BULK) {
        setError(`Maximum ${MAX_BULK} CVs allowed. Trimmed to first ${MAX_BULK}.`);
        return combined.slice(0, MAX_BULK);
      }
      return combined;
    });

    if (rejected.length > 0) {
      setError((prev) => {
        const prefix = prev ? `${prev}\n` : "";
        return `${prefix}${rejected.length} file(s) skipped: ${rejected.slice(0, 3).join("; ")}${rejected.length > 3 ? "…" : ""}`;
      });
    }
  }

  async function processFiles() {
    if (files.length === 0) return;
    setStage("processing");
    setProcessedCount(0);

    const built: BulkRow[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await extractPdfText(file);
        const parsed = parseCvText(text);

        // Duplicate check
        let duplicate: DuplicateApplicant | null = null;
        if (parsed.email || parsed.phone) {
          try {
            const dupRes = await fetch("/api/check-duplicate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: parsed.email, phone: parsed.phone }),
            });
            const dupJson = await dupRes.json() as {
              exists?: boolean;
              applicant?: DuplicateApplicant | null;
            };
            if (dupJson.exists && dupJson.applicant) duplicate = dupJson.applicant;
          } catch {
            // ignore duplicate check failures
          }
        }

        built.push({
          id: uid(),
          file,
          filename: file.name,
          // Auto-select only when not a duplicate AND LinkedIn was extracted
          // successfully. Rows missing LinkedIn stay unselected until the
          // admin pastes a valid URL into the inline field.
          selected: !duplicate && isValidLinkedInUrl(parsed.linkedin),
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          email: parsed.email,
          phone: parsed.phone,
          linkedin: parsed.linkedin,
          cvText: text,
          jobChoice: "",
          jobOther: "",
          duplicate,
          status: "ready",
          errorMsg: null,
        });
      } catch {
        built.push({
          id: uid(),
          file,
          filename: file.name,
          selected: false,
          firstName: "",
          lastName: "",
          email: "",
          phone: "",
          linkedin: "",
          cvText: "",
          jobChoice: "",
          jobOther: "",
          duplicate: null,
          status: "error",
          errorMsg: "Failed to read PDF",
        });
      }
      setProcessedCount(i + 1);
    }

    setRows(built);
    setStage("review");
  }

  function updateRow(id: string, patch: Partial<BulkRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function setAllSelected(value: boolean) {
    // Only rows with a valid LinkedIn URL can ever be selected. Toggling
    // "Select All" still respects that gate.
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        selected: value && isValidLinkedInUrl(r.linkedin),
      })),
    );
  }

  async function submitSelected() {
    const selectedRows = rows.filter((r) => r.selected && r.status !== "done");
    if (selectedRows.length === 0) return;

    // Pre-flight check on the EDITED row state. The per-row submit loop also
    // validates first-name + LinkedIn, but catching email/name issues up front
    // means we don't fire half the uploads before bailing out.
    const invalid = selectedRows.find((r) => {
      if (!r.firstName.trim()) return true;
      if (!r.lastName.trim()) return true;
      // Email is optional in /api/apply, but if the admin typed something
      // it must be a real email — protects the duplicate-detection step.
      if (r.email.trim() && !isValidEmail(r.email)) return true;
      return false;
    });
    if (invalid) {
      setError(
        "Some rows have invalid email or missing name. Please fix and try again.",
      );
      return;
    }

    setError(null);
    setSubmitting(true);
    setSubmittedCount(0);
    setSubmitTotal(selectedRows.length);

    let successCount = 0;
    let errorCount = 0;

    for (const row of selectedRows) {
      updateRow(row.id, { status: "submitting", errorMsg: null });

      if (!row.firstName.trim()) {
        updateRow(row.id, { status: "error", errorMsg: "First name required" });
        errorCount++;
        setSubmittedCount((p) => p + 1);
        continue;
      }
      if (!isValidLinkedInUrl(row.linkedin)) {
        updateRow(row.id, { status: "error", errorMsg: "Valid LinkedIn URL required" });
        errorCount++;
        setSubmittedCount((p) => p + 1);
        continue;
      }
      if (row.jobChoice === "__other__" && !row.jobOther.trim()) {
        updateRow(row.id, { status: "error", errorMsg: "Type a job role" });
        errorCount++;
        setSubmittedCount((p) => p + 1);
        continue;
      }

      try {
        const fd = new FormData();
        if (row.jobChoice === "__other__") {
          fd.append("job_title_manual", row.jobOther.trim());
        } else if (row.jobChoice) {
          fd.append("job_id", row.jobChoice);
        }
        fd.append("first_name", row.firstName.trim());
        if (row.lastName.trim()) fd.append("last_name",    row.lastName.trim());
        if (row.email.trim())    fd.append("email",        row.email.trim());
        if (row.phone.trim())    fd.append("phone",        row.phone.trim());
        fd.append("linkedin_url", row.linkedin.trim());
        if (row.cvText.trim())   fd.append("cv_text",      row.cvText);
        fd.append("source", "manual_upload");
        fd.append("cv", row.file);

        const res = await fetch("/api/apply", { method: "POST", body: fd });
        const json = await res.json() as { success?: boolean; error?: string };

        if (!res.ok || json.error) {
          updateRow(row.id, { status: "error", errorMsg: json.error ?? "Failed" });
          errorCount++;
        } else {
          updateRow(row.id, { status: "done" });
          successCount++;
        }
      } catch (err) {
        updateRow(row.id, {
          status: "error",
          errorMsg: err instanceof Error ? err.message : "Network error",
        });
        errorCount++;
      }
      setSubmittedCount((p) => p + 1);
    }

    setSubmitting(false);

    const summary =
      errorCount === 0
        ? `${successCount} added successfully`
        : `${successCount} added, ${errorCount} error${errorCount === 1 ? "" : "s"}`;

    if (errorCount === 0) {
      onComplete(summary);
    } else {
      // keep modal open so user can retry the failed rows
      setError(summary);
    }
  }

  // ── Derived for review summary ─────────────────────────────
  const totalRows         = rows.length;
  const dupRows           = rows.filter((r) => r.duplicate).length;
  const selectedRows      = rows.filter((r) => r.selected).length;
  const skippedDupRows    = rows.filter((r) => r.duplicate && !r.selected).length;
  const invalidLiRows     = rows.filter((r) => !isValidLinkedInUrl(r.linkedin)).length;
  const eligibleRows      = rows.filter((r) => isValidLinkedInUrl(r.linkedin));
  const allSelected       = eligibleRows.length > 0 && eligibleRows.every((r) => r.selected);

  // ── Modal width depends on stage ───────────────────────────
  const modalWidth = stage === "review" ? "max-w-6xl" : "max-w-lg";

  const ROW_INPUT_CLS =
    "w-full rounded border border-transparent bg-transparent px-2 py-1 text-xs text-gray-800 outline-none transition-colors hover:border-gray-200 focus:border-remotiv-purple focus:ring-1 focus:ring-remotiv-purple/20";

  const headerSubtitle = (() => {
    if (stage === "upload")     return "Drop up to 50 CV PDFs to get started";
    if (stage === "processing") return `Processing CVs… ${processedCount}/${files.length}`;
    return `${totalRows} CV${totalRows === 1 ? "" : "s"} ready · ${dupRows} duplicate${dupRows === 1 ? "" : "s"} found`;
  })();

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-upload-title"
        className={`relative mx-auto my-8 flex w-full ${modalWidth} flex-col rounded-2xl bg-white shadow-2xl`}
      >
        {/* Header */}
        <div className="relative shrink-0 rounded-t-2xl bg-remotiv-purple px-7 py-6 pr-16">
          {!submitting && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-5 flex size-11 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/35 sm:size-9 sm:top-6"
            >
              <X className="size-4" strokeWidth={2.5} />
            </button>
          )}
          <p id="bulk-upload-title" className="font-heading text-xl font-bold text-white">Bulk CV Upload</p>
          <p className="mt-0.5 text-sm text-white/70">{headerSubtitle}</p>
        </div>

        {/* Body */}
        <div className="flex-1 px-4 py-5 sm:px-7 sm:py-6">
          {stage === "upload" ? (
            <>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  addFiles(e.dataTransfer.files);
                }}
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 transition-colors ${
                  dragOver
                    ? "border-remotiv-purple bg-remotiv-purple/5"
                    : "border-gray-200 bg-gray-50 hover:border-remotiv-purple/40"
                }`}
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-remotiv-purple/10">
                  <Upload className="size-5 text-remotiv-purple" strokeWidth={2} />
                </div>
                <p className="font-heading text-sm font-semibold text-gray-800">
                  Drop up to {MAX_BULK} CV PDFs here or click to browse
                </p>
                <p className="text-xs text-gray-400">PDF only · max 5 MB each</p>
                {files.length > 0 && (
                  <p className="mt-2 text-sm font-semibold text-remotiv-purple">
                    {files.length} file{files.length === 1 ? "" : "s"} selected
                  </p>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => addFiles(e.target.files)}
                className="hidden"
              />

              {files.length > 0 && (
                <div className="mt-4 max-h-40 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
                  {files.map((f, idx) => (
                    <div key={`${f.name}-${idx}`} className="flex items-center justify-between py-1 text-xs">
                      <span className="truncate text-gray-600">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, i) => i !== idx))}
                        className="ml-2 shrink-0 text-gray-400 hover:text-red-500"
                        aria-label={`Remove ${f.name}`}
                      >
                        <X className="size-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {error && (
                <p className="mt-4 whitespace-pre-line rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={processFiles}
                disabled={files.length === 0}
                className="mt-6 w-full rounded-xl bg-gray-900 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Process CVs
              </button>
            </>
          ) : stage === "processing" ? (
            <div className="flex flex-col items-center justify-center gap-5 py-12">
              <Loader2 className="size-10 animate-spin text-remotiv-purple" strokeWidth={2} />
              <p className="font-heading text-sm font-semibold text-gray-800">
                Processing CVs… {processedCount}/{files.length}
              </p>
              <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-remotiv-purple transition-all duration-200"
                  style={{ width: `${(processedCount / Math.max(files.length, 1)) * 100}%` }}
                />
              </div>
              <p className="text-xs text-gray-400">Extracting fields and checking for duplicates</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Top toolbar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <button
                    type="button"
                    onClick={() => setAllSelected(!allSelected)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                  >
                    {allSelected ? "Deselect All" : "Select All"}
                  </button>
                  <span>
                    {totalRows} total · {dupRows} duplicate{dupRows === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => { setStage("upload"); setRows([]); setError(null); }}
                  disabled={submitting}
                  className="text-xs font-medium text-gray-400 transition-colors hover:text-gray-600 disabled:opacity-50"
                >
                  ← Back
                </button>
              </div>

              {/* Review table — desktop only. On mobile we render the same
                  rows as stacked cards below. */}
              <div className="hidden max-h-[60vh] overflow-auto rounded-xl border border-gray-100 lg:block">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur">
                    <tr className="border-b border-gray-100">
                      <th className="w-10 px-3 py-3"></th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">CV File</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">First Name</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Last Name</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Email</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Phone</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                        LinkedIn <span className="text-red-500">*</span>
                      </th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Job Role</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Dup</th>
                      <th className="px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">Status</th>
                      <th className="w-10 px-3 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-6 py-12 text-center text-sm text-gray-400">
                          No rows
                        </td>
                      </tr>
                    ) : (
                      rows.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-b border-gray-50 transition-colors ${
                            row.duplicate ? "bg-amber-50/50" : ""
                          }`}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={row.selected}
                              disabled={!isValidLinkedInUrl(row.linkedin)}
                              title={
                                !isValidLinkedInUrl(row.linkedin)
                                  ? "Add a valid LinkedIn URL to enable upload"
                                  : ""
                              }
                              onChange={(e) => updateRow(row.id, { selected: e.target.checked })}
                              className="size-4 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          </td>
                          <td className="px-3 py-2 max-w-[180px]">
                            <p className="truncate text-xs text-gray-600" title={row.filename}>
                              {row.filename}
                            </p>
                          </td>
                          <td className="min-w-[120px] px-3 py-2">
                            <EditableCell
                              value={row.firstName}
                              onChange={(v) => updateRow(row.id, { firstName: v })}
                              placeholder="First name"
                            />
                          </td>
                          <td className="min-w-[120px] px-3 py-2">
                            <EditableCell
                              value={row.lastName}
                              onChange={(v) => updateRow(row.id, { lastName: v })}
                              placeholder="Last name"
                            />
                          </td>
                          <td className="min-w-[200px] px-3 py-2">
                            <EditableCell
                              value={row.email}
                              onChange={(v) => updateRow(row.id, { email: v })}
                              type="email"
                              placeholder="email@example.com"
                            />
                          </td>
                          <td className="min-w-[130px] px-3 py-2">
                            <EditableCell
                              value={row.phone}
                              onChange={(v) => updateRow(row.id, { phone: v })}
                              type="tel"
                              placeholder="+1 555…"
                            />
                          </td>
                          <td className="min-w-[200px] px-3 py-2">
                            <EditableCell
                              value={row.linkedin}
                              onChange={(v) => {
                                // Force-deselect when the new URL is invalid so
                                // the upload count never includes a row that
                                // would be rejected server-side.
                                const next: Partial<BulkRow> = { linkedin: v };
                                if (row.selected && !isValidLinkedInUrl(v)) {
                                  next.selected = false;
                                }
                                updateRow(row.id, next);
                              }}
                              type="url"
                              placeholder="https://linkedin.com/in/…"
                            />
                            {!isValidLinkedInUrl(row.linkedin) && (
                              <p className="mt-1 inline-flex items-start gap-1 text-[10px] font-medium leading-tight text-red-500">
                                <AlertTriangle className="mt-px size-3 shrink-0" strokeWidth={2} />
                                <span>
                                  {row.linkedin.trim()
                                    ? "Please enter a valid LinkedIn URL"
                                    : "LinkedIn URL missing — add manually"}
                                </span>
                              </p>
                            )}
                          </td>
                          <td className="px-3 py-2 min-w-[160px]">
                            <select
                              value={row.jobChoice}
                              onChange={(e) => updateRow(row.id, { jobChoice: e.target.value })}
                              className={ROW_INPUT_CLS}
                            >
                              <option value="">—</option>
                              {openJobs.map((j) => (
                                <option key={j.id} value={j.id}>{j.title}</option>
                              ))}
                              <option value="__other__">Other (type)</option>
                            </select>
                            {row.jobChoice === "__other__" && (
                              <input
                                type="text"
                                placeholder="Type job…"
                                value={row.jobOther}
                                onChange={(e) => updateRow(row.id, { jobOther: e.target.value })}
                                className={`${ROW_INPUT_CLS} mt-1`}
                              />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {row.duplicate ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
                                title={`Existing: ${row.duplicate.first_name} ${row.duplicate.last_name}`}
                              >
                                <AlertTriangle className="size-3" strokeWidth={2.5} />
                                Exists
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                                New
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {row.status === "ready" && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400">
                                <Clock className="size-3" strokeWidth={2} />
                                Ready
                              </span>
                            )}
                            {row.status === "submitting" && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-remotiv-purple">
                                <Loader2 className="size-3 animate-spin" strokeWidth={2} /> Sending
                              </span>
                            )}
                            {row.status === "done" && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-600">
                                <CheckCircle className="size-3" strokeWidth={2} /> Done
                              </span>
                            )}
                            {row.status === "error" && (
                              <span
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-red-500"
                                title={row.errorMsg ?? ""}
                              >
                                <X className="size-3" strokeWidth={2.5} />
                                Error
                              </span>
                            )}
                            {row.status === "skipped" && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400">
                                Skipped
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => removeRow(row.id)}
                              disabled={submitting}
                              className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                              aria-label="Remove row"
                            >
                              <X className="size-3.5" strokeWidth={2} />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Review cards — mobile only. Mirrors the desktop columns but
                  stacks each row vertically so the modal stays usable on a
                  phone (the table itself overflows horribly under ~720px). */}
              <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1 lg:hidden">
                {rows.length === 0 ? (
                  <p className="px-4 py-12 text-center text-sm text-gray-400">No rows</p>
                ) : (
                  rows.map((row) => {
                    const liInvalid = !isValidLinkedInUrl(row.linkedin);
                    return (
                      <div
                        key={row.id}
                        className={`rounded-xl border p-4 ${
                          row.duplicate
                            ? "border-amber-200 bg-amber-50/50"
                            : "border-gray-200 bg-white"
                        }`}
                      >
                        {/* Header row: checkbox + filename + duplicate + remove */}
                        <div className="mb-3 flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            disabled={liInvalid}
                            onChange={(e) =>
                              updateRow(row.id, { selected: e.target.checked })
                            }
                            className="mt-1 size-4 shrink-0 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple disabled:cursor-not-allowed disabled:opacity-40"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                              CV File
                            </p>
                            <p
                              className="truncate text-sm font-medium text-gray-700"
                              title={row.filename}
                            >
                              {row.filename}
                            </p>
                          </div>
                          {row.duplicate ? (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                              <AlertTriangle className="size-3" strokeWidth={2.5} />
                              Exists
                            </span>
                          ) : (
                            <span className="inline-flex shrink-0 items-center rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                              New
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeRow(row.id)}
                            disabled={submitting}
                            aria-label="Remove row"
                            className="flex size-9 shrink-0 items-center justify-center rounded text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                          >
                            <X className="size-4" strokeWidth={2} />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                              First Name
                            </label>
                            <EditableCell
                              value={row.firstName}
                              onChange={(v) => updateRow(row.id, { firstName: v })}
                              placeholder="First name"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                              Last Name
                            </label>
                            <EditableCell
                              value={row.lastName}
                              onChange={(v) => updateRow(row.id, { lastName: v })}
                              placeholder="Last name"
                            />
                          </div>
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                            Email
                          </label>
                          <EditableCell
                            value={row.email}
                            onChange={(v) => updateRow(row.id, { email: v })}
                            type="email"
                            placeholder="email@example.com"
                          />
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                            Phone
                          </label>
                          <EditableCell
                            value={row.phone}
                            onChange={(v) => updateRow(row.id, { phone: v })}
                            type="tel"
                            placeholder="+1 555…"
                          />
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                            LinkedIn <span className="text-red-500">*</span>
                          </label>
                          <EditableCell
                            value={row.linkedin}
                            onChange={(v) => {
                              const next: Partial<BulkRow> = { linkedin: v };
                              if (row.selected && !isValidLinkedInUrl(v)) {
                                next.selected = false;
                              }
                              updateRow(row.id, next);
                            }}
                            type="url"
                            placeholder="https://linkedin.com/in/…"
                          />
                          {liInvalid && (
                            <p className="mt-1 inline-flex items-start gap-1 text-[10px] font-medium leading-tight text-red-500">
                              <AlertTriangle className="mt-px size-3 shrink-0" strokeWidth={2} />
                              <span>
                                {row.linkedin.trim()
                                  ? "Please enter a valid LinkedIn URL"
                                  : "LinkedIn URL missing — add manually"}
                              </span>
                            </p>
                          )}
                        </div>

                        <div className="mt-3">
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                            Job Role
                          </label>
                          <select
                            value={row.jobChoice}
                            onChange={(e) =>
                              updateRow(row.id, { jobChoice: e.target.value })
                            }
                            className={ROW_INPUT_CLS}
                          >
                            <option value="">—</option>
                            {openJobs.map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.title}
                              </option>
                            ))}
                            <option value="__other__">Other (type)</option>
                          </select>
                          {row.jobChoice === "__other__" && (
                            <input
                              type="text"
                              placeholder="Type job…"
                              value={row.jobOther}
                              onChange={(e) =>
                                updateRow(row.id, { jobOther: e.target.value })
                              }
                              className={`${ROW_INPUT_CLS} mt-2`}
                            />
                          )}
                        </div>

                        {/* Status badge — only when not idle */}
                        {row.status !== "ready" && (
                          <div className="mt-3 flex items-center gap-1.5 border-t border-gray-100 pt-3">
                            {row.status === "submitting" && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-remotiv-purple">
                                <Loader2 className="size-3 animate-spin" strokeWidth={2} />{" "}
                                Sending
                              </span>
                            )}
                            {row.status === "done" && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-600">
                                <CheckCircle className="size-3" strokeWidth={2} /> Done
                              </span>
                            )}
                            {row.status === "error" && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-red-500"
                                title={row.errorMsg ?? ""}
                              >
                                <X className="size-3" strokeWidth={2.5} />
                                {row.errorMsg ?? "Error"}
                              </span>
                            )}
                            {row.status === "skipped" && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-400">
                                Skipped
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Bottom bar — stacks vertically on phones so the Submit
                  button never gets squished off-screen. Sticky so it stays
                  reachable while scrolling a long list of CV cards. The
                  -mx + px values mirror the parent body padding so the bar
                  spans the full modal width edge-to-edge. */}
              <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-gray-100 bg-white px-4 pb-2 pt-4 sm:-mx-7 sm:flex-row sm:items-center sm:justify-between sm:px-7">
                <p className="text-xs text-gray-500">
                  {submitting ? (
                    <>Uploading {submittedCount}/{submitTotal}…</>
                  ) : (
                    <>
                      {selectedRows} selected
                      {skippedDupRows > 0 && ` · ${skippedDupRows} duplicate${skippedDupRows === 1 ? "" : "s"} will be skipped`}
                      {invalidLiRows > 0 && (
                        <span className="text-red-500">
                          {" "}· {invalidLiRows} row{invalidLiRows === 1 ? "" : "s"} blocked — LinkedIn URL required
                        </span>
                      )}
                    </>
                  )}
                </p>

                <button
                  type="button"
                  onClick={submitSelected}
                  disabled={submitting || selectedRows === 0}
                  className="w-full rounded-xl bg-gray-900 px-6 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto sm:py-2.5"
                >
                  {submitting ? "Uploading…" : `Submit Selected (${selectedRows})`}
                </button>
              </div>

              {error && !submitting && (
                <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
