"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Composer,
  initialsOf as msgInitials,
} from "@/app/ai-dashboard/(gated)/messages/_composer";
import { fetchApplicationMessages } from "@/app/ai-dashboard/(gated)/messages/actions";
import { InterviewPanel } from "./_interview-panel";
import type {
  ManualTemplate,
  MessageRow as CandidateMessage,
} from "@/app/ai-dashboard/(gated)/messages/types";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Mail,
  Minus,
  Search as SearchIcon,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  SCORE_FEEDBACK_MAX,
  SCORING_OFF_REASON,
  type ApplicantScore,
  type ApplicantScoreDetail,
  type CompanyApplicantRow,
  type PipelineStage,
  type StageHistoryRow,
} from "@/app/ai-dashboard/lib/applicant-types";
import {
  DashboardHero,
  HeroDelta,
} from "@/app/ai-dashboard/_components/dashboard-hero";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { canCreateJobs, type CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import {
  adjustScore,
  clearScoreAdjustment,
  deleteApplication,
  rescoreApplication,
  fetchCompanyApplicant,
  updateApplicationStage,
} from "./actions";

// ── Constants ────────────────────────────────────────────────

/** Mock's `.gridrow`: # / Candidate / Job / CV Score / Stage / Applied / ⋯ */
const GRID =
  "grid grid-cols-[46px_minmax(0,2.1fr)_1.35fr_104px_1fr_0.8fr_40px] items-center gap-[14px] px-5";

/**
 * The funnel and the stage tabs both key off pipeline stage, counted from the
 * same rows the table renders — including any optimistic edit — so a moved
 * candidate can never be in one place in the funnel and another in the list.
 */
const FUNNEL_STEPS: ReadonlyArray<{
  stage: PipelineStage;
  dot: string;
  bar: string;
}> = [
  { stage: "applied", dot: "var(--ai-t4)", bar: "rgba(255,255,255,0.45)" },
  { stage: "screening", dot: "var(--ai-amber-dot)", bar: "#F5A524" },
  { stage: "shortlisted", dot: "#49D7A7", bar: "#49D7A7" },
  { stage: "interview", dot: "#4C8DD9", bar: "#4C8DD9" },
  { stage: "hired", dot: "#D9F972", bar: "#D9F972" },
];

const TAB_STAGES: ReadonlyArray<PipelineStage> = [
  "applied",
  "shortlisted",
  "interview",
  "hired",
];

const STAGE_PILL: Record<PipelineStage, { cls: string; dot: string }> = {
  applied: {
    cls: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]",
    dot: "bg-[var(--ai-t4)]",
  },
  screening: {
    cls: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    dot: "bg-[var(--ai-amber-dot)]",
  },
  shortlisted: {
    cls: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]",
    dot: "bg-remotiv-green",
  },
  interview: {
    cls: "bg-[var(--ai-sky-tint)] text-[var(--ai-sky-ink)]",
    dot: "bg-[#4C8DD9]",
  },
  offer: {
    cls: "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]",
    dot: "bg-remotiv-purple",
  },
  // Hired is the only solid fill.
  hired: {
    cls: "bg-remotiv-green text-[var(--ai-mint-ink)]",
    dot: "bg-[var(--ai-mint-ink)]",
  },
  rejected: {
    cls: "bg-[#FBEAE8] text-[#B02A24]",
    dot: "bg-[#E0524B]",
  },
};

/**
 * A "Top match" chip marks a GENUINE top match, not merely first place.
 *
 * Ranking first in a weak field is not an achievement — before this rule a
 * candidate scoring 12 wore the same lime chip as one scoring 94. The chip now
 * requires an absolute score, so when nobody clears the bar NO chip appears,
 * which is the honest outcome.
 */
const TOP_MATCH_MIN_SCORE = 90;
/** Even in a strong field the chip has to stay scarce to mean anything. */
const TOP_MATCH_MAX_CHIPS = 10;

/** Rows per page, list and cards alike. */
const PAGE_SIZE = 20;

/** "Review top 10" shows this many, best first. */
const TOP_N = 10;

const AVATAR_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  { bg: "var(--ai-mint-tint)", fg: "var(--ai-mint-ink)" },
  { bg: "var(--ai-peach-tint)", fg: "var(--ai-peach-ink)" },
  { bg: "var(--ai-sky-tint)", fg: "var(--ai-sky-ink)" },
  { bg: "var(--ai-amber-tint)", fg: "var(--ai-amber-ink)" },
  { bg: "var(--ai-slate-tint)", fg: "var(--ai-slate-ink)" },
];

// ── Helpers ──────────────────────────────────────────────────

/** Tint derived from a stable hash of the record id, never array position. */
function getTint(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

function initials(first: string, last: string, email: string): string {
  const a = first.trim()[0] ?? "";
  const b = last.trim()[0] ?? "";
  const joined = `${a}${b}`.toUpperCase();
  return joined || email.slice(0, 2).toUpperCase() || "?";
}

function fullName(r: CompanyApplicantRow): string {
  return `${r.first_name} ${r.last_name}`.trim() || r.email.split("@")[0] || "Unknown";
}

function fmtApplied(iso: string): { main: string; sub: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { main: "—", sub: "" };
  const abs = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return { main: "Today", sub: abs };
  if (days === 1) return { main: "1d ago", sub: abs };
  return { main: `${days}d ago`, sub: abs };
}

/** "12 Mar 2026", or null when the timestamp is missing or unparseable. */
function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * " · adjusted by Sara on 12 Mar 2026", or "" when neither is known.
 *
 * Both halves are optional because the optimistic paint deliberately doesn't
 * guess the byline — it renders without one until the refetch supplies it.
 */
function adjustmentByline(detail: ApplicantScoreDetail | null): string {
  if (!detail) return "";
  const when = fmtDay(detail.adjusted_at);
  const who = detail.adjusted_by_name?.trim();
  if (who && when) return ` · adjusted by ${who} on ${when}`;
  if (who) return ` · adjusted by ${who}`;
  if (when) return ` · adjusted on ${when}`;
  return "";
}

/** Pipeline stage for a row — the real column, since Step 2d. */
function stageOf(row: CompanyApplicantRow): PipelineStage {
  return row.pipeline_stage;
}

/**
 * The design system's lime highlight sticker — one keyword per page.
 *
 * Faithful to the mock's `.hl` / `.hl::before`: the sticker is a pseudo-element
 * behind the text, rotated -1.2deg. The `z-0` on the span is load-bearing —
 * it creates a stacking context so the pseudo's negative z-index resolves
 * INSIDE the span rather than dropping behind the page background, which is
 * what makes a bare `-z-10` highlight vanish.
 */
function LimeHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold text-[var(--ai-t1)] before:absolute before:-left-[3px] before:-right-[3px] before:bottom-[8%] before:top-[6%] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
      {children}
    </span>
  );
}

/** RFC-4180 escaping: quote the field and double any embedded quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// ── Score ring (pending state only, until Step 4) ────────────

/**
 * Score ring, per the design system's spec: 38px donut, r=16, stroke-width
 * 3.5, rotated -90deg so it fills clockwise from twelve o'clock.
 * C = 2*pi*16 = 100.53; offset = C * (1 - score/100).
 *
 * Bands are absolute, matching the rubric the model scores against — a 92 is
 * "strong" on every job, which is the entire reason the prompt anchors them.
 */
const RING_C = 2 * Math.PI * 16;

function scoreBand(score: number): { stroke: string; ink: string } {
  if (score >= 80) return { stroke: "#49D7A7", ink: "#04342C" };
  if (score >= 60) return { stroke: "#F5A524", ink: "#7A4E05" };
  return { stroke: "#E0524B", ink: "#B02A24" };
}

/**
 * Distinguishes "the company turned scoring off for this job" from every other
 * skip. Matched on the exact string the handler writes, shared via
 * SCORING_OFF_REASON so neither side carries its own copy of the literal.
 *
 * A row written with an older wording simply falls through to the generic
 * label — an unrecognised reason is a stale label, never a crash.
 */
function isScoringOff(score?: ApplicantScore): boolean {
  return score?.status === "skipped" && score.error === SCORING_OFF_REASON;
}

/** Extracted rather than nested-ternaried inline — four cases, one order. */
function pendingLabel(score?: ApplicantScore): string {
  if (isScoringOff(score)) return "Scoring off";
  if (score?.status === "failed") return "Failed";
  if (score?.status === "skipped") return "No CV text";
  return "Pending";
}

/** The drawer's version of pendingLabel — longer, since it has the room. */
function drawerScoreHeading(score: ApplicantScore): string {
  if (isScoringOff(score)) return "Scoring off for this job";
  if (score.status === "failed") return "Scoring failed";
  if (score.status === "skipped") return "Not scored";
  return "AI score pending";
}

/**
 * No number to show. Covers pending (queued, not yet run), failed and skipped
 * alike — in all three cases the honest answer is that there is no score, and
 * the tooltip carries the specific reason when there is one.
 *
 * Scoring-off gets a different affordance from the other three: a SOLID muted
 * ring with a dash, not the dashed ring and ticking clock. The clock means
 * "waiting" — on a job with scoring off nothing is coming, and a screenful of
 * clocks would read as a queue backlog rather than a setting.
 */
function PendingScore({ score }: { score?: ApplicantScore }) {
  const off = isScoringOff(score);
  return (
    <div className="flex items-center gap-[9px]" title={score?.error ?? undefined}>
      <span
        className={`flex size-[38px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[var(--ai-t4)] ${
          off
            ? "border-[var(--ai-line)] bg-[var(--ai-inset)]"
            : "border-dashed border-[var(--ai-line-strong)]"
        }`}
      >
        {off ? (
          <Minus className="size-4" strokeWidth={2} />
        ) : (
          <Clock className="size-4" strokeWidth={1.8} />
        )}
      </span>
      <span className="text-xs font-semibold text-[var(--ai-t4)]">
        {pendingLabel(score)}
      </span>
    </div>
  );
}

/** The scored state: ring + numeral, with a dot when a human has overridden. */
function ScoreRing({ score }: { score: ApplicantScore }) {
  if (score.status !== "scored" || score.overall == null) {
    return <PendingScore score={score} />;
  }
  const band = scoreBand(score.overall);
  return (
    <div
      className="flex items-center gap-[9px]"
      title={
        score.adjusted
          ? "Adjusted by a member of your team"
          : score.confidence
            ? `AI score · ${score.confidence} confidence`
            : "AI score"
      }
    >
      <span className="relative flex size-[38px] shrink-0 items-center justify-center">
        <svg className="size-[38px] -rotate-90" viewBox="0 0 38 38" aria-hidden>
          <circle
            cx="19"
            cy="19"
            r="16"
            fill="none"
            stroke="rgba(20,16,32,0.08)"
            strokeWidth="3.5"
          />
          <circle
            cx="19"
            cy="19"
            r="16"
            fill="none"
            stroke={band.stroke}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={RING_C.toFixed(2)}
            strokeDashoffset={(RING_C * (1 - score.overall / 100)).toFixed(2)}
          />
        </svg>
        <span
          className="absolute font-heading text-[12.5px] font-extrabold tracking-[-0.03em] tabular-nums"
          style={{ color: band.ink }}
        >
          {score.overall}
        </span>
      </span>
      {score.adjusted && (
        <span className="text-[10px] font-bold uppercase tracking-[0.04em] text-[var(--ai-t3)]">
          Adjusted
        </span>
      )}
    </div>
  );
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const DIMENSION_LABEL: Record<string, string> = {
  requirements_match: "Requirements match",
  experience_depth: "Experience depth",
  domain_relevance: "Domain relevance",
  responsibilities_fit: "Responsibilities fit",
};

/** 74px ring for the drawer hero, on the dark surface. */
function DrawerScoreRing({ score }: { score: number }) {
  const C = 2 * Math.PI * 32;
  const band = scoreBand(score);
  return (
    <span className="relative flex size-[74px] shrink-0 items-center justify-center">
      <svg className="size-[74px] -rotate-90" viewBox="0 0 74 74" aria-hidden>
        <circle cx="37" cy="37" r="32" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="6" />
        <circle
          cx="37"
          cy="37"
          r="32"
          fill="none"
          stroke={band.stroke}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C * (1 - score / 100)).toFixed(2)}
        />
      </svg>
      <span className="absolute font-heading text-[22px] font-extrabold tracking-[-0.03em] tabular-nums text-white">
        {score}
      </span>
    </span>
  );
}

/**
 * The verified CV span, hidden behind a per-item toggle.
 *
 * PER ITEM rather than one switch for the whole card, on purpose. A recruiter
 * checking a scorecard is almost never asking "show me all twelve quotes" —
 * they are asking "is THAT one claim real?", usually the one that decides it.
 * A single card-level toggle answers a question nobody asked and dumps the
 * full wall of prose back on screen, which is the problem being fixed. Per
 * item keeps the default scannable while making any single claim one click
 * from proof, and the open/closed state stays local so opening one does not
 * expand the rest.
 */
function EvidenceQuote({ quote }: { quote: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ai-t3)] transition-colors hover:text-remotiv-purple"
      >
        <ChevronRight
          className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={2.2}
        />
        {open ? "Hide evidence" : "View evidence"}
      </button>
      {open && (
        <p className="m-0 mt-1.5 border-l-2 border-[var(--ai-line-strong)] pl-2.5 text-[12px] italic leading-snug text-[var(--ai-t3)]">
          &ldquo;{quote}&rdquo;
        </p>
      )}
    </div>
  );
}

/**
 * Page controls. Rendered in the panel foot for both the table and the cards,
 * so mobile paginates identically — the card list is the same `paged` slice.
 */
function Pagination({
  page,
  pageCount,
  total,
  grandTotal,
  rangeStart,
  rangeEnd,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  grandTotal: number;
  rangeStart: number;
  rangeEnd: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <span className="whitespace-nowrap text-[12.5px] font-semibold text-[var(--ai-t2)]">
        <b className="text-remotiv-purple">
          {rangeStart}–{rangeEnd}
        </b>{" "}
        of {total}
        {total !== grandTotal && (
          <span className="text-[var(--ai-t3)]"> (filtered from {grandTotal})</span>
        )}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            aria-label="Previous page"
            className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="size-4" strokeWidth={2} />
          </button>
          <span className="whitespace-nowrap px-1 text-[12.5px] font-semibold tabular-nums text-[var(--ai-t2)]">
            {page} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => onPage(Math.min(pageCount, page + 1))}
            disabled={page >= pageCount}
            aria-label="Next page"
            className="flex size-8 items-center justify-center rounded-lg border border-[var(--ai-line)] bg-[var(--ai-surface)] text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="size-4" strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Mobile card ──────────────────────────────────────────────

/**
 * Stacked card shown below the table breakpoint. Same information hierarchy as
 * the desktop row — rank + identity, job, score, stage, applied — just laid
 * out vertically so nothing needs horizontal scrolling. Opens the same drawer.
 */
function ApplicantCard({
  row,
  index,
  isTop,
  selected,
  onOpen,
}: {
  row: CompanyApplicantRow;
  index: number;
  /** Genuine top match — see TOP_MATCH_MIN_SCORE, not "first in the list". */
  isTop: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const tint = getTint(row.id);
  const applied = fmtApplied(row.created_at);
  const stage = stageOf(row);
  const pill = STAGE_PILL[stage];

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative w-full border-b border-[var(--ai-line-soft)] px-4 py-4 text-left transition-colors last:border-b-0 active:bg-[#FCFBFA] ${
        selected ? "bg-[var(--ai-purple-tint)]" : "bg-[var(--ai-surface)]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${
          selected ? "opacity-100" : "opacity-0"
        }`}
      />

      <div className="flex items-start gap-3">
        <span
          className={`mt-[3px] shrink-0 font-heading text-sm font-extrabold tabular-nums tracking-[-0.02em] ${
            isTop ? "text-[var(--ai-purple-ink)]" : "text-[var(--ai-t4)]"
          }`}
        >
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
          style={{
            background: tint.bg,
            color: tint.fg,
            boxShadow: isTop
              ? "0 0 0 2px var(--ai-surface), 0 0 0 3.5px #49D7A7"
              : "0 0 0 2px var(--ai-surface), 0 0 0 3.5px rgba(20,16,32,0.07)",
          }}
        >
          {initials(row.first_name, row.last_name, row.email)}
        </span>
        <div className="min-w-0 flex-1">
          {/* Same nested-span truncation as the table: the name row is a flex
              container, so overflow must live on the INNER span or the
              Top-match chip clips. */}
          <p className="m-0 flex min-w-0 items-center gap-2 text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
            <span className="min-w-0 truncate">{fullName(row)}</span>
            {isTop && (
              <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                Top match
              </span>
            )}
          </p>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
            {row.email}
          </p>
        </div>
      </div>

      <div className="mt-3 flex">
        <span className="max-w-full truncate rounded-lg border border-[var(--ai-line-soft)] bg-[var(--ai-inset)] px-2.5 py-[5px] text-[12.5px] font-semibold text-[var(--ai-t2)]">
          {row.job_title}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <ScoreRing score={row.score} />
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${pill.cls}`}
        >
          <span className={`size-[5px] shrink-0 rounded-full ${pill.dot}`} />
          {PIPELINE_STAGE_LABELS[stage]}
        </span>
      </div>

      <p className="m-0 mt-3 text-[11.5px] text-[var(--ai-t4)]">
        Applied {applied.main}
        {applied.sub && ` · ${applied.sub}`}
      </p>
    </button>
  );
}

const ADJ_BTN =
  "rounded-[9px] px-3 py-[7px] text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const ADJ_BTN_PRIMARY = `${ADJ_BTN} bg-remotiv-purple text-white hover:bg-[#6d38ec]`;
const ADJ_BTN_QUIET = `${ADJ_BTN} border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] text-[var(--ai-t2)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]`;

/**
 * Human correction of an AI score.
 *
 * Available on ANY row that has a score record, including failed and skipped
 * ones — "the model couldn't read this CV but I did, and it's a 78" is a real
 * and useful judgement, and the server contract is the same either way.
 *
 * The note is optional but pushed hard in the copy: two numbers say the model
 * was wrong, only the note says why, and why is the part a readout can never
 * reconstruct after the fact.
 */
function ScoreAdjuster({
  detail,
  saving,
  onSave,
  onClear,
}: {
  detail: ApplicantScoreDetail;
  saving: boolean;
  onSave: (score: number, feedback: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function begin() {
    // Seeded from whatever is showing now, so a small correction is a small
    // edit rather than a retype.
    setValue(String(detail.overall ?? detail.ai_overall ?? 50));
    setNote(detail.human_feedback ?? "");
    setError(null);
    setEditing(true);
  }

  function commit() {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a whole number from 0 to 100.");
      return;
    }
    setEditing(false);
    onSave(parsed, note);
  }

  if (!editing) {
    return (
      <div className="mt-[22px] rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-3.5">
        {detail.adjusted ? (
          <>
            <p className="m-0 text-[13px] font-semibold text-[var(--ai-t1)]">
              Adjusted to {detail.overall} from the AI&apos;s{" "}
              {detail.ai_overall ?? "—"}
              <span className="font-normal text-[var(--ai-t3)]">
                {adjustmentByline(detail)}
              </span>
            </p>
            {detail.human_feedback && (
              <p className="m-0 mt-2 border-l-2 border-[var(--ai-line-strong)] pl-2.5 text-[13px] italic leading-relaxed text-[var(--ai-t2)]">
                {detail.human_feedback}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={begin} disabled={saving} className={ADJ_BTN_QUIET}>
                Edit adjustment
              </button>
              <button type="button" onClick={onClear} disabled={saving} className={ADJ_BTN_QUIET}>
                Revert to AI score
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-[13px] font-semibold text-[var(--ai-t1)]">
              Disagree with this score?
            </p>
            <p className="m-0 mt-1 text-xs leading-relaxed text-[var(--ai-t3)]">
              Corrections are how we find out where the AI reads candidates too
              high or too low. The AI&apos;s own score is always kept.
            </p>
            <button
              type="button"
              onClick={begin}
              disabled={saving}
              className={`${ADJ_BTN_PRIMARY} mt-3`}
            >
              Adjust score
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-[22px] rounded-[13px] border border-remotiv-purple bg-[var(--ai-purple-tint)] px-4 py-3.5">
      <DrawerLabel>Your score</DrawerLabel>
      <div className="mt-1.5 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Number.parseInt(value, 10) || 0}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Adjusted score"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-remotiv-purple"
        />
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Adjusted score value"
          className="w-[72px] shrink-0 rounded-[9px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-2.5 py-2 text-center text-sm font-bold tabular-nums text-[var(--ai-t1)] outline-none focus:border-remotiv-purple"
        />
      </div>
      {detail.ai_overall != null && (
        <p className="m-0 mt-1.5 text-xs text-[var(--ai-t3)]">
          The AI scored {detail.ai_overall}.
        </p>
      )}

      <div className="mt-3">
        <DrawerLabel>Why was the AI wrong?</DrawerLabel>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={SCORE_FEEDBACK_MAX}
          placeholder="Optional, but this is the part that teaches us something — e.g. “Undervalued 6 years of agency work because the CV lists clients, not employers.”"
          className="mt-1.5 min-h-20 w-full resize-y rounded-[9px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-2.5 py-2 text-[13px] leading-relaxed text-[var(--ai-t1)] outline-none focus:border-remotiv-purple"
        />
      </div>

      {error && <p className="m-0 mt-2 text-xs text-[#C4362F]">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={commit} disabled={saving} className={ADJ_BTN_PRIMARY}>
          {saving ? "Saving…" : "Save adjustment"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          className={ADJ_BTN_QUIET}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Drawer ───────────────────────────────────────────────────

function ApplicantDrawer({
  row,
  history,
  scoreDetail,
  historyLoading,
  messages,
  messagesLoading,
  saving,
  scoreSaving,
  canRescore,
  rescoring,
  onRescore,
  onEmail,
  onToast,
  onClose,
  onStageChange,
  onAdjustScore,
  onClearAdjustment,
  onDelete,
}: {
  row: CompanyApplicantRow;
  history: StageHistoryRow[];
  scoreDetail: ApplicantScoreDetail | null;
  historyLoading: boolean;
  messages: CandidateMessage[];
  messagesLoading: boolean;
  saving: boolean;
  scoreSaving: boolean;
  canRescore: boolean;
  rescoring: boolean;
  onRescore: () => void;
  onEmail: () => void;
  onToast: (message: string) => void;
  onClose: () => void;
  onStageChange: (next: PipelineStage) => void;
  onAdjustScore: (score: number, feedback: string) => void;
  onClearAdjustment: () => void;
  onDelete: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tint = getTint(row.id);
  const name = fullName(row);
  const applied = fmtApplied(row.created_at);
  const stage = stageOf(row);

  // Escape closes, body scroll locks, focus moves into the panel — the same
  // mechanics as the shipped jobs drawer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  /**
   * The drawer's authoritative score.
   *
   * `row` comes from the list, which was fetched when the page rendered — an
   * applicant scored since then still reads 'pending' there. `scoreDetail` is
   * fetched when this drawer opens, so it wins whenever it exists. Using
   * row.score here is what made the header say "pending" while the breakdown
   * directly below it showed a full scorecard.
   */
  const headerScore: ApplicantScore = scoreDetail ?? row.score;

  const location = [row.city, row.country].filter(Boolean).join(", ");

  /**
   * Experience as display text, or null when unknown.
   *
   * Compared against null rather than tested for truthiness on purpose: 0 is a
   * real answer ("0 years"), and `row.years_experience && …` would silently
   * treat a genuine zero as missing.
   */
  const experienceText =
    row.years_experience === null
      ? null
      : `${row.years_experience} year${row.years_experience === 1 ? "" : "s"}`;

  /**
   * The public apply form has never collected city, country or years of
   * experience, and collected notice period and availability only from today
   * — so for most applications several of these are null and always will be.
   * Rendering them as permanent em-dashes made the drawer look broken rather
   * than empty, so each row appears only when it has a value, and the whole
   * section is dropped when none do.
   */
  const hasDetails = Boolean(
    location ||
      experienceText ||
      row.notice_period ||
      row.availability ||
      row.phone ||
      row.linkedin_url,
  );

  return (
    <>
      <button
        type="button"
        aria-label="Close applicant"
        onClick={onClose}
        className="fixed inset-0 z-[90] cursor-default bg-[rgba(20,16,32,0.42)] backdrop-blur-[4px]"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${name} — applicant detail`}
        // var(--vh-full), not h-screen: vh resolves against the UNZOOMED
        // viewport inside .ai-shell and would render 18% short.
        className="fixed right-0 top-0 z-[95] flex h-[var(--vh-full)] w-full max-w-[452px] flex-col bg-[var(--ai-surface)] shadow-[-24px_0_70px_rgba(20,16,32,0.24)] outline-none"
      >
        {/* Dark hero — every <p> here carries an explicit colour, because the
            design system's global `p { color:#444 }` beats inherited white. */}
        <div className="shrink-0 bg-[var(--ai-sidebar)] px-[22px] pb-5 pt-[22px]">
          <div className="mb-[18px] flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-[13px]">
              <span
                className="flex size-[50px] shrink-0 items-center justify-center rounded-full text-base font-bold"
                style={{ background: tint.bg, color: tint.fg }}
              >
                {initials(row.first_name, row.last_name, row.email)}
              </span>
              <div className="min-w-0">
                <p className="m-0 truncate font-heading text-[19px] font-extrabold leading-[1.15] tracking-[-0.028em] text-white">
                  {name}
                </p>
                <p className="mt-1 truncate text-[12.5px] text-white/55">
                  {row.email}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.16] bg-white/[0.07] text-white/75 transition-colors hover:bg-white/[0.16] hover:text-white"
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          </div>

          {/* Score headline. Every <p> on this dark surface sets its own
              colour — the DS's global `p { color:#444 }` beats inheritance.
              Reads `headerScore`, NOT row.score: the list row was fetched when
              the page loaded and goes stale the moment the worker scores
              someone, which is the normal case. */}
          {headerScore.status === "scored" && headerScore.overall != null ? (
            <div className="flex items-center gap-4 rounded-2xl border border-white/[0.14] bg-white/[0.06] px-4 py-[15px]">
              <DrawerScoreRing score={headerScore.overall} />
              <div className="min-w-0">
                <p className="m-0 text-[13px] font-bold text-white">
                  {headerScore.adjusted ? "Adjusted score" : "AI score"}
                  {/* NOT "completed": screening_score is the weighted share of
                      thresholds MET (computeScreeningScore counts a.matched),
                      so someone who answered everything but met nothing scores
                      0%, not 100%. Labelled for what it measures, and tagged
                      self-reported like the answers themselves. */}
                  {scoreDetail?.screening_score != null && (
                    <span className="ml-2 font-normal text-white/55">
                      Self-reported thresholds met:{" "}
                      {scoreDetail.screening_score}%
                    </span>
                  )}
                </p>
                {/* The verdict is the headline a recruiter reads first, so it
                    sits directly under the score and above the confidence
                    note. v1-v3 scorecards predate it and simply have none —
                    the line is omitted rather than filled with a guess. */}
                {scoreDetail?.verdict ? (
                  <p className="m-0 mt-1.5 text-[13.5px] font-semibold leading-snug text-white">
                    {scoreDetail.verdict}
                  </p>
                ) : null}
                {/* When a human has overridden, the AI's own number stays on
                    screen right beside theirs. Hiding it would leave nothing
                    to calibrate against — the pair, and the gap between them,
                    is the entire signal this feature exists to collect. */}
                {headerScore.adjusted && headerScore.ai_overall != null ? (
                  <p className="m-0 mt-1.5 text-xs leading-relaxed text-white/55">
                    <span className="font-semibold text-white/80">
                      AI scored {headerScore.ai_overall}
                    </span>
                    {adjustmentByline(scoreDetail)}
                  </p>
                ) : (
                  <p className="m-0 mt-1 text-xs leading-relaxed text-white/55">
                    {headerScore.confidence
                      ? `${CONFIDENCE_LABEL[headerScore.confidence]} — based on how much the CV actually showed.`
                      : "Scored against this job's stated requirements."}
                  </p>
                )}
              </div>
            </div>
          ) : (
            /* Solid border for scoring-off, dashed for the rest — same
               reasoning as PendingScore: dashed reads as "in progress", and
               nothing is in progress on a job with scoring turned off. */
            <div
              className={`rounded-2xl border bg-white/[0.06] px-4 py-[15px] text-center ${
                isScoringOff(headerScore)
                  ? "border-white/[0.14]"
                  : "border-dashed border-white/20"
              }`}
            >
              <b className="mb-[3px] block text-[13px] text-white">
                {drawerScoreHeading(headerScore)}
              </b>
              <span className="text-xs leading-relaxed text-white/50">
                {headerScore.error ??
                  "The breakdown appears here once this CV has been scored."}
              </span>
            </div>
          )}
        </div>

        {/* Light body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-7 pt-[18px]">
          <p className="mb-3.5 text-[13px] leading-relaxed text-[var(--ai-t3)]">
            Applied to{" "}
            <b className="font-bold text-[var(--ai-t1)]">{row.job_title}</b> ·{" "}
            {applied.main}
          </p>

          <div className="mb-[22px] flex gap-[9px]">
            {/* A real anchor, not window.open from an async handler — Safari
                blocks the latter. The route signs and 302-redirects. */}
            <a
              href={`/api/cv/company-application/${row.id}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!row.has_cv}
              onClick={(e) => {
                if (!row.has_cv) e.preventDefault();
              }}
              className={`flex flex-1 items-center justify-center gap-[7px] rounded-xl px-3 py-[11px] text-[13px] font-bold transition-colors ${
                row.has_cv
                  ? "bg-remotiv-purple text-white shadow-[0_6px_18px_rgba(126,71,255,0.3)] hover:bg-[var(--ai-purple-hover)]"
                  : "cursor-not-allowed bg-[var(--ai-inset)] text-[var(--ai-t4)]"
              }`}
            >
              <FileText className="size-[15px]" strokeWidth={1.9} />
              {row.has_cv ? "Open CV" : "No CV"}
            </a>
            {/* Opens the composer rather than handing off to the OS mail
                client. A mailto: sends from the recruiter's own address, which
                is the one thing the identity block exists to prevent — and it
                leaves no record on the applicant. */}
            <button
              type="button"
              onClick={onEmail}
              className="flex flex-1 items-center justify-center gap-[7px] rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[11px] text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
            >
              <Mail className="size-[15px]" strokeWidth={1.9} />
              Email
            </button>
          </div>

          <DrawerLabel>Pipeline stage</DrawerLabel>
          {/* `value` is driven by the optimistic row, so the select shows the
              new stage immediately and snaps back if the write is rejected. */}
          <select
            value={stage}
            disabled={saving}
            onChange={(e) => onStageChange(e.target.value as PipelineStage)}
            aria-label="Pipeline stage"
            className="mb-[22px] w-full cursor-pointer appearance-none rounded-xl border-[1.5px] border-[var(--ai-line-strong)] bg-[var(--ai-surface)] py-3 pl-3.5 pr-[34px] text-sm font-bold text-[var(--ai-t1)] transition-colors hover:border-remotiv-purple focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.16] disabled:cursor-wait disabled:opacity-70"
          >
            {PIPELINE_STAGES.map((s) => (
              <option key={s} value={s}>
                {PIPELINE_STAGE_LABELS[s]}
              </option>
            ))}
          </select>

          {row.screening_answers.length > 0 && (
            <>
              <DrawerLabel>Screening answers</DrawerLabel>
              {/* Provenance stated ONCE here rather than repeated on every
                  pill. The pills then stay short enough to sit inline beside
                  the answer, and this line can say the thing a pill never
                  could — that nobody verified any of it. */}
              <p className="m-0 mb-2.5 text-[11.5px] leading-snug text-[var(--ai-t3)]">
                Answered by the candidate at apply time and checked against the
                thresholds you set. Self-reported — not verified by Remotiv.
              </p>
              <div className="mb-[22px] flex flex-col gap-[9px]">
                {row.screening_answers.map((a) => (
                  <div
                    key={a.question_id}
                    className="rounded-xl border border-[var(--ai-line)] px-[13px] py-[11px] transition-colors hover:border-[var(--ai-line-strong)] hover:bg-[var(--ai-inset)]"
                  >
                    <p className="mb-1.5 text-xs leading-snug text-[var(--ai-t3)]">
                      {a.question}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--ai-t1)]">
                      {a.answer_label || a.answer || "—"}
                      {/* The snapshot's own `matched` flag, scored at apply
                          time — never re-derived here.

                          Deliberately NOT green. A mint success pill reads as
                          "Remotiv verified this", and nobody did: it is the
                          candidate's own number compared to the employer's
                          threshold. Neutral slate for met, muted amber for
                          below — distinguishable, but neither endorses.

                          NO pill at all when `scored` is false: the employer
                          asked for the number without setting a threshold, so
                          there was nothing to pass or fail. `matched` is false
                          on those rows and would render "Below threshold",
                          which is not a weaker claim than the truth — it is a
                          different and wrong one. Absent on every snapshot
                          written before the mode existed, so `!== false` keeps
                          those rendering exactly as they always did. */}
                      {a.scored !== false && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-[2.5px] text-[10.5px] font-semibold ${
                            a.matched
                              ? "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]"
                              : "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]"
                          }`}
                        >
                          {a.matched ? "Meets threshold" : "Below threshold"}
                        </span>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}

          {scoreDetail && scoreDetail.status === "scored" && (
            <>
              {scoreDetail.summary && (
                <>
                  <DrawerLabel>Summary</DrawerLabel>
                  <p className="mb-[22px] text-[13px] leading-relaxed text-[var(--ai-t2)]">
                    {scoreDetail.summary}
                  </p>
                </>
              )}

              {scoreDetail.dimensions.length > 0 && (
                <>
                  <DrawerLabel>Score breakdown</DrawerLabel>
                  <div className="mb-[22px] flex flex-col gap-3">
                    {scoreDetail.dimensions.map((d) => {
                      const band = scoreBand(d.score);
                      return (
                        <div key={d.dimension}>
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[13px] font-bold text-[var(--ai-t1)]">
                              {DIMENSION_LABEL[d.dimension] ?? d.dimension}
                            </span>
                            <span
                              className="font-heading text-[13px] font-extrabold tabular-nums"
                              style={{ color: band.ink }}
                            >
                              {d.score}
                            </span>
                          </div>
                          <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-[rgba(20,16,32,0.07)]">
                            <div
                              className="h-full rounded-[3px]"
                              style={{
                                width: `${d.score}%`,
                                background: band.stroke,
                              }}
                            />
                          </div>
                          {d.reasoning && (
                            <p className="m-0 mt-1.5 text-[12px] leading-snug text-[var(--ai-t3)]">
                              {d.reasoning}
                            </p>
                          )}
                          {d.quote && <EvidenceQuote quote={d.quote} />}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {scoreDetail.strengths.length > 0 && (
                <>
                  <DrawerLabel>Strengths</DrawerLabel>
                  <div className="mb-[22px] flex flex-col gap-2.5">
                    {/* Each strength carries its own quote — no pairing by
                        position, which is what misattributed quotes in v1. */}
                    {scoreDetail.strengths.map((str) => (
                      <div key={str.point}>
                        <p className="m-0 flex gap-2 text-[13px] leading-snug text-[var(--ai-t2)]">
                          <Check
                            className="mt-px size-3.5 shrink-0 text-remotiv-green"
                            strokeWidth={2.6}
                          />
                          {str.point}
                        </p>
                        {str.quote && <EvidenceQuote quote={str.quote} />}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {scoreDetail.missing_requirements.length > 0 && (
                <>
                  <DrawerLabel>Missing requirements</DrawerLabel>
                  <div className="mb-[22px] flex flex-col gap-2">
                    {scoreDetail.missing_requirements.map((m) => (
                      <p
                        key={m}
                        className="m-0 flex gap-2 text-[13px] leading-snug text-[var(--ai-t2)]"
                      >
                        <span
                          aria-hidden
                          className="mt-[7px] h-px w-2.5 shrink-0 bg-[var(--ai-t4)]"
                        />
                        {m}
                      </p>
                    ))}
                  </div>
                </>
              )}

              {scoreDetail.concerns.length > 0 && (
                <>
                  <DrawerLabel>Risks / points to verify</DrawerLabel>
                  <div className="mb-[22px] flex flex-col gap-2">
                    {scoreDetail.concerns.map((c) => (
                      <p
                        key={c}
                        className="m-0 text-[13px] leading-snug text-[var(--ai-t2)]"
                      >
                        {c}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* Staleness + re-score, ABOVE the adjuster: if the card was judged
              against criteria that have since changed, that has to be known
              before anyone reads the breakdown or corrects the number. The
              action sits in the banner rather than in a menu because the flag
              and its remedy are the same thought. */}
          {scoreDetail?.stale && (
            <div className="mt-[22px] rounded-[13px] border border-[var(--ai-amber-dot)] bg-[var(--ai-amber-tint)] px-4 py-3.5">
              <p className="m-0 text-[13px] font-semibold text-[var(--ai-amber-ink)]">
                Scored against older criteria
              </p>
              <p className="m-0 mt-1 text-xs leading-relaxed text-[var(--ai-amber-ink)]">
                This job&apos;s requirements or screening questions have changed
                since this CV was scored, so the numbers below were judged
                against a different brief.
              </p>
              {canRescore && (
                <button
                  type="button"
                  onClick={onRescore}
                  disabled={rescoring}
                  className={`${ADJ_BTN_PRIMARY} mt-3`}
                >
                  {rescoring ? "Queueing…" : "Re-score this applicant"}
                </button>
              )}
            </div>
          )}

          {/* Re-score is also available when the card is current — a recruiter
              may simply want a second read. Hidden when the banner above is
              already showing it, so the action never appears twice. */}
          {scoreDetail && !scoreDetail.stale && canRescore && (
            <div className="mt-[22px] flex items-center justify-between gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-3">
              <p className="m-0 text-xs leading-relaxed text-[var(--ai-t3)]">
                Re-run the AI on this CV — costs about two cents.
              </p>
              <button
                type="button"
                onClick={onRescore}
                disabled={rescoring}
                className={`${ADJ_BTN_QUIET} shrink-0`}
              >
                {rescoring ? "Queueing…" : "Re-score"}
              </button>
            </div>
          )}

          {/* Sits after the breakdown on purpose: a reviewer should read what
              the model concluded before overriding it. Rendered for any score
              row, not just 'scored' — see ScoreAdjuster. */}
          {scoreDetail && (
            <ScoreAdjuster
              detail={scoreDetail}
              saving={scoreSaving}
              onSave={onAdjustScore}
              onClear={onClearAdjustment}
            />
          )}

          {/* Each row is conditional, so `last:border-b-0` lands on whichever
              row actually renders last — a `{cond && …}` that resolves false
              produces no DOM node, so :last-child stays correct. */}
          {hasDetails && (
            <>
              <DrawerLabel>Details</DrawerLabel>
              <div className="mb-[22px] flex flex-col">
                {location && <DetailRow label="Location" value={location} />}
                {experienceText && (
                  <DetailRow label="Experience" value={experienceText} />
                )}
                {row.notice_period && (
                  <DetailRow label="Notice period" value={row.notice_period} />
                )}
                {row.availability && (
                  <DetailRow label="Availability" value={row.availability} />
                )}
                {row.phone && <DetailRow label="Phone" value={row.phone} />}
                {row.linkedin_url && (
                  <div className="flex items-center justify-between border-b border-[var(--ai-line-soft)] py-[9px] text-[13.5px] last:border-b-0">
                    <span className="text-[var(--ai-t3)]">LinkedIn</span>
                    <a
                      href={row.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-bold text-remotiv-purple hover:underline"
                    >
                      Profile
                      <ExternalLink className="size-3" strokeWidth={2} />
                    </a>
                  </div>
                )}
              </div>
            </>
          )}

          <DrawerLabel>Messages</DrawerLabel>
          <div className="mb-[22px] flex flex-col gap-2.5">
            {messagesLoading && messages.length === 0 && (
              <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
            )}
            {!messagesLoading && messages.length === 0 && (
              <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">
                No messages sent yet.
              </p>
            )}
            {messages.map((m) => (
              <MessageEntry key={m.id} message={m} />
            ))}
          </div>

          <DrawerLabel>Video interview</DrawerLabel>
          <div className="mb-[22px]">
            <InterviewPanel applicationId={row.id} onToast={onToast} />
          </div>

          <DrawerLabel>Stage history</DrawerLabel>
          <div className="flex flex-col gap-[14px]">
            {history.map((h) => {
              const when = fmtApplied(h.created_at);
              // The seeded first entry has no from_stage — it reads as plain
              // "Applied" rather than an arrow from nowhere.
              const meta = [h.changed_by_name, when.main]
                .filter(Boolean)
                .join(" · ");
              return (
                <div key={h.id} className="relative flex items-start gap-3">
                  <span
                    className={`z-[1] mt-[3px] size-[11px] shrink-0 rounded-full shadow-[0_0_0_3px_var(--ai-surface),0_0_0_4.5px_rgba(20,16,32,0.1)] ${STAGE_PILL[h.to_stage].dot}`}
                  />
                  <div className="min-w-0">
                    <p className="m-0 text-[13.5px] font-bold leading-tight text-[var(--ai-t1)]">
                      {h.from_stage
                        ? `${PIPELINE_STAGE_LABELS[h.from_stage]} → ${PIPELINE_STAGE_LABELS[h.to_stage]}`
                        : PIPELINE_STAGE_LABELS[h.to_stage]}
                    </p>
                    {h.note && (
                      <p className="m-0 mt-[3px] text-[12px] leading-snug text-[var(--ai-t2)]">
                        {h.note}
                      </p>
                    )}
                    <small className="mt-[3px] block text-[11.5px] text-[var(--ai-t3)]">
                      {meta || when.sub}
                    </small>
                  </div>
                </div>
              );
            })}

            {/* Falls back to the application itself: rows created before the
                history table existed have nothing seeded. */}
            {!historyLoading && history.length === 0 && (
              <div className="relative flex items-start gap-3">
                <span className="z-[1] mt-[3px] size-[11px] shrink-0 rounded-full bg-[var(--ai-t4)] shadow-[0_0_0_3px_var(--ai-surface),0_0_0_4.5px_rgba(20,16,32,0.1)]" />
                <div>
                  <p className="m-0 text-[13.5px] font-bold leading-tight text-[var(--ai-t1)]">
                    Applied
                  </p>
                  <small className="mt-[3px] block text-[11.5px] text-[var(--ai-t3)]">
                    {applied.main} · {applied.sub}
                  </small>
                </div>
              </div>
            )}

            {historyLoading && history.length === 0 && (
              <div className="h-[11px] w-2/3 animate-pulse rounded-full bg-[var(--ai-inset)]" />
            )}
          </div>

          {/* Danger, last and visually separated — same placement and weight
              as the jobs drawer's. Opens a confirm rather than deleting on
              click; this is irreversible and takes the CV with it. */}
          <div className="mt-7 border-t border-[var(--ai-line)] pt-5">
            <DrawerLabel>Danger</DrawerLabel>
            <button
              type="button"
              onClick={onDelete}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ai-danger-tint)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-danger)] transition-opacity hover:opacity-80"
            >
              <Trash2 className="size-3.5" strokeWidth={2} />
              Delete applicant
            </button>
            <p className="m-0 mt-2 text-[10px] leading-relaxed text-[var(--ai-t4)]">
              Permanently removes this applicant, their CV file, their AI
              scorecard and their pipeline history. This cannot be undone.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One line of the drawer's message trail.
 *
 * The left border carries the distinction before any text is read: a solid
 * heavy rule for something a person wrote, a lighter one for an automatic
 * message, a dashed amber one for something still scheduled.
 */
function MessageEntry({ message }: { message: CandidateMessage }) {
  const automatic = message.kind === "automatic";
  const scheduled = message.kind === "scheduled";
  const failed = message.kind === "failed";

  const border = scheduled
    ? "border-l-[2.5px] border-dashed border-l-[var(--ai-amber-dot)]"
    : automatic
      ? "border-l-[2.5px] border-solid border-l-[var(--ai-line)]"
      : "border-l-[2.5px] border-solid border-l-[var(--ai-line-strong)] hover:border-l-remotiv-purple";

  const when = message.kind === "scheduled" ? message.scheduledFor : message.sentAt;

  return (
    <div className={`py-px pl-3 transition-colors ${border}`}>
      <p
        className={`m-0 text-[13.5px] leading-snug ${
          automatic || scheduled
            ? "font-medium text-[var(--ai-t2)]"
            : "font-bold text-[var(--ai-t1)]"
        }`}
      >
        {message.subject || "(no subject)"}
      </p>
      <small
        className={`mt-[3px] flex items-center gap-[7px] text-[11.5px] ${
          automatic ? "text-[var(--ai-t4)]" : "text-[var(--ai-t3)]"
        }`}
      >
        {scheduled && (
          <span className="shrink-0 rounded-[5px] bg-[var(--ai-amber-tint)] px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-amber-ink)]">
            Scheduled
          </span>
        )}
        {automatic && (
          <span className="shrink-0 rounded-[5px] bg-[var(--ai-slate-tint)] px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-slate-ink)]">
            Automatic
          </span>
        )}
        {failed && (
          <span className="shrink-0 rounded-[5px] bg-[var(--ai-danger-tint)] px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-danger)]">
            Failed
          </span>
        )}
        {message.sentByName && (
          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ai-t2)]">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--ai-mint-tint)] text-[8.5px] font-extrabold text-[var(--ai-mint-ink)]">
              {msgInitials(message.sentByName)}
            </span>
            {message.sentByName}
          </span>
        )}
        {fmtMessageWhen(when ?? message.createdAt)}
      </small>
    </div>
  );
}

/** Short relative stamp for the drawer's message trail. */
function fmtMessageWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const unit = hours < 24 ? `${hours}h` : `${days} day${days === 1 ? "" : "s"}`;
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

function DrawerLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 mb-[9px] flex items-center gap-[9px] text-[10.5px] font-bold uppercase tracking-[0.1em] text-[var(--ai-t3)] after:h-px after:flex-1 after:bg-[var(--ai-line)] after:content-['']">
      {children}
    </p>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--ai-line-soft)] py-[9px] text-[13.5px]">
      <span className="text-[var(--ai-t3)]">{label}</span>
      <b className="font-bold text-[var(--ai-t1)]">{value}</b>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────

export function ApplicantsClient({
  viewerRole,
  applicants: initialApplicants,
  newThisWeek,
  openRoles,
  companyName,
  replyToAddress,
  manualTemplates,
  unassigned,
}: {
  viewerRole: CompanyRole;
  applicants: CompanyApplicantRow[];
  newThisWeek: number;
  openRoles: number;
  companyName: string;
  replyToAddress: string | null;
  manualTemplates: ManualTemplate[];
  /** True for a scoped member on no hiring teams — see the empty state. */
  unassigned: boolean;
}) {
  // Same predicate the server action enforces (owner / admin / recruiter).
  // Hiring managers review candidates but do not spend the company's scoring
  // budget — rescoreApplication would reject them anyway; this stops the UI
  // offering a button that can only fail.
  const canRescore = canCreateJobs(viewerRole);
  const router = useRouter();

  // Local copy so a delete can drop the row immediately. Re-synced whenever
  // the server sends a fresh list, the same pattern the jobs list uses.
  const [applicants, setApplicants] =
    useState<CompanyApplicantRow[]>(initialApplicants);
  useEffect(() => {
    setApplicants(initialApplicants);
  }, [initialApplicants]);

  const [tab, setTab] = useState<"all" | PipelineStage>("all");
  const [jobFilter, setJobFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  /** "Review top 10" — a view mode over the same filtered set, not a filter. */
  const [topOnly, setTopOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<CompanyApplicantRow | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** The open applicant's message trail, and the composer over it. */
  const [messages, setMessages] = useState<CandidateMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  /**
   * Optimistic stage edits, keyed by application id, layered over the
   * server-rendered rows. One overlay feeds the funnel, the tab counts, the
   * table, the mobile cards and the drawer at once, so they cannot disagree —
   * and reverting is just deleting the key. Entries are harmless once the
   * revalidated server data catches up: they then hold the same value.
   */
  const [stageOverrides, setStageOverrides] = useState<
    Record<string, PipelineStage>
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [history, setHistory] = useState<StageHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [scoreDetail, setScoreDetail] = useState<ApplicantScoreDetail | null>(null);
  const [scoreSaving, setScoreSaving] = useState(false);
  /** Same optimistic-override trick as stageOverrides, for the list's ring. */
  const [scoreOverrides, setScoreOverrides] = useState<
    Record<string, ApplicantScore>
  >({});

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = useMemo(
    () =>
      applicants.map((r) => {
        const stage =
          stageOverrides[r.id] && stageOverrides[r.id] !== r.pipeline_stage
            ? stageOverrides[r.id]
            : r.pipeline_stage;
        const score = scoreOverrides[r.id] ?? r.score;
        if (stage === r.pipeline_stage && score === r.score) return r;
        return { ...r, pipeline_stage: stage, score };
      }),
    [applicants, stageOverrides, scoreOverrides],
  );

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of PIPELINE_STAGES) counts[s] = 0;
    for (const r of rows) counts[stageOf(r)] += 1;
    return counts;
  }, [rows]);

  /** Distinct jobs present in the result set — no extra query needed. */
  const jobOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.job_id && !seen.has(r.job_id)) seen.set(r.job_id, r.job_title);
    }
    return [...seen.entries()];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (tab !== "all" && stageOf(r) !== tab) return false;
        if (jobFilter !== "all" && r.job_id !== jobFilter) return false;
        if (q) {
          const blob = `${fullName(r)} ${r.email}`.toLowerCase();
          if (!blob.includes(q)) return false;
        }
        return true;
      })
      // Ranking IS the feature: score desc, unscored last, then newest first
      // among equals. `overall` is the human override when one exists.
      .sort((a, b) => {
        const sa = a.score.status === "scored" ? a.score.overall : null;
        const sb = b.score.status === "scored" ? b.score.overall : null;
        if (sa !== null && sb !== null) return sb - sa;
        if (sa !== null) return -1;
        if (sb !== null) return 1;
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      });
  }, [rows, tab, jobFilter, search]);

  /**
   * The ids wearing a "Top match" chip: scored >= 90, best first, capped.
   * Computed over the WHOLE result set rather than the current page so a
   * candidate doesn't gain or lose the chip by being paginated.
   */
  const topMatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of filtered) {
      if (ids.size >= TOP_MATCH_MAX_CHIPS) break;
      if (r.score.status === "scored" && (r.score.overall ?? 0) >= TOP_MATCH_MIN_SCORE) {
        ids.add(r.id);
      }
    }
    return ids;
  }, [filtered]);

  /** Scored candidates only — "top 10" of a pending list would be arbitrary. */
  const topTen = useMemo(
    () => filtered.filter((r) => r.score.status === "scored").slice(0, TOP_N),
    [filtered],
  );

  /** What the list actually renders before paging. */
  const visible = topOnly ? topTen : filtered;

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamp rather than reset: deleting the last row of the last page should
  // land on the new last page, not throw the user back to page 1.
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const paged = visible.slice(pageStart, pageStart + PAGE_SIZE);

  // Any change to what is being filtered resets to the first page — staying on
  // page 4 of a result set that now has one page shows an empty list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on filter change, not on page change
  useEffect(() => {
    setPage(1);
  }, [tab, jobFilter, search, topOnly]);

  const openRow = openId ? (rows.find((r) => r.id === openId) ?? null) : null;

  /**
   * Permanent delete. Optimistic: the row leaves the list immediately and is
   * put back if the server refuses, matching how stage changes behave.
   */
  async function handleDelete(target: CompanyApplicantRow) {
    setDeleting(true);
    let result: Awaited<ReturnType<typeof deleteApplication>>;
    try {
      result = await deleteApplication(target.id);
    } catch {
      result = { success: false, error: "Couldn't delete — please try again." };
    }
    setDeleting(false);

    if (!result.success) {
      setToast(result.error);
      return;
    }

    setApplicants((prev) => prev.filter((a) => a.id !== target.id));
    setDeleteTarget(null);
    setOpenId(null);
    setToast(`${fullName(target)} deleted`);
    router.refresh();
  }

  /**
   * Load the audit trail when the drawer opens. `cancelled` guards the case
   * where the user closes or opens a different applicant mid-flight — a late
   * response must not paint another candidate's history.
   */
  // Which applicant the drawer is showing right now, readable from async
  // callbacks that were started for a possibly-different one.
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = openId;

  useEffect(() => {
    if (!openId) {
      setHistory([]);
      setScoreDetail(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistory([]);
    fetchCompanyApplicant(openId)
      .then((detail) => {
        if (cancelled) return;
        setHistory(detail?.history ?? []);
        setScoreDetail(detail?.scoreDetail ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setHistory([]);
        setScoreDetail(null);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  // The message trail is a separate query from the score/history detail: it is
  // company-scoped rather than application-scoped in its guard, and a failure
  // to read it must not blank the rest of the drawer.
  useEffect(() => {
    if (!openId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessages([]);
    fetchApplicationMessages(openId)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  /**
   * Optimistic move: paint the new stage, then write. A rejected write puts
   * the row back exactly where it was — the previous value is captured before
   * the optimistic paint, so a revert can't resurrect a stale override.
   */
  async function handleStageChange(id: string, next: PipelineStage) {
    const current = rows.find((r) => r.id === id);
    if (!current || current.pipeline_stage === next) return;
    const previous = current.pipeline_stage;

    setStageOverrides((prev) => ({ ...prev, [id]: next }));
    setSavingId(id);

    // The guard inside the action THROWS on a non-company session, so a
    // rejection has to revert too — not just a { success: false } result.
    // Without this the row would keep showing a stage that never saved.
    let result: Awaited<ReturnType<typeof updateApplicationStage>>;
    try {
      result = await updateApplicationStage(id, next);
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }

    setSavingId(null);

    if (!result.success) {
      setStageOverrides((prev) => ({ ...prev, [id]: previous }));
      setToast(result.error);
      return;
    }

    setToast(`Moved to ${PIPELINE_STAGE_LABELS[next]}`);

    // Pull the trail back so the new entry (and its author) is real, not
    // guessed client-side. Skipped if the drawer has since moved on.
    const detail = await fetchCompanyApplicant(id);
    if (openIdRef.current === id) setHistory(detail?.history ?? []);
  }

  /**
   * Optimistic score correction.
   *
   * Both the drawer's detail and the list's ring are painted before the write,
   * and BOTH are captured first so a rejection restores exactly what was there
   * — including the case where the reviewer is editing an existing override
   * rather than creating one.
   *
   * `adjusted_by_name` is deliberately NOT guessed client-side: it stays as it
   * was until the refetch supplies the real value, because a byline is audit
   * data and inventing one would be indistinguishable from the real thing.
   */
  async function handleAdjustScore(id: string, score: number, feedback: string) {
    const beforeDetail = scoreDetail;
    const beforeScore = rows.find((r) => r.id === id)?.score;
    if (!beforeDetail || !beforeScore) return;

    const optimistic: ApplicantScore = {
      ...beforeScore,
      overall: score,
      adjusted: true,
    };
    setScoreDetail({
      ...beforeDetail,
      overall: score,
      adjusted: true,
      human_feedback: feedback.trim() || null,
    });
    setScoreOverrides((prev) => ({ ...prev, [id]: optimistic }));
    setScoreSaving(true);

    // The role guard THROWS rather than returning, so a rejection has to
    // revert too — the same reason handleStageChange wraps its call.
    let result: Awaited<ReturnType<typeof adjustScore>>;
    try {
      result = await adjustScore(id, score, feedback);
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }
    setScoreSaving(false);

    if (!result.success) {
      setScoreDetail(beforeDetail);
      setScoreOverrides((prev) => ({ ...prev, [id]: beforeScore }));
      setToast(result.error);
      return;
    }

    setToast("Score adjusted");
    const detail = await fetchCompanyApplicant(id);
    if (openIdRef.current === id) setScoreDetail(detail?.scoreDetail ?? null);
    if (detail?.applicant) {
      setScoreOverrides((prev) => ({ ...prev, [id]: detail.applicant.score }));
    }
  }

  /** Revert to the model's own number. Same optimistic contract as above. */
  async function handleClearAdjustment(id: string) {
    const beforeDetail = scoreDetail;
    const beforeScore = rows.find((r) => r.id === id)?.score;
    if (!beforeDetail || !beforeScore) return;

    const optimistic: ApplicantScore = {
      ...beforeScore,
      overall: beforeScore.ai_overall,
      adjusted: false,
    };
    setScoreDetail({
      ...beforeDetail,
      overall: beforeDetail.ai_overall,
      adjusted: false,
      human_feedback: null,
      adjusted_by_name: null,
      adjusted_at: null,
    });
    setScoreOverrides((prev) => ({ ...prev, [id]: optimistic }));
    setScoreSaving(true);

    let result: Awaited<ReturnType<typeof clearScoreAdjustment>>;
    try {
      result = await clearScoreAdjustment(id);
    } catch {
      result = { success: false, error: "Couldn't save — please try again." };
    }
    setScoreSaving(false);

    if (!result.success) {
      setScoreDetail(beforeDetail);
      setScoreOverrides((prev) => ({ ...prev, [id]: beforeScore }));
      setToast(result.error);
      return;
    }

    setToast("Reverted to the AI score");
    const detail = await fetchCompanyApplicant(id);
    if (openIdRef.current === id) setScoreDetail(detail?.scoreDetail ?? null);
    if (detail?.applicant) {
      setScoreOverrides((prev) => ({ ...prev, [id]: detail.applicant.score }));
    }
  }

  /**
   * Re-queue AI scoring for one applicant.
   *
   * NOT optimistic. The others paint first because the outcome is known — the
   * stage you picked, the score you typed. Here the outcome is a model call
   * that lands seconds to minutes later via the worker, so the honest UI is a
   * busy state and a "queued" toast; inventing a pending score would claim the
   * old one is gone before anything has replaced it.
   */
  const [rescoringId, setRescoringId] = useState<string | null>(null);

  async function handleRescore(id: string) {
    if (rescoringId) return;
    setRescoringId(id);
    let result: Awaited<ReturnType<typeof rescoreApplication>>;
    try {
      result = await rescoreApplication(id);
    } catch {
      result = { success: false, error: "Couldn't queue a re-score — please try again." };
    }
    setRescoringId(null);
    if (!result.success) {
      setToast(result.error);
      return;
    }
    setToast("Re-score queued — the new card appears here shortly.");
  }

  /**
   * Client-side CSV of the rows currently on screen — no server action needed,
   * since the data is already in the browser. Mirrors the visible columns
   * exactly. `cv_path` is never included (and never reaches the client at all);
   * CVs are only reachable through the audited signed-URL route.
   */
  /**
   * CSV of the CURRENT PAGE, not the whole result set.
   *
   * Page-wise because the button sits beside a paginated list and "Export"
   * silently emitting 2,000 rows when 20 are on screen is a surprise. The
   * label says so explicitly.
   *
   * Columns deliberately include the AI score, confidence and the screening
   * result — the three things a recruiter actually sorts on, and all of them
   * were missing. `cv_path` and signed URLs are NEVER included: the path is a
   * capability that would bypass the ownership gate and the signed_url_logs
   * audit, so CVs stay reachable only through the audited route.
   */
  function exportCsv() {
    if (paged.length === 0) return;

    const header = [
      "Candidate",
      "Email",
      "Job",
      "Stage",
      "AI score",
      "Score status",
      "Confidence",
      "Screening",
      "Applied",
    ];

    const screeningCell = (r: CompanyApplicantRow): string => {
      // Counted over TESTED questions only, both sides. A numeric_mode 'none'
      // question has no threshold to meet, so including it in the denominator
      // would report "2/3 thresholds met" on a candidate who met both of the
      // two that existed.
      const tested = r.screening_answers.filter((a) => a.scored !== false);
      if (r.screening_answers.length === 0) return "No questions";
      if (tested.length === 0) return "No thresholds set";
      const met = tested.filter((a) => a.matched).length;
      return `${met}/${tested.length} thresholds met`;
    };

    const lines = [
      header.map(csvCell).join(","),
      ...paged.map((r) =>
        [
          fullName(r),
          r.email,
          r.job_title,
          PIPELINE_STAGE_LABELS[stageOf(r)],
          r.score.status === "scored" && r.score.overall != null
            ? String(r.score.overall)
            : "",
          r.score.adjusted ? "Adjusted" : r.score.status,
          r.score.confidence ?? "",
          screeningCell(r),
          new Date(r.created_at).toISOString().slice(0, 10),
        ]
          .map(csvCell)
          .join(","),
      ),
    ];

    // BOM so Excel reads UTF-8 names correctly.
    const blob = new Blob([`﻿${lines.join("\r\n")}`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `applicants-page-${safePage}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setToast(
      `Exported ${paged.length} applicant${paged.length === 1 ? "" : "s"} from page ${safePage}`,
    );
  }

  const emptyCopy = (() => {
    if (search.trim()) {
      return {
        title: `No applicants match “${search.trim()}”`,
        text: "Try a different name or email, or clear your search to see everyone.",
      };
    }
    if (unassigned) {
      // Not "no applicants yet" — this company may have hundreds. The reason
      // the page is empty is assignment, so the copy says so and names who
      // can fix it.
      return {
        title: "You haven't been assigned to any roles yet",
        text: "You'll see applicants for the roles you're on. Ask an owner or admin to add you to a job's hiring team.",
      };
    }
    if (applicants.length === 0) {
      return {
        title: "No applicants yet",
        text: "When someone applies to one of your published roles, they'll appear here — scored and ranked by your AI recruiter.",
      };
    }
    return {
      title: "Nothing in this view",
      text: "No applicants match this stage or role filter. Switch tabs to see everyone.",
    };
  })();

  return (
    <PageContainer>
      {/* Header — `items-end` per the mock so the buttons sit on the lede's
          baseline; stacks above 525px so they never overlap the copy. */}
      <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[525px]:flex-row min-[525px]:items-end min-[525px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Applicants
          </h1>
          <p className="m-0 mt-2.5 max-w-[520px] text-[14.5px] leading-relaxed text-[var(--ai-t2)]">
            {/* Deliberately future tense: AI scoring ships in Step 4, so
                "already read every CV" would be a claim the product can't
                currently back. The lime treatment is preserved either way. */}
            {applicants.length === 0
              ? "No one has applied yet. "
              : `${applicants.length} ${applicants.length === 1 ? "person has" : "people have"} applied across your open roles. `}
            Your AI recruiter will <LimeHighlight>read every CV</LimeHighlight>{" "}
            and put the best ones first.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[9px]">
          <button
            type="button"
            onClick={exportCsv}
            disabled={paged.length === 0}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--ai-line-strong)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]"
          >
            <Download className="size-[15px]" strokeWidth={1.9} />
            Export page
          </button>
          {/* A view MODE, not a filter: it narrows whatever the tabs, job
              filter and search already selected, so the two compose. Active
              state is unmistakable — the button inverts to purple, says "Show
              all", and a banner above the list states what is being shown. */}
          <button
            type="button"
            onClick={() => {
              if (!topOnly && topTen.length === 0) {
                setToast("No applicants have been scored yet");
                return;
              }
              setTopOnly((p) => !p);
            }}
            aria-pressed={topOnly}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-[17px] py-[11px] text-[13.5px] font-semibold transition-all ${
              topOnly
                ? "border border-remotiv-purple bg-remotiv-purple text-white shadow-[0_10px_26px_rgba(126,71,255,0.34)]"
                : "border border-[var(--ai-sidebar)] bg-[var(--ai-sidebar)] text-white hover:border-remotiv-purple hover:bg-remotiv-purple hover:shadow-[0_10px_26px_rgba(126,71,255,0.34)]"
            }`}
          >
            <Zap className="size-[15px]" strokeWidth={1.9} />
            {topOnly ? "Show all" : `Review top ${TOP_N}`}
          </button>
        </div>
      </div>

      {/* Dark hero strip */}
      <DashboardHero
        eyebrow="Total applicants"
        value={applicants.length}
        delta={
          newThisWeek > 0 ? <HeroDelta>+{newThisWeek} this week</HeroDelta> : null
        }
        subline={`Across ${openRoles} open ${openRoles === 1 ? "role" : "roles"}`}
      >
        <div className="flex flex-wrap items-stretch min-[840px]:flex-nowrap">
          {FUNNEL_STEPS.map((step, i) => {
            const value = stageCounts[step.stage] ?? 0;
            const pct =
              applicants.length > 0
                ? Math.round((value / applicants.length) * 100)
                : 0;
            return (
              <div
                key={step.stage}
                className={`relative min-w-0 flex-1 px-5 ${i === 0 ? "min-[840px]:pl-0" : ""}`}
              >
                {i < FUNNEL_STEPS.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute right-0 top-1/2 hidden size-[7px] translate-x-1/2 -translate-y-1/2 rotate-45 border-r-[1.5px] border-t-[1.5px] border-white/[0.24] min-[840px]:block"
                  />
                )}
                <div className="mb-[9px] flex items-center gap-[7px] whitespace-nowrap text-[11.5px] font-semibold text-white/55">
                  <i
                    className="size-[6px] shrink-0 rounded-full"
                    style={{ background: step.dot }}
                  />
                  {PIPELINE_STAGE_LABELS[step.stage]}
                </div>
                <div className="mb-2.5 font-heading text-[26px] font-extrabold leading-none tracking-[-0.025em] text-white">
                  {value}
                </div>
                <div className="h-1 overflow-hidden rounded-[3px] bg-white/10">
                  <i
                    className="block h-full origin-left rounded-[3px]"
                    style={{ background: step.bar, width: `${pct}%` }}
                  />
                </div>
                <p className="m-0 mt-2 text-[11px] text-white/[0.38]">
                  {pct}% of total
                </p>
              </div>
            );
          })}
        </div>
      </DashboardHero>

      {/* Panel */}
      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          {/* The 5-tab strip is wider than a phone. It scrolls WITHIN itself
              (max-w-full + overflow-x-auto) so it can never widen the page. */}
          <div className="flex max-w-full overflow-x-auto rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            <TabButton
              on={tab === "all"}
              count={applicants.length}
              onClick={() => setTab("all")}
            >
              All
            </TabButton>
            {TAB_STAGES.map((s) => (
              <TabButton
                key={s}
                on={tab === s}
                count={stageCounts[s] ?? 0}
                onClick={() => setTab(s)}
              >
                {PIPELINE_STAGE_LABELS[s]}
              </TabButton>
            ))}
          </div>

          {/* Full-width on phones so the select + search stack under the tabs
              instead of forcing the toolbar wider than the viewport. */}
          <div className="flex w-full items-center gap-[9px] min-[630px]:ml-auto min-[630px]:w-auto">
            <select
              value={jobFilter}
              onChange={(e) => setJobFilter(e.target.value)}
              aria-label="Filter by job"
              className="min-w-0 max-w-[45%] shrink cursor-pointer appearance-none truncate rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.14] min-[630px]:max-w-none"
            >
              <option value="all">All jobs</option>
              {jobOptions.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>

            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple min-[630px]:w-[210px] min-[630px]:flex-none">
              <SearchIcon className="size-[15px] shrink-0" strokeWidth={1.8} />
              <input
                type="search"
                aria-label="Search applicants"
                placeholder="Search applicants…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-w-0 bg-transparent text-[13px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)]"
              />
            </div>
          </div>
        </div>

        {filtered.length === 0 && (
          <div className="flex flex-col items-center px-6 pb-16 pt-[60px] text-center">
            <div className="mb-[18px] flex size-[66px] items-center justify-center rounded-[20px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
              <Users className="size-7" strokeWidth={1.7} />
            </div>
            <h3 className="font-heading text-[19px] font-extrabold tracking-[-0.02em]">
              {emptyCopy.title}
            </h3>
            <p className="m-0 mt-1.5 max-w-[340px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              {emptyCopy.text}
            </p>
          </div>
        )}

        {/* Stacked cards below the table breakpoint — the 7-column grid needs
            960 design px, which simply doesn't exist on a phone. Squeezing it
            would clip the candidate name; scrolling it sideways hides Job /
            Score / Stage. Same data, same tap target, no horizontal scroll. */}
        {topOnly && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--ai-line)] bg-[var(--ai-purple-tint)] px-5 py-2.5">
            <p className="m-0 text-[12.5px] font-semibold text-[var(--ai-purple-ink)]">
              Showing the top {topTen.length} scored applicant
              {topTen.length === 1 ? "" : "s"} of {filtered.length}.
            </p>
            <button
              type="button"
              onClick={() => setTopOnly(false)}
              className="text-[12.5px] font-bold text-remotiv-purple underline-offset-2 hover:underline"
            >
              Show all applicants
            </button>
          </div>
        )}

        {paged.length > 0 && (
          <div className="min-[1049px]:hidden">
            {paged.map((r, i) => (
              <ApplicantCard
                key={r.id}
                row={r}
                index={pageStart + i}
                isTop={topMatchIds.has(r.id)}
                selected={openId === r.id}
                onOpen={() => setOpenId(r.id)}
              />
            ))}
          </div>
        )}

        {/* Desktop table — unchanged above the breakpoint. overflow-x-auto is
            kept as a belt-and-braces guard; at >=1049px the grid fits. */}
        <div className="hidden overflow-x-auto min-[1049px]:block">
          <div className="min-w-[960px]">
            <div
              className={`${GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] py-[11px] text-[10.5px] font-bold uppercase tracking-[0.08em] text-[var(--ai-t3)]`}
            >
              <span>#</span>
              <span>Candidate</span>
              <span>Job</span>
              <span>CV score</span>
              <span>Stage</span>
              <span>Applied</span>
              <span />
            </div>

            {paged.map((r, i) => {
                const tint = getTint(r.id);
                const applied = fmtApplied(r.created_at);
                const stage = stageOf(r);
                const pill = STAGE_PILL[stage];
                const isTop = topMatchIds.has(r.id);
                const rank = pageStart + i;

                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className={`${GRID} group relative w-full cursor-pointer border-b border-[var(--ai-line-soft)] bg-[var(--ai-surface)] py-[13px] text-left transition-all last:border-b-0 hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)] ${
                      openId === r.id ? "bg-[var(--ai-purple-tint)]" : ""
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${
                        openId === r.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}
                    />
                    <span
                      className={`font-heading text-sm font-extrabold tabular-nums tracking-[-0.02em] transition-colors group-hover:text-remotiv-purple ${
                        isTop ? "text-[var(--ai-purple-ink)]" : "text-[var(--ai-t4)]"
                      }`}
                    >
                      {String(rank + 1).padStart(2, "0")}
                    </span>

                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
                        style={{
                          background: tint.bg,
                          color: tint.fg,
                          boxShadow: isTop
                            ? "0 0 0 2px var(--ai-surface), 0 0 0 3.5px #49D7A7"
                            : "0 0 0 2px var(--ai-surface), 0 0 0 3.5px rgba(20,16,32,0.07)",
                        }}
                      >
                        {initials(r.first_name, r.last_name, r.email)}
                      </span>
                      <div className="min-w-0">
                        {/* .nm is a flex container, so truncation lives on the
                            INNER span — otherwise the Top-match flag clips. */}
                        <p className="m-0 flex min-w-0 items-center gap-2 text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
                          <span className="min-w-0 truncate">{fullName(r)}</span>
                          {isTop && (
                            <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                              Top match
                            </span>
                          )}
                        </p>
                        <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
                          {r.email}
                        </p>
                      </div>
                    </div>

                    <span className="justify-self-start max-w-full truncate rounded-lg border border-[var(--ai-line-soft)] bg-[var(--ai-inset)] px-2.5 py-[5px] text-[12.5px] font-semibold text-[var(--ai-t2)]">
                      {r.job_title}
                    </span>

                    <ScoreRing score={r.score} />

                    <span
                      className={`inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${pill.cls}`}
                    >
                      <span className={`size-[5px] shrink-0 rounded-full ${pill.dot}`} />
                      {PIPELINE_STAGE_LABELS[stage]}
                    </span>

                    <span className="whitespace-nowrap text-[13px] text-[var(--ai-t2)]">
                      {applied.main}
                      <small className="mt-px block text-[11.5px] text-[var(--ai-t4)]">
                        {applied.sub}
                      </small>
                    </span>

                    <span />
                  </button>
                );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="m-0 text-[12.5px] text-[var(--ai-t3)]">
            Ranked by AI score once your recruiter has read each CV.
          </p>
          <Pagination
            page={safePage}
            pageCount={pageCount}
            total={visible.length}
            grandTotal={applicants.length}
            rangeStart={visible.length === 0 ? 0 : pageStart + 1}
            rangeEnd={pageStart + paged.length}
            onPage={setPage}
          />
        </div>
      </div>

      {openRow && (
        <ApplicantDrawer
          /**
           * Keyed by applicant so switching from one to another REMOUNTS the
           * drawer instead of reusing it.
           *
           * Without this, every piece of local state inside survives the
           * switch — and the evidence toggles did. The dimension list is keyed
           * `d.dimension`, and those four keys ("requirements_match", …) are
           * identical for every applicant, so React reused the same
           * EvidenceQuote instances and carried their open/closed state across.
           * Strengths are keyed on their text, which differs per applicant, so
           * those remounted and reset — which is exactly why dimensions showed
           * "Hide evidence" while strengths showed "View evidence".
           *
           * Keying here rather than patching the two lists fixes the whole
           * class: anything stateful added to the drawer later starts clean
           * for each applicant.
           */
          key={openRow.id}
          row={openRow}
          history={history}
          scoreDetail={scoreDetail}
          historyLoading={historyLoading}
          messages={messages}
          messagesLoading={messagesLoading}
          saving={savingId === openRow.id}
          scoreSaving={scoreSaving}
          canRescore={canRescore}
          rescoring={rescoringId === openRow.id}
          onRescore={() => {
            void handleRescore(openRow.id);
          }}
          onEmail={() => setComposerOpen(true)}
          onToast={setToast}
          onClose={() => setOpenId(null)}
          onStageChange={(next) => {
            void handleStageChange(openRow.id, next);
          }}
          onAdjustScore={(score, feedback) => {
            void handleAdjustScore(openRow.id, score, feedback);
          }}
          onClearAdjustment={() => {
            void handleClearAdjustment(openRow.id);
          }}
          onDelete={() => setDeleteTarget(openRow)}
        />
      )}

      {/* One recipient — the open applicant. The select still renders, so the
          identity block and the required-To rule behave identically to the
          page-level composer rather than being a second, looser path. */}
      {openRow && (
        <Composer
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          companyName={companyName}
          replyToAddress={replyToAddress}
          recipients={[
            {
              applicationId: openRow.id,
              name: fullName(openRow),
              email: openRow.email ?? "",
              jobTitle: openRow.job_title ?? "—",
            },
          ]}
          templates={manualTemplates}
          presetApplicationId={openRow.id}
          onSent={async () => {
            setToast("Email sent");
            setMessagesLoading(true);
            try {
              setMessages(await fetchApplicationMessages(openRow.id));
            } catch {
              /* the send succeeded; a stale trail is not worth an error */
            } finally {
              setMessagesLoading(false);
            }
          }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-applicant"
            className="w-full max-w-sm overflow-hidden rounded-[20px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)]"
          >
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-danger-tint)]">
                <Trash2 className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
              </div>
              <h3
                id="confirm-delete-applicant"
                className="font-heading text-lg font-bold text-[var(--ai-t1)]"
              >
                Delete this applicant?
              </h3>
              <p className="m-0 mt-2 text-sm text-[var(--ai-t2)]">
                <span className="font-semibold">{fullName(deleteTarget)}</span>{" "}
                will be permanently removed, along with their CV file, AI
                scorecard and pipeline history. This cannot be undone.
              </p>
            </div>
            <div className="flex gap-3 border-t border-[var(--ai-line)] px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 rounded-xl border border-[var(--ai-line)] py-2.5 text-sm font-medium text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(deleteTarget)}
                disabled={deleting}
                aria-busy={deleting}
                className="flex-1 rounded-xl bg-[var(--ai-danger)] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
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
          className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-[9px] rounded-[13px] bg-[var(--ai-sidebar)] px-[19px] py-[13px] text-[13.5px] font-semibold text-white shadow-[0_18px_44px_rgba(0,0,0,0.34)]"
        >
          <Check className="size-4 shrink-0 text-remotiv-green" strokeWidth={2.4} />
          {toast}
        </div>
      )}
    </PageContainer>
  );
}

function TabButton({
  on,
  count,
  onClick,
  children,
}: {
  on: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-[7px] rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors ${
        on
          ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
          : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
      }`}
    >
      {children}
      <span
        className={`rounded-full px-1.5 py-px text-[10.5px] font-bold ${
          on ? "bg-white/20 text-white" : "bg-black/[0.07]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
