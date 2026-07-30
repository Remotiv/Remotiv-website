"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Briefcase,
  Check,
  Copy,
  DollarSign,
  Eye,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search as SearchIcon,
  Trash2,
  Users,
  X,
  XCircle,
} from "lucide-react";
import {
  canCreateJobs,
  type CompanyRole,
} from "@/app/ai-dashboard/lib/company-roles";
import {
  JOB_STATUS_LABELS,
  type CompanyJobRow,
  type JobStatus,
} from "@/app/ai-dashboard/lib/job-types";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  deleteCompanyJob,
  duplicateCompanyJob,
  updateCompanyJobStatus,
} from "./actions";

// ── Constants ────────────────────────────────────────────────

type Tab = "all" | "open" | "on_hold" | "closed";

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: "Published" },
  { key: "on_hold", label: "Draft" },
  { key: "closed", label: "Closed" },
];

const STATUS_BADGE: Record<JobStatus, { badge: string; dot: string }> = {
  open: {
    badge: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
    dot: "bg-remotiv-green",
  },
  on_hold: {
    badge: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    dot: "bg-[var(--ai-amber-dot)]",
  },
  closed: {
    badge: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    dot: "bg-[var(--ai-t4)]",
  },
};

const ICON_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)" },
  { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)" },
  { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
];

const ROW_GRID =
  "grid grid-cols-[minmax(0,2.6fr)_1fr_0.9fr_0.9fr_40px] items-center gap-4 px-5";

// ── Helpers ──────────────────────────────────────────────────

function getTint(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return ICON_TINTS[hash % ICON_TINTS.length];
}

/** "6d ago" + the absolute date beneath. Drafts read "Not posted". */
function fmtPosted(iso: string, status: JobStatus): { main: string; sub: string } {
  const date = new Date(iso);
  const abs = Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  if (status === "on_hold") return { main: "Not posted", sub: `Edited ${abs}` };

  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (Number.isNaN(days)) return { main: "—", sub: abs };
  if (days < 1) return { main: "Today", sub: abs };
  if (days === 1) return { main: "1d ago", sub: abs };
  return { main: `${days}d ago`, sub: abs };
}

// ── Stat card ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  tintBg,
  tintFg,
}: {
  label: string;
  value: number;
  icon: typeof Briefcase;
  tintBg: string;
  tintFg: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-4">
      <div className="flex items-center gap-[7px] text-xs font-medium text-[var(--ai-t3)]">
        <span
          className="flex size-[26px] items-center justify-center rounded-lg"
          style={{ background: tintBg, color: tintFg }}
        >
          <Icon className="size-[15px]" strokeWidth={1.9} />
        </span>
        {label}
      </div>
      <div className="mt-3 font-heading text-[28px] font-extrabold leading-none tracking-[-0.02em]">
        {value}
      </div>
    </div>
  );
}

// ── Row menu ─────────────────────────────────────────────────

type MenuItem = {
  label: string;
  icon: typeof Pencil;
  onSelect: () => void;
  danger?: boolean;
};

const DRAWER_ACTION =
  "flex w-full items-center gap-2 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5 text-xs font-semibold transition-colors";

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-2">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]">
        {title}
      </p>
      {children}
    </section>
  );
}

function DrawerKv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-widest text-[var(--ai-t4)]">
        {label}
      </span>
      <span
        className={`flex-1 break-all text-[var(--ai-t2)] ${mono ? "font-mono text-[11px]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Right-hand slide-in panel replacing the old row dropdown, which clipped
 * inside the table's overflow container. Structure mirrors the admin
 * ClientDrawer (header / details / actions / danger) but is a local copy —
 * the two products never import each other's components.
 */
function JobDrawer({
  job,
  onClose,
  onAction,
  onCopyUrl,
  actions,
  dangerActions,
}: {
  job: CompanyJobRow;
  onClose: () => void;
  onAction: (item: MenuItem) => void;
  onCopyUrl: () => void;
  actions: ReadonlyArray<MenuItem>;
  dangerActions: ReadonlyArray<MenuItem>;
}) {
  const badge = STATUS_BADGE[job.status];
  const posted = fmtPosted(job.created_at, job.status);
  const publicUrl = job.slug ? `/jobs/${job.slug}` : null;

  // Escape closes; body scroll locks while open — the same pattern the
  // segment's other overlays use.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop is desktop-only: on mobile the panel covers the whole
          viewport, so a separate dim layer would never be visible. */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm min-[840px]:block"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${job.title}`}
        className="flex h-full w-full shrink-0 flex-col bg-[var(--ai-surface)] shadow-2xl min-[840px]:w-[420px]"
      >
        <div className="relative shrink-0 border-b border-[var(--ai-line)] px-4 py-5 min-[840px]:px-6 min-[840px]:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] min-[840px]:right-4 min-[840px]:top-4 min-[840px]:size-8"
          >
            <X className="size-5 min-[840px]:size-4" strokeWidth={2.5} />
          </button>

          <div className="flex items-start gap-4 pr-8">
            <span
              className="flex size-[42px] shrink-0 items-center justify-center rounded-xl"
              style={{ background: getTint(job.id).bg, color: getTint(job.id).fg }}
            >
              <Briefcase className="size-[19px]" strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-heading text-lg font-bold text-[var(--ai-t1)]">
                {job.title}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-[7px] text-[12.5px] text-[var(--ai-t3)]">
                <span className="truncate">{job.location}</span>
                <span className="size-[3px] rounded-full bg-[var(--ai-t4)]" />
                {job.work_type}
                <span className="size-[3px] rounded-full bg-[var(--ai-t4)]" />
                {job.contract_type}
              </p>
              <span
                className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${badge.badge}`}
              >
                <span className={`size-[5px] rounded-full ${badge.dot}`} />
                {JOB_STATUS_LABELS[job.status]}
              </span>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DrawerSection title="Details">
            <div className="grid grid-cols-1 gap-2 text-xs">
              <DrawerKv label="Applicants" value={String(job.applicant_count)} />
              <DrawerKv label="Posted" value={`${posted.main} · ${posted.sub}`} />
              <DrawerKv label="Openings" value={String(job.positions)} />
              <DrawerKv label="Experience" value={job.experience_level} />
            </div>

            {publicUrl && (
              <div className="mt-3 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ai-t4)]">
                  Public URL
                </p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-remotiv-purple">
                    {publicUrl}
                  </span>
                  <button
                    type="button"
                    onClick={onCopyUrl}
                    aria-label="Copy public URL"
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-purple-tint)] text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
                  >
                    <Copy className="size-4" strokeWidth={2} />
                  </button>
                </div>
              </div>
            )}
          </DrawerSection>

          <DrawerSection title="Actions">
            <div className="flex flex-col gap-2">
              {actions.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onAction(item)}
                  className={`${DRAWER_ACTION} text-[var(--ai-t2)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]`}
                >
                  <item.icon className="size-3.5 text-remotiv-purple" strokeWidth={2} />
                  {item.label}
                </button>
              ))}
            </div>
          </DrawerSection>

          {dangerActions.length > 0 && (
            <DrawerSection title="Danger">
              <div className="flex flex-col gap-2">
                {dangerActions.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => onAction(item)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ai-danger-tint)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-danger)] transition-opacity hover:opacity-80"
                  >
                    <item.icon className="size-3.5" strokeWidth={2} />
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--ai-t4)]">
                {job.status === "on_hold"
                  ? "Deleting a draft is permanent."
                  : "Closing removes the post from remotiv.work. Deleting is permanent — applicants are kept, with the job title recorded against them."}
              </p>
            </DrawerSection>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────

export function JobsClient({
  viewerRole,
  jobs: initialJobs,
}: {
  viewerRole: CompanyRole;
  jobs: CompanyJobRow[];
}) {
  const router = useRouter();
  const canManage = canCreateJobs(viewerRole);

  const [jobs, setJobs] = useState<CompanyJobRow[]>(initialJobs);
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  /** Job whose action drawer is open. Replaces the old per-row dropdown, which
   *  clipped inside the table's horizontal-scroll container. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { job: CompanyJobRow; kind: "close" | "delete" } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setJobs(initialJobs);
  }, [initialJobs]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(
    () => ({
      all: jobs.length,
      open: jobs.filter((j) => j.status === "open").length,
      on_hold: jobs.filter((j) => j.status === "on_hold").length,
      closed: jobs.filter((j) => j.status === "closed").length,
    }),
    [jobs],
  );

  const totalApplicants = jobs.reduce((sum, j) => sum + j.applicant_count, 0);

  const openJob = openId ? (jobs.find((j) => j.id === openId) ?? null) : null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (tab !== "all" && j.status !== tab) return false;
      if (q && !j.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [jobs, tab, search]);

  async function handleStatus(job: CompanyJobRow, status: JobStatus, message: string) {
    const previous = job.status;
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status } : j)));
    const result = await updateCompanyJobStatus(job.id, status);
    if (result.success) {
      setToast(message);
      router.refresh();
    } else {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: previous } : j)));
      setToast(result.error);
    }
  }

  async function handleDuplicate(job: CompanyJobRow) {
    setToast(`Duplicating “${job.title}”…`);
    const result = await duplicateCompanyJob(job.id);
    setToast(result.success ? `“${job.title}” duplicated as a draft` : result.error);
    if (result.success) router.refresh();
  }

  async function handleConfirm() {
    if (!confirm) return;
    const { job, kind } = confirm;
    setBusy(true);
    const result =
      kind === "close"
        ? await updateCompanyJobStatus(job.id, "closed")
        : await deleteCompanyJob(job.id);
    setBusy(false);

    if (result.success) {
      setJobs((prev) =>
        kind === "close"
          ? prev.map((j) => (j.id === job.id ? { ...j, status: "closed" } : j))
          : prev.filter((j) => j.id !== job.id),
      );
      setConfirm(null);
      setOpenId(null);
      setToast(kind === "close" ? `“${job.title}” closed` : `“${job.title}” deleted`);
      router.refresh();
    } else {
      setToast(result.error);
    }
  }

  /** State-appropriate drawer actions, split into normal and danger groups. */
  function actionsFor(job: CompanyJobRow): {
    actions: MenuItem[];
    danger: MenuItem[];
  } {
    if (!canManage) return { actions: [], danger: [] };

    const edit: MenuItem = {
      label: job.status === "on_hold" ? "Edit draft" : "Edit job",
      icon: Pencil,
      onSelect: () => router.push(`/ai-dashboard/jobs/${job.id}/edit`),
    };
    const duplicate: MenuItem = {
      label: "Duplicate",
      icon: Copy,
      onSelect: () => handleDuplicate(job),
    };
    const view: MenuItem = {
      label: "View public post",
      icon: Eye,
      onSelect: () => window.open(`/jobs/${job.slug ?? ""}`, "_blank", "noopener"),
    };

    if (job.status === "open") {
      return {
        actions: [edit, duplicate, view],
        danger: [
          {
            label: "Close job",
            icon: XCircle,
            onSelect: () => setConfirm({ job, kind: "close" }),
            danger: true,
          },
        ],
      };
    }
    if (job.status === "on_hold") {
      return {
        actions: [edit, duplicate],
        danger: [
          {
            label: "Delete draft",
            icon: Trash2,
            onSelect: () => setConfirm({ job, kind: "delete" }),
            danger: true,
          },
        ],
      };
    }
    return {
      actions: [
        {
          label: "Reopen job",
          icon: RotateCcw,
          onSelect: () => handleStatus(job, "open", `“${job.title}” reopened`),
        },
        duplicate,
        view,
      ],
      danger: [
        {
          label: "Delete",
          icon: Trash2,
          onSelect: () => setConfirm({ job, kind: "delete" }),
          danger: true,
        },
      ],
    };
  }

  async function handleCopyUrl(job: CompanyJobRow) {
    if (!job.slug) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/jobs/${job.slug}`,
      );
      setToast("Public URL copied");
    } catch {
      // Clipboard blocked — the URL is on screen for manual copying.
    }
  }

  const emptyCopy = (() => {
    if (search.trim()) {
      return {
        title: `No jobs match “${search.trim()}”`,
        text: "Try a different title, or clear your search to see every role.",
      };
    }
    if (jobs.length === 0) {
      return {
        title: "No jobs yet",
        text: "Post your first role and it goes live on remotiv.work instantly — your AI recruiter starts screening applicants the moment they apply.",
      };
    }
    return {
      title: `No ${JOB_STATUS_LABELS[tab as JobStatus]?.toLowerCase() ?? ""} jobs`,
      text: "Nothing here right now. Switch tabs or post a new role to get started.",
    };
  })();

  return (
    <PageContainer>
      {/* Header */}
      <div className="mb-[22px] flex flex-col items-start justify-between gap-4 min-[525px]:flex-row min-[525px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Jobs
          </h1>
          <p className="mt-2 max-w-[460px] text-sm text-[var(--ai-t2)]">
            Post roles that go live on remotiv.work instantly and start
            collecting AI-screened applicants.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/ai-dashboard/jobs/new"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-remotiv-purple px-[18px] py-3 text-sm font-semibold text-white shadow-[0_4px_16px_rgba(126,71,255,0.28)] transition-colors hover:bg-[var(--ai-purple-hover)]"
          >
            <Plus className="size-4" strokeWidth={2.5} />
            New job
          </Link>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-[15px] py-[11px] text-[13px] text-[var(--ai-t3)]">
            <Lock className="size-[15px]" strokeWidth={1.8} />
            Read-only · assigned jobs
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[1049px]:grid-cols-4">
        <StatCard
          label="Published"
          value={counts.open}
          icon={Check}
          tintBg="var(--ai-mint-tint)"
          tintFg="var(--ai-mint-ink)"
        />
        <StatCard
          label="Draft"
          value={counts.on_hold}
          icon={Pencil}
          tintBg="var(--ai-amber-tint)"
          tintFg="var(--ai-amber-ink)"
        />
        <StatCard
          label="Applicants"
          value={totalApplicants}
          icon={Users}
          tintBg="var(--ai-purple-tint)"
          tintFg="var(--ai-purple-ink)"
        />
        <StatCard
          label="Closed"
          value={counts.closed}
          icon={DollarSign}
          tintBg="var(--ai-sky-tint)"
          tintFg="var(--ai-sky-ink)"
        />
      </div>

      {/* Panel */}
      <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_4px_24px_rgba(20,16,32,0.05)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          <div className="flex rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 rounded-lg px-[13px] py-1.5 text-[12.5px] font-semibold transition-colors ${
                  tab === t.key
                    ? "bg-[var(--ai-surface)] text-[var(--ai-t1)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                    : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                }`}
              >
                {t.label}
                <span className="text-[11px] opacity-70">{counts[t.key]}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex w-[220px] items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple">
            <SearchIcon className="size-[15px] shrink-0" strokeWidth={1.8} />
            <input
              type="search"
              aria-label="Search jobs"
              placeholder="Search jobs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-w-0 bg-transparent text-[13px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)]"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[820px]">
            <div
              className={`${ROW_GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] py-[11px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]`}
            >
              <span>Job</span>
              <span>Status</span>
              <span>Applicants</span>
              <span>Posted</span>
              <span />
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-16 text-center">
                <div className="mb-[18px] flex size-16 items-center justify-center rounded-[18px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
                  <Briefcase className="size-7" strokeWidth={1.7} />
                </div>
                <h3 className="font-heading text-[19px] font-extrabold tracking-[-0.02em]">
                  {emptyCopy.title}
                </h3>
                <p className="mt-1.5 max-w-[340px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
                  {emptyCopy.text}
                </p>
                {canManage && jobs.length === 0 && (
                  <Link
                    href="/ai-dashboard/jobs/new"
                    className="mt-5 inline-flex items-center gap-2 rounded-xl bg-remotiv-purple px-[18px] py-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--ai-purple-hover)]"
                  >
                    <Plus className="size-4" strokeWidth={2.5} />
                    Post your first job
                  </Link>
                )}
              </div>
            ) : (
              filtered.map((job) => {
                const tint = getTint(job.id);
                const badge = STATUS_BADGE[job.status];
                const posted = fmtPosted(job.created_at, job.status);

                return (
                  <div
                    key={job.id}
                    className={`${ROW_GRID} border-b border-[var(--ai-line-soft)] py-[15px] transition-colors last:border-b-0 hover:bg-[#FCFBFA] ${
                      job.status === "closed" ? "opacity-[0.72]" : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      <span
                        className="flex size-[42px] shrink-0 items-center justify-center rounded-xl"
                        style={{ background: tint.bg, color: tint.fg }}
                      >
                        <Briefcase className="size-[19px]" strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14.5px] font-semibold leading-tight text-[var(--ai-t1)]">
                          {job.title}
                        </p>
                        <p className="mt-[3px] flex flex-wrap items-center gap-[7px] text-[12.5px] text-[var(--ai-t3)]">
                          <span className="truncate">{job.location}</span>
                          <span className="size-[3px] rounded-full bg-[var(--ai-t4)]" />
                          {job.contract_type}
                          <span className="size-[3px] rounded-full bg-[var(--ai-t4)]" />
                          {job.experience_level}
                        </p>
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 justify-self-start rounded-full px-3 py-1 text-xs font-semibold ${badge.badge}`}
                    >
                      <span className={`size-[5px] rounded-full ${badge.dot}`} />
                      {JOB_STATUS_LABELS[job.status]}
                    </span>

                    <span className="flex items-center gap-[7px] text-sm font-semibold text-[var(--ai-t1)]">
                      {job.status === "on_hold" && job.applicant_count === 0 ? (
                        <span className="font-medium text-[var(--ai-t4)]">—</span>
                      ) : (
                        <>
                          {job.applicant_count}{" "}
                          <small className="text-xs font-medium text-[var(--ai-t3)]">
                            applicants
                          </small>
                        </>
                      )}
                    </span>

                    <span className="text-[13px] text-[var(--ai-t2)]">
                      {posted.main}
                      <small className="block text-[11.5px] text-[var(--ai-t4)]">
                        {posted.sub}
                      </small>
                    </span>

                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(job.id)}
                        aria-label={`Actions for ${job.title}`}
                        aria-haspopup="dialog"
                        className="flex size-8 items-center justify-center justify-self-end rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-black/[0.06] hover:text-[var(--ai-t1)]"
                      >
                        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="text-[12.5px] text-[var(--ai-t3)]">
            Published jobs appear on your public careers page.
          </p>
          <span className="text-[12.5px] font-semibold text-[var(--ai-t2)]">
            <b className="text-remotiv-purple">{filtered.length}</b> of {jobs.length} jobs
          </span>
        </div>
      </div>

      {openJob && (
        <JobDrawer
          job={openJob}
          onClose={() => setOpenId(null)}
          onCopyUrl={() => handleCopyUrl(openJob)}
          actions={actionsFor(openJob).actions}
          dangerActions={actionsFor(openJob).danger}
          onAction={(item) => {
            // Destructive actions open their own confirm, so the drawer stays
            // put; everything else navigates or fires immediately.
            if (!item.danger) setOpenId(null);
            item.onSelect();
          }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-job-title"
            className="w-full max-w-sm overflow-hidden rounded-[20px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)]"
          >
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-danger-tint)]">
                {confirm.kind === "close" ? (
                  <XCircle className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
                ) : (
                  <Trash2 className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
                )}
              </div>
              <h3
                id="confirm-job-title"
                className="font-heading text-lg font-bold text-[var(--ai-t1)]"
              >
                {confirm.kind === "close" ? "Close this job?" : "Delete this job?"}
              </h3>
              <p className="mt-2 text-sm text-[var(--ai-t2)]">
                {confirm.kind === "close" ? (
                  <>
                    <span className="font-semibold">{confirm.job.title}</span> will be
                    removed from remotiv.work and stop accepting applications. Existing
                    applicants stay in your workspace.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{confirm.job.title}</span> will be
                    permanently deleted. Applicants are kept, with the job title recorded
                    against them.
                  </>
                )}
              </p>
            </div>
            <div className="flex gap-3 border-t border-[var(--ai-line)] px-6 py-4">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                disabled={busy}
                className="flex-1 rounded-xl border border-[var(--ai-line)] py-2.5 text-sm font-medium text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={busy}
                aria-busy={busy}
                className="flex-1 rounded-xl bg-[var(--ai-danger)] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Working…" : confirm.kind === "close" ? "Close job" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-xl bg-[var(--ai-sidebar)] px-[18px] py-3 text-[13.5px] font-medium text-white shadow-[0_16px_40px_rgba(0,0,0,0.3)]"
        >
          <Check className="size-4 text-remotiv-green" strokeWidth={2.4} />
          {toast}
        </div>
      )}
    </PageContainer>
  );
}
