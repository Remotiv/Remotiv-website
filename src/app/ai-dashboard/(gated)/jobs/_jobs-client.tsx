"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  Briefcase,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search as SearchIcon,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { categoryVisual } from "@/app/ai-dashboard/lib/category-icons";
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
// Lives with the applicants actions, not the jobs ones — it operates on
// application_scores and re-checks ownership through company_id_snapshot.
import { rescoreJob } from "../applicants/actions";

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

/**
 * Icon tint + the matching volume-bar colour, picked together so a job's
 * avatar and its applicant bar always agree. `bar` values are the DS accents
 * (mint / purple-soft / sky / lime) — vivid enough to read at 5–6px, unlike
 * the pale `bg` tints.
 */
const ICON_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)", bar: "#9886FE" },
  { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)", bar: "#49D7A7" },
  { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)", bar: "#D9F972" },
  { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)", bar: "#4C8DD9" },
];

/** Mock's `.gridrow`: Job / Status / Applicants / Posted / ⋯ */
const ROW_GRID =
  "grid grid-cols-[minmax(0,2.5fr)_1fr_1.15fr_0.9fr_40px] items-center gap-4 px-5";

/** Roles shown in the hero breakdown, matching the mock's four bars. */
const HERO_ROLE_LIMIT = 4;

/** Rows per page, table and cards alike. */
const PAGE_SIZE = 20;

// ── Helpers ──────────────────────────────────────────────────

/** Tint derived from a stable hash of the job id, never array position. */
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

/**
 * The design system's lime highlight sticker — one keyword per page lede.
 *
 * The sticker is a pseudo-element behind the text, rotated -1.2deg. The `z-0`
 * on the span is load-bearing: it opens a stacking context so the pseudo's
 * negative z-index resolves INSIDE the span instead of dropping behind the
 * page background, which is what makes a bare `-z-10` highlight vanish.
 */
function LimeHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold text-[var(--ai-t1)] before:absolute before:-left-[3px] before:-right-[3px] before:bottom-[8%] before:top-[6%] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
      {children}
    </span>
  );
}

// ── Dark hero ────────────────────────────────────────────────

type RoleBar = { id: string; title: string; count: number; bar: string };

/**
 * The hero's right-hand column: up to HERO_ROLE_LIMIT bars, biggest first.
 *
 * Split out of JobsHero so the "nothing published yet" case is a plain
 * absence of this component rather than a conditional wrapped around half the
 * hero's markup.
 */
function RoleBreakdown({
  bars,
  top,
  hiddenRoles,
  onShowAll,
}: {
  bars: RoleBar[];
  top: number;
  hiddenRoles: number;
  onShowAll: () => void;
}) {
  return (
    <div className="relative z-[1] min-w-0">
        <p className="m-0 mb-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
          Applicants by role
        </p>

        {bars.length === 0 ? (
          <p className="m-0 text-[12.5px] leading-relaxed text-white/50">
            No applications yet. Every published role appears here as soon as
            its first candidate applies.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {bars.map((b) => (
              <div
                key={b.id}
                className="grid grid-cols-[minmax(0,110px)_1fr_34px] items-center gap-3 min-[630px]:grid-cols-[minmax(0,150px)_1fr_34px]"
              >
                <span className="truncate text-[12.5px] text-white/70">
                  {b.title}
                </span>
                <span className="h-[6px] overflow-hidden rounded-[4px] bg-white/10">
                  <span
                    className="block h-full origin-left rounded-[4px]"
                    style={{
                      // Scaled to the top role, so the longest bar is always
                      // full width and the rest read as a proportion of it.
                      width: `${top > 0 ? Math.round((b.count / top) * 100) : 0}%`,
                      background: b.bar,
                    }}
                  />
                </span>
                <span className="text-right text-[12.5px] font-bold tabular-nums text-white">
                  {b.count}
                </span>
              </div>
            ))}

            {hiddenRoles > 0 && (
              <button
                type="button"
                onClick={onShowAll}
                className="mt-1 self-start text-[11.5px] font-semibold text-white/40 underline-offset-2 transition-colors hover:text-white/70 hover:underline"
              >
                +{hiddenRoles} more role{hiddenRoles === 1 ? "" : "s"}
              </button>
            )}
          </div>
        )}
    </div>
  );
}

/**
 * The segment's signature dark strip: #141020, 22px radius, a purple radial
 * glow bleeding in from the top-right, and the page's headline metric beside a
 * breakdown.
 *
 * Every <p> here sets its colour explicitly. The design system ships a global
 * `p { color: #444 }` that beats an inherited white from the parent, so a <p>
 * without its own colour renders near-invisible on this surface.
 */
function JobsHero({
  totalApplicants,
  publishedCount,
  bars,
  hiddenRoles,
  onShowAll,
}: {
  totalApplicants: number;
  publishedCount: number;
  bars: RoleBar[];
  hiddenRoles: number;
  onShowAll: () => void;
}) {
  const top = bars[0]?.count ?? 0;

  /**
   * With nothing published there is no breakdown to draw, so the whole
   * right-hand column and its divider are dropped rather than rendering a
   * heading over empty space. The metric block then spans the strip alone.
   */
  const hasBreakdown = publishedCount > 0;

  const subline = (() => {
    if (publishedCount === 0) return "No roles are live yet";
    return `Across ${publishedCount} published role${publishedCount === 1 ? "" : "s"}`;
  })();

  return (
    <div
      className={`relative mb-[26px] grid grid-cols-1 gap-6 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] px-6 py-6 shadow-[0_18px_46px_rgba(20,16,32,0.24)] min-[840px]:gap-7 min-[840px]:px-7 ${
        hasBreakdown ? "min-[840px]:grid-cols-[auto_1px_1fr]" : ""
      }`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-[90px] -top-[110px] size-[340px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(126,71,255,0.5), transparent 68%)",
        }}
      />

      <div className="relative z-[1]">
        <p className="m-0 mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
          Applicants in play
        </p>
        <p className="m-0 font-heading text-[46px] font-extrabold leading-none tracking-[-0.04em] text-white">
          {totalApplicants}
        </p>
        <p className="m-0 mt-[9px] text-[12.5px] text-white/50">{subline}</p>
      </div>

      {hasBreakdown && (
        <>
          <div
            aria-hidden
            className="hidden h-[78px] self-center bg-white/[0.12] min-[840px]:block"
          />
          <RoleBreakdown
            bars={bars}
            top={top}
            hiddenRoles={hiddenRoles}
            onShowAll={onShowAll}
          />
        </>
      )}
    </div>
  );
}

// ── Mobile card ──────────────────────────────────────────────

/**
 * Stacked card shown below the table breakpoint. Same information hierarchy as
 * the desktop row — identity, status, volume, posted — just laid out
 * vertically so nothing needs horizontal scrolling. Opens the same drawer.
 *
 * Tappable only for members who can manage jobs, mirroring the desktop row:
 * there the ⋯ trigger is the ONLY way into the drawer and it isn't rendered
 * for hiring managers, so a tappable card here would hand them a panel of
 * actions the table deliberately withholds.
 */
function JobCard({
  job,
  maxApplicants,
  isTopRole,
  canManage,
  onOpen,
}: {
  job: CompanyJobRow;
  maxApplicants: number;
  isTopRole: boolean;
  canManage: boolean;
  onOpen: () => void;
}) {
  const visual = categoryVisual(job.category);
  // `tint` is still the id-hashed palette: it drives the progress BAR,
  // which is a per-job accent and deliberately varied, not a category signal.
  const tint = getTint(job.id);
  const badge = STATUS_BADGE[job.status];
  const posted = fmtPosted(job.created_at, job.status);
  const notPosted = job.status === "on_hold" && job.applicant_count === 0;

  const body = (
    <>
      <div className="flex items-start gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: visual.bg, color: visual.fg }}
        >
          <visual.icon className="size-[18px]" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
            {job.title}
          </p>
          <p className="m-0 mt-[3px] flex flex-wrap items-center gap-[7px] text-[12.5px] text-[var(--ai-t3)]">
            <span className="truncate">{job.location}</span>
            <span className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />
            {job.contract_type}
            <span className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />
            {job.experience_level}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${badge.badge}`}
        >
          <span className={`size-[5px] shrink-0 rounded-full ${badge.dot}`} />
          {JOB_STATUS_LABELS[job.status]}
        </span>

        {notPosted ? (
          <span className="text-[12.5px] font-semibold italic text-[var(--ai-t4)]">
            Not posted
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-heading text-[15px] font-extrabold tabular-nums tracking-[-0.03em] text-[var(--ai-t1)]">
              {job.applicant_count}
            </span>
            <span className="h-[5px] w-[54px] shrink-0 overflow-hidden rounded-[3px] bg-[rgba(20,16,32,0.07)]">
              <span
                className="block h-full origin-left rounded-[3px]"
                style={{
                  width: `${
                    maxApplicants > 0
                      ? Math.round((job.applicant_count / maxApplicants) * 100)
                      : 0
                  }%`,
                  background: job.status === "open" ? tint.bar : "var(--ai-t4)",
                }}
              />
            </span>
            {isTopRole && (
              <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[0.04em] text-[#2F3A00]">
                Top role
              </span>
            )}
          </span>
        )}
      </div>

      <p className="m-0 mt-3 text-[11.5px] text-[var(--ai-t4)]">
        {posted.main} · {posted.sub}
      </p>
    </>
  );

  const shell = `w-full border-b border-[var(--ai-line-soft)] px-4 py-4 text-left last:border-b-0 ${
    job.status === "closed" ? "opacity-[0.66]" : ""
  }`;

  if (!canManage) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Actions for ${job.title}`}
      className={`${shell} bg-[var(--ai-surface)] transition-colors active:bg-[#FCFBFA]`}
    >
      {body}
    </button>
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
  onRescoreAll,
  actions,
  dangerActions,
}: {
  job: CompanyJobRow;
  onClose: () => void;
  onAction: (item: MenuItem) => void;
  onCopyUrl: () => void;
  /** Null when the viewer can't spend the scoring budget, or nobody applied. */
  onRescoreAll: (() => void) | null;
  actions: ReadonlyArray<MenuItem>;
  dangerActions: ReadonlyArray<MenuItem>;
}) {
  const drawerVisual = categoryVisual(job.category);
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
              style={{ background: drawerVisual.bg, color: drawerVisual.fg }}
            >
              <drawerVisual.icon className="size-[19px]" strokeWidth={1.8} />
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
          {onRescoreAll && (
            <DrawerSection title="AI scoring">
              <button
                type="button"
                onClick={onRescoreAll}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
              >
                <Sparkles className="size-3.5" strokeWidth={2} />
                Re-score all applicants
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--ai-t4)]">
                Re-runs the AI against this job&apos;s current requirements and
                screening questions. Costs roughly two cents per CV.
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
  const [page, setPage] = useState(1);
  /** Job whose action drawer is open. Replaces the old per-row dropdown, which
   *  clipped inside the table's horizontal-scroll container. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { job: CompanyJobRow; kind: "close" | "delete" | "rescore" } | null
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

  /**
   * Published roles that actually have applicants, biggest first.
   *
   * Roles on zero are excluded rather than drawn as empty bars: an empty bar
   * carries no information and would push a role that DOES have applicants out
   * of the four slots. They are still counted in "Across N published roles"
   * below the headline, so nothing disappears.
   *
   * Ties break on created_at (newest first), then id — without a total order
   * the browser's sort is free to reorder equal counts between renders and the
   * bars would shuffle on every keystroke in the search box.
   */
  const rankedRoles = useMemo(
    () =>
      jobs
        .filter((j) => j.status === "open" && j.applicant_count > 0)
        .sort((a, b) => {
          if (b.applicant_count !== a.applicant_count) {
            return b.applicant_count - a.applicant_count;
          }
          const byDate =
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
        }),
    [jobs],
  );

  const heroBars = useMemo<RoleBar[]>(
    () =>
      rankedRoles.slice(0, HERO_ROLE_LIMIT).map((j) => ({
        id: j.id,
        title: j.title,
        count: j.applicant_count,
        bar: getTint(j.id).bar,
      })),
    [rankedRoles],
  );

  /** Roles with applicants that didn't fit the four slots. */
  const hiddenRoles = Math.max(0, rankedRoles.length - HERO_ROLE_LIMIT);

  /** Longest row bar. Every other bar is drawn as a fraction of this. */
  const maxApplicants = jobs.reduce(
    (max, j) => Math.max(max, j.applicant_count),
    0,
  );

  /**
   * The job carrying the lime flag. Only meaningful once at least two roles
   * have applicants — flagging the "top" of a field of one says nothing.
   */
  const topJobId = useMemo(() => {
    const ranked = jobs
      .filter((j) => j.applicant_count > 0)
      .sort((a, b) => b.applicant_count - a.applicant_count);
    return ranked.length >= 2 ? ranked[0].id : null;
  }, [jobs]);

  const openJob = openId ? (jobs.find((j) => j.id === openId) ?? null) : null;

  /**
   * "+N more roles" jumps to the table on the Published tab, where every
   * published role is listed with its own count and proportional bar. The
   * panel carries `scroll-mt` so the sticky topbar doesn't cover the tabs on
   * arrival.
   */
  const panelRef = useRef<HTMLDivElement>(null);
  function showAllRoles() {
    setTab("open");
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      if (tab !== "all" && j.status !== tab) return false;
      if (q && !j.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [jobs, tab, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamped, not reset: closing the last job on the last page should land on
  // the new last page rather than bouncing to page 1.
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // Changing what is filtered resets to page 1 — page 4 of a one-page result
  // set renders empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on filter change, not on page change
  useEffect(() => {
    setPage(1);
  }, [tab, search]);

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
    // Re-score is the only non-destructive action routed through this dialog.
    // It is here because it SPENDS MONEY — roughly two cents per CV — and the
    // count is the number the confirm exists to show.
    let result: { success: boolean; error?: string | undefined };
    if (kind === "rescore") {
      result = await rescoreJob(job.id);
    } else if (kind === "close") {
      result = await updateCompanyJobStatus(job.id, "closed");
    } else {
      result = await deleteCompanyJob(job.id);
    }
    setBusy(false);

    if (result.success) {
      // A re-score changes no row in this list — only the scorecards behind it.
      if (kind !== "rescore") {
        setJobs((prev) =>
          kind === "close"
            ? prev.map((j) => (j.id === job.id ? { ...j, status: "closed" } : j))
            : prev.filter((j) => j.id !== job.id),
        );
      }
      setConfirm(null);
      setOpenId(null);
      setToast(
        kind === "rescore"
          ? `Re-scoring ${job.applicant_count} applicant${job.applicant_count === 1 ? "" : "s"} for “${job.title}”`
          : kind === "close"
            ? `“${job.title}” closed`
            : `“${job.title}” deleted`,
      );
      router.refresh();
    } else {
      setToast(result.error ?? "Something went wrong. Please try again.");
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

  /**
   * The lede's opening clause. The tail after it is fixed, so the sticker
   * always lands on the same word.
   *
   * Deliberately says nothing about screening or scoring: the AI recruiter
   * does not read CVs yet, and the mock's sample copy assumes it does. What
   * IS true today is that publishing puts the role on remotiv.work at once.
   */
  const ledeCount = (() => {
    const total = counts.all;
    if (total === 0) return "No roles posted yet.";
    const roles = `${total} role${total === 1 ? "" : "s"} posted`;
    if (counts.open === 0) return `${roles}, none live yet.`;
    return `${roles}, ${counts.open} live right now.`;
  })();

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
      <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[630px]:flex-row min-[630px]:items-end min-[630px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Jobs
          </h1>
          <p className="mt-2.5 max-w-[520px] text-[14.5px] leading-relaxed text-[var(--ai-t2)]">
            {ledeCount} Every published job goes live on remotiv.work{" "}
            <LimeHighlight>instantly</LimeHighlight> and starts collecting
            applicants.
          </p>
        </div>
        <div className="flex shrink-0 gap-2.5">
          {canManage ? (
            <>
              <button
                type="button"
                disabled
                title="Archived jobs arrive in a later release"
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] disabled:cursor-not-allowed disabled:opacity-55"
              >
                <Archive className="size-[15px]" strokeWidth={1.9} />
                Archive
              </button>
              <Link
                href="/ai-dashboard/jobs/new"
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-remotiv-purple px-[18px] py-[11px] text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)] hover:shadow-[0_10px_28px_rgba(126,71,255,0.4)]"
              >
                <Plus className="size-[15px]" strokeWidth={2.2} />
                New job
              </Link>
            </>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[15px] py-[11px] text-[13px] font-semibold text-[var(--ai-t3)]">
              <Lock className="size-[15px]" strokeWidth={1.9} />
              Read-only · assigned jobs
            </span>
          )}
        </div>
      </div>

      <JobsHero
        totalApplicants={totalApplicants}
        publishedCount={counts.open}
        bars={heroBars}
        hiddenRoles={hiddenRoles}
        onShowAll={showAllRoles}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="scroll-mt-[76px] overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          {/* Active tab is solid ink with a white count badge — the segment's
              standard active state, not a pale pill.

              The four-tab strip is wider than a small phone, so it scrolls
              WITHIN itself (max-w-full + overflow-x-auto) and can never widen
              the page. */}
          <div className="flex max-w-full overflow-x-auto rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-[7px] rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors min-[525px]:px-[14px] ${
                  tab === t.key
                    ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
                    : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                }`}
              >
                {t.label}
                <span
                  className={`rounded-full px-1.5 py-px text-[10.5px] font-bold ${
                    tab === t.key
                      ? "bg-white/20 text-white"
                      : "bg-[rgba(20,16,32,0.07)]"
                  }`}
                >
                  {counts[t.key]}
                </span>
              </button>
            ))}
          </div>

          {/* Full-width on phones so search stacks UNDER the tabs rather than
              forcing the toolbar wider than the viewport. */}
          <div className="flex w-full min-w-0 items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple min-[630px]:ml-auto min-[630px]:w-[220px]">
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

        {/* Hoisted OUT of the table wrapper on purpose: nested inside it, the
            empty state inherited the min-width and only rendered at desktop
            widths, leaving phones with a blank panel. */}
        {filtered.length === 0 && (
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
        )}

        {/* Stacked cards below the table breakpoint. The 5-column grid needs
            900 design px; the widest phone in scope offers 415. Squeezing it
            would crush the volume bar, and scrolling it sideways hides Status,
            Applicants and Posted. */}
        {paged.length > 0 && (
          <div className="min-[1049px]:hidden">
            {paged.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                maxApplicants={maxApplicants}
                isTopRole={job.id === topJobId}
                canManage={canManage}
                onOpen={() => setOpenId(job.id)}
              />
            ))}
          </div>
        )}

        {/* Desktop table — unchanged above the breakpoint. overflow-x-auto is
            kept as a belt-and-braces guard; at >=1049px the grid fits. */}
        <div className="hidden overflow-x-auto min-[1049px]:block">
          <div className="min-w-[900px]">
            <div
              className={`${ROW_GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] py-[11px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]`}
            >
              <span>Job</span>
              <span>Status</span>
              <span>Applicants</span>
              <span>Posted</span>
              <span />
            </div>

            {paged.map((job) => {
                const rowVisual = categoryVisual(job.category);
                const tint = getTint(job.id);
                const badge = STATUS_BADGE[job.status];
                const posted = fmtPosted(job.created_at, job.status);

                return (
                  <div
                    key={job.id}
                    // `group` drives both the ⋯ reveal and the icon lift.
                    // `hover:z-[2]` lets the lift shadow sit over the rows
                    // either side of it instead of being clipped by them.
                    className={`${ROW_GRID} group relative border-b border-[var(--ai-line-soft)] py-[15px] transition-[background-color,box-shadow] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-remotiv-purple before:opacity-0 before:transition-opacity before:content-[''] last:border-b-0 hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)] hover:before:opacity-100 ${
                      job.status === "closed" ? "opacity-[0.66]" : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3.5">
                      <span
                        className="flex size-[42px] shrink-0 items-center justify-center rounded-[13px] transition-transform group-hover:scale-105"
                        style={{ background: rowVisual.bg, color: rowVisual.fg }}
                      >
                        <rowVisual.icon className="size-[19px]" strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
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
                      className={`inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${badge.badge}`}
                    >
                      <span className={`size-[5px] rounded-full ${badge.dot}`} />
                      {JOB_STATUS_LABELS[job.status]}
                    </span>

                    {/* Volume, drawn as a share of the busiest role so the
                        column reads as a ranking at a glance. */}
                    <span className="flex min-w-0 items-center gap-[11px]">
                      {job.status === "on_hold" && job.applicant_count === 0 ? (
                        <span className="text-[12.5px] font-semibold italic text-[var(--ai-t4)]">
                          Not posted
                        </span>
                      ) : (
                        <>
                          <span className="w-7 shrink-0 font-heading text-[17px] font-extrabold tracking-[-0.03em] tabular-nums text-[var(--ai-t1)]">
                            {job.applicant_count}
                          </span>
                          <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-[rgba(20,16,32,0.07)]">
                            <span
                              className="block h-full origin-left rounded-[3px]"
                              style={{
                                width: `${
                                  maxApplicants > 0
                                    ? Math.round(
                                        (job.applicant_count / maxApplicants) * 100,
                                      )
                                    : 0
                                }%`,
                                background:
                                  job.status === "open" ? tint.bar : "var(--ai-t4)",
                              }}
                            />
                          </span>
                          {job.id === topJobId && (
                            <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-[2px] text-[10px] font-extrabold uppercase tracking-[0.04em] text-[#2F3A00]">
                              Top role
                            </span>
                          )}
                        </>
                      )}
                    </span>

                    <span className="whitespace-nowrap text-[13px] text-[var(--ai-t2)]">
                      {posted.main}
                      <small className="mt-px block text-[11.5px] text-[var(--ai-t4)]">
                        {posted.sub}
                      </small>
                    </span>

                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(job.id)}
                        aria-label={`Actions for ${job.title}`}
                        aria-haspopup="dialog"
                        // Hidden until the row is hovered, per the mock — but
                        // focus-visible brings it back so it stays reachable
                        // by keyboard.
                        className="flex size-8 items-center justify-center justify-self-end rounded-[9px] text-[var(--ai-t4)] opacity-0 transition-[opacity,background-color,color] hover:bg-[var(--ai-sidebar)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="text-[12.5px] text-[var(--ai-t3)]">
            Published jobs appear on your public careers page at
            remotiv.work/jobs.
          </p>
          <span className="text-[12.5px] font-semibold text-[var(--ai-t2)]">
            <b className="text-remotiv-purple">
              {filtered.length === 0 ? 0 : pageStart + 1}–
              {pageStart + paged.length}
            </b>{" "}
            of {filtered.length}
            {filtered.length !== jobs.length && (
              <span className="text-[var(--ai-t3)]">
                {" "}
                (filtered from {jobs.length})
              </span>
            )}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(Math.max(1, safePage - 1))}
                disabled={safePage <= 1}
                aria-label="Previous page"
                className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="size-4" strokeWidth={2} />
              </button>
              <span className="whitespace-nowrap px-1 text-[12.5px] font-semibold tabular-nums text-[var(--ai-t2)]">
                {safePage} / {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(Math.min(pageCount, safePage + 1))}
                disabled={safePage >= pageCount}
                aria-label="Next page"
                className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronRight className="size-4" strokeWidth={2} />
              </button>
            </div>
          )}
        </div>
      </div>

      {openJob && (
        <JobDrawer
          job={openJob}
          onClose={() => setOpenId(null)}
          onRescoreAll={
            canManage && openJob.applicant_count > 0
              ? () => setConfirm({ job: openJob, kind: "rescore" })
              : null
          }
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
              {/* Re-score spends money but destroys nothing, so it gets the
                  purple treatment rather than the danger red the other two
                  share — the dialog should not read as a warning. */}
              <div
                className={`mb-4 flex size-14 items-center justify-center rounded-full ${
                  confirm.kind === "rescore"
                    ? "bg-[var(--ai-purple-tint)]"
                    : "bg-[var(--ai-danger-tint)]"
                }`}
              >
                {confirm.kind === "rescore" ? (
                  <Sparkles className="size-6 text-remotiv-purple" strokeWidth={2} />
                ) : confirm.kind === "close" ? (
                  <XCircle className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
                ) : (
                  <Trash2 className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
                )}
              </div>
              <h3
                id="confirm-job-title"
                className="font-heading text-lg font-bold text-[var(--ai-t1)]"
              >
                {confirm.kind === "rescore"
                  ? "Re-score all applicants?"
                  : confirm.kind === "close"
                    ? "Close this job?"
                    : "Delete this job?"}
              </h3>
              <p className="mt-2 text-sm text-[var(--ai-t2)]">
                {confirm.kind === "rescore" ? (
                  <>
                    Every one of the{" "}
                    <span className="font-semibold">
                      {confirm.job.applicant_count} applicant
                      {confirm.job.applicant_count === 1 ? "" : "s"}
                    </span>{" "}
                    for <span className="font-semibold">{confirm.job.title}</span> will be
                    re-scored against the job&apos;s current requirements — about{" "}
                    <span className="font-semibold">
                      ${(confirm.job.applicant_count * 0.02).toFixed(2)}
                    </span>{" "}
                    in AI usage. Existing scores stay visible until each new one lands.
                  </>
                ) : confirm.kind === "close" ? (
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
                className={`flex-1 rounded-xl py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
                  confirm.kind === "rescore"
                    ? "bg-remotiv-purple"
                    : "bg-[var(--ai-danger)]"
                }`}
              >
                {busy
                  ? "Working…"
                  : confirm.kind === "rescore"
                    ? "Re-score all"
                    : confirm.kind === "close"
                      ? "Close job"
                      : "Delete"}
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
