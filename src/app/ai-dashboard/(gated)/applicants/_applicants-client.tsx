"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  File,
  Flag,
  Mail,
  Minus,
  RotateCcw,
  Search as SearchIcon,
  Trash,
  Users,
  X,
  Zap,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DashboardHero, HeroDelta } from "@/app/ai-dashboard/_components/dashboard-hero";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { Composer, initialsOf as msgInitials } from "@/app/ai-dashboard/(gated)/messages/_composer";
import { fetchApplicationMessages } from "@/app/ai-dashboard/(gated)/messages/actions";
import type {
  MessageRow as CandidateMessage,
  ManualTemplate,
} from "@/app/ai-dashboard/(gated)/messages/types";
import {
  type ApplicantComment,
  type ApplicantScore,
  type ApplicantScoreDetail,
  COMMENT_MAX,
  type CompanyApplicantRow,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
  SCORE_FEEDBACK_MAX,
  SCORING_OFF_REASON,
  type ScoreDimensionRow,
  type StageHistoryRow,
  showsWorthALook,
} from "@/app/ai-dashboard/lib/applicant-types";
import { type CompanyRole, canCreateJobs } from "@/app/ai-dashboard/lib/company-roles";
import {
  BAND_LABEL,
  BAND_MATCH_LABEL,
  BAND_PILL,
  scoreBand as bandKey,
} from "@/app/ai-dashboard/lib/score-bands";
import { InterviewPanel } from "./_interview-panel";
import {
  addApplicationComment,
  adjustScore,
  clearScoreAdjustment,
  countFlaggedApplicants,
  deleteApplication,
  deleteApplicationComment,
  dismissShortlistFlagAction,
  fetchCompanyApplicant,
  rescoreApplication,
  updateApplicationComment,
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

const TAB_STAGES: ReadonlyArray<PipelineStage> = ["applied", "shortlisted", "interview", "hired"];

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

/**
 * How the list is ordered. "best" is the default and always has been.
 *
 * Plain component state, deliberately — the stage tab, the job filter and the
 * "Review top" mode are all plain state too, and only `search` is seeded from
 * the URL. A sort that survived a reload while the stage tab did not would be
 * the odd one out.
 */
type SortMode = "best" | "newest";

/**
 * The applicant panel's tabs.
 *
 * Unlike SortMode these ARE in the URL, because the reason to send someone a
 * link to this panel is usually a specific pane — "look at his Review" — and a
 * link that always lands on Profile can't say that.
 */
const PANEL_TABS = [
  { key: "profile", label: "Profile" },
  { key: "review", label: "Review" },
  { key: "comm", label: "Communication" },
  { key: "interviews", label: "Interviews" },
  /* No count beside the label. Comments arrive with the rest of the detail,
     which is fetched in an effect AFTER the tab strip has painted — so a number
     here would appear a beat late on every open, which is the reason the list's
     badges were left off. The pane's own head carries the count instead, where
     it sits behind a loading state and lands with the thread it describes. */
  { key: "comments", label: "Comments" },
] as const;
type PanelTab = (typeof PANEL_TABS)[number]["key"];

/** Guards the URL: ?tab=nonsense falls back to Profile rather than a blank pane. */
function isPanelTab(value: string | null): value is PanelTab {
  return PANEL_TABS.some((t) => t.key === value);
}

/**
 * Best match: score descending, unscored last, newest first among unscored.
 *
 * ── The tail block ───────────────────────────────────────────
 *
 * `status === "scored"` is the whole test, so `pending`, `failed` and
 * `skipped` are one undifferentiated group at the bottom. That is intentional
 * — in all three cases there is no number, and ordering them against each
 * other would invent a ranking out of an absence — but it does mean a brand
 * new application sits below every scored one however weak or old those are.
 * That is what the "Newest" mode exists to escape.
 *
 * ── Equal scores are NOT tie-broken here ─────────────────────
 *
 * Two rows on the same score return 0, and they hold their incoming order
 * because Array.prototype.sort is stable and the fetch arrives
 * `created_at desc` (see actions.ts, `.order("created_at", …)`). So equal
 * scores read newest-first by a coincidence of two facts, not because this
 * comparator says so. It is fine today. It breaks silently — no error, just a
 * quietly wrong order — if that ORDER BY is ever changed or a caller sorts the
 * rows before they get here. Add an explicit date tiebreak rather than
 * re-deriving why it used to work.
 */
function compareByScore(a: CompanyApplicantRow, b: CompanyApplicantRow): number {
  const sa = a.score.status === "scored" ? a.score.overall : null;
  const sb = b.score.status === "scored" ? b.score.overall : null;
  if (sa !== null && sb !== null) return sb - sa;
  if (sa !== null) return -1;
  if (sb !== null) return 1;
  return compareByNewest(a, b);
}

/**
 * Newest: date descending, and nothing else.
 *
 * No score term, not even as a tiebreak. The reason someone reaches for this
 * mode is that a new unscored application is invisible under best-match, so a
 * rule that let any score pull a row upward would defeat it.
 */
function compareByNewest(a: CompanyApplicantRow, b: CompanyApplicantRow): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

/**
 * Toolbar select. Shared by the job filter and the sort control so the two
 * cannot drift — they sit side by side, where a 1px difference would show.
 */
const TOOLBAR_SELECT =
  "min-w-0 cursor-pointer appearance-none truncate rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.14]";

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

/**
 * The clock every date on this page reads.
 *
 * ── Why a date can't just be formatted during render ─────────
 *
 * These are client components, so they render TWICE: once on the server, once
 * in the browser during hydration. `Date.now()` and `toLocaleDateString` both
 * answer differently in those two places — the server runs in UTC, the reader's
 * browser in their own zone — so an application created after 19:00 UTC came
 * out "21 Aug" on the server and "22 Aug" in Karachi. Every applicant row
 * carries one of these, which made a hydration mismatch the normal case rather
 * than an edge one.
 *
 * `now` is the SERVER's render time until hydration finishes, then the live
 * clock. `local` is false until then, and the formatters pin UTC while it is —
 * UTC being the only zone both sides can agree on before the browser is
 * involved. After hydration both switch to the reader's own clock and zone.
 *
 * The visible cost is one re-render on mount, and it only changes text for
 * rows whose timestamp falls on a different calendar day in the two zones —
 * the ones that were rendering wrong anyway.
 */
type PageClock = { now: number; local: boolean };

const NEVER_CHANGES = () => () => {};

/**
 * false on the server and during the first client render, true afterwards.
 *
 * useSyncExternalStore rather than useState+useEffect because its
 * getServerSnapshot is exactly this distinction: React guarantees the
 * hydrating render sees the server value, so the first client pass matches the
 * HTML by construction instead of by timing.
 */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );
}

function fmtApplied(iso: string, clock: PageClock): { main: string; sub: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { main: "—", sub: "" };
  const abs = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(clock.local ? {} : { timeZone: "UTC" }),
  });
  if (clock.now <= 0) return { main: abs, sub: "" };
  const days = Math.floor((clock.now - d.getTime()) / 86_400_000);
  if (days < 1) return { main: "Today", sub: abs };
  if (days === 1) return { main: "1d ago", sub: abs };
  return { main: `${days}d ago`, sub: abs };
}

/** "12 Mar 2026", or null when the timestamp is missing or unparseable. */
function fmtDay(iso: string | null, local: boolean): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(local ? {} : { timeZone: "UTC" }),
  });
}

/**
 * " · adjusted by Sara on 12 Mar 2026", or "" when neither is known.
 *
 * Both halves are optional because the optimistic paint deliberately doesn't
 * guess the byline — it renders without one until the refetch supplies it.
 */
function adjustmentByline(detail: ApplicantScoreDetail | null, local: boolean): string {
  if (!detail) return "";
  const when = fmtDay(detail.adjusted_at, local);
  const who = detail.adjusted_by_name?.trim();
  if (who && when) return ` · adjusted by ${who} on ${when}`;
  if (who) return ` · adjusted by ${who}`;
  if (when) return ` · adjusted on ${when}`;
  return "";
}

/**
 * " Model v10 · scored 17 Sep 2026." — the terms the number was produced
 * under, for the foot of the Review card.
 *
 * Either half is absent on older rows, so the separator follows what actually
 * survived instead of being assumed.
 */
function scoreProvenance(detail: ApplicantScoreDetail | null, local: boolean): string {
  if (!detail) return "";
  const parts: string[] = [];
  if (detail.ai_model) parts.push(`Model ${detail.ai_model}`);
  const when = fmtDay(detail.scored_at, local);
  if (when) parts.push(`scored ${when}`);
  return parts.length > 0 ? ` ${parts.join(" · ")}.` : "";
}

/** Pipeline stage for a row — the real column, since Step 2d. */
function stageOf(row: CompanyApplicantRow): PipelineStage {
  return row.pipeline_stage;
}

/**
 * Three states, not two. An expired CV is not a missing one — it was here, it
 * was read, and it reached the end of its retention. Labelling that "No CV"
 * blames the applicant for a deletion we performed on schedule.
 */
function cvLabel(row: CompanyApplicantRow): string {
  if (row.has_cv) return "Open CV";
  return row.cv_expired ? "CV expired" : "No CV";
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
      <span className="text-xs font-semibold text-[var(--ai-t4)]">{pendingLabel(score)}</span>
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

/**
 * Colour for the confidence badge on the Review card.
 *
 * The design only draws the "high" case, and always in mint. Reusing mint for
 * the other two would put a success colour on the words "Low confidence",
 * which is the one reading that must not happen — so the other two bands take
 * the tokens they already have elsewhere in the panel.
 */
const CONFIDENCE_BADGE: Record<string, { pill: string; dot: string }> = {
  high: { pill: "bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]", dot: "bg-remotiv-green" },
  medium: {
    pill: "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]",
    dot: "bg-[var(--ai-amber-dot)]",
  },
  low: { pill: "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]", dot: "bg-[var(--ai-t3)]" },
};

/** The 3px separator between the header's identity facts. */
function IdDot() {
  return <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-[var(--ai-t4)]" />;
}

/** 42px ring for the panel header. */
function DrawerMiniRing({ score }: { score: number }) {
  const C = 2 * Math.PI * 18;
  const band = scoreBand(score);
  return (
    <span className="relative flex size-[42px] shrink-0 items-center justify-center">
      <svg className="size-[42px] -rotate-90" viewBox="0 0 42 42" aria-hidden>
        <circle cx="21" cy="21" r="18" fill="none" stroke="var(--ai-slate-tint)" strokeWidth="4" />
        <circle
          cx="21"
          cy="21"
          r="18"
          fill="none"
          stroke={band.stroke}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C * (1 - score / 100)).toFixed(2)}
        />
      </svg>
      <span className="absolute font-heading text-sm font-extrabold tracking-[-0.035em] tabular-nums text-[var(--ai-t1)]">
        {score}
      </span>
    </span>
  );
}

/**
 * 112px ring for the Review card, on the light surface.
 *
 * A separate component rather than a `dark` flag on one: the track colour, the
 * numeral colour and the "out of 100" caption are most of what the thing is,
 * so a shared shell would read as one component and behave as two.
 */
function ReviewScoreRing({ score }: { score: number }) {
  const C = 2 * Math.PI * 49;
  const band = scoreBand(score);
  return (
    <span className="relative flex size-[112px] shrink-0 items-center justify-center">
      <svg className="size-[112px] -rotate-90" viewBox="0 0 112 112" aria-hidden>
        <circle cx="56" cy="56" r="49" fill="none" stroke="var(--ai-slate-tint)" strokeWidth="9" />
        <circle
          cx="56"
          cy="56"
          r="49"
          fill="none"
          stroke={band.stroke}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={C.toFixed(2)}
          strokeDashoffset={(C * (1 - score / 100)).toFixed(2)}
        />
      </svg>
      <span className="absolute flex flex-col items-center gap-0.5">
        <b className="font-heading text-[34px] font-extrabold leading-none tracking-[-0.045em] tabular-nums text-[var(--ai-t1)]">
          {score}
        </b>
        <i className="text-[10.5px] font-bold uppercase not-italic tracking-[0.06em] text-[var(--ai-t3)]">
          out of 100
        </i>
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
/**
 * "Worth a look" — the COMPANY's rule, deliberately unlike "Top match".
 *
 * Top match is the model's own opinion (score >= 90) and wears a FILLED lime
 * sticker. This is a threshold somebody chose, so it wears a purple OUTLINE
 * chip on a faint purple wash. Filled vs outline, lime vs purple: the two must
 * never be mistakable, because one is "the AI rates this person highly" and the
 * other is "this cleared a bar you set" — different claims, different recourse.
 *
 * The × is the first of three dismiss entry points and appears on row hover so
 * it is not a permanent invitation to clear the thing you just asked for.
 */
/**
 * The flag, as a MARK. It takes no props and it never will.
 *
 * ── Why the dismiss button is gone rather than optional ──────
 *
 * It used to accept `onDismiss`, and passing it rendered a <button> inside the
 * chip. Both places the chip is used are rows that are themselves <button>s, so
 * that one optional prop decided whether the markup was valid — and invalid is
 * not a cosmetic state here. The parser generates implied end tags on a nested
 * <button> and pops the outer one, so everything after the chip became a
 * SIBLING of the row: the server tree and the client tree disagreed, hydration
 * failed, and React left the mangled server DOM orphaned below the page.
 *
 * A component whose validity depends on where it is rendered is a trap, and no
 * signature can express "only if my ancestor is not a button" — the type system
 * cannot see the DOM. So the capability is removed instead of guarded: with no
 * prop to pass, the mistake is unspeakable rather than merely discouraged, and
 * a reader does not have to know the rule to stay on the right side of it.
 *
 * Dismissal lives in the drawer's Worth-a-look banner, which is a real region
 * rather than a chip and can hold a button safely. Both call sites open that
 * drawer on click, so it is one click from either.
 */
function WorthALookChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-remotiv-purple/45 bg-remotiv-purple/[0.06] py-0.5 pl-[7px] pr-[7px] text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-remotiv-purple">
      Worth a look
    </span>
  );
}

/**
 * The reason, which replaces the email sub-line on a flagged row.
 *
 * A flag without its reason is just a badge — the recruiter cannot tell whether
 * it fired on a CV at 82 or an interview at 95, and those warrant different
 * next moves. The stored sentence names the score and the mark it cleared.
 */
function FlagReasonLine({ reason }: { reason: string | null }) {
  return (
    <p className="m-0 mt-0.5 truncate text-[12.5px] font-medium text-remotiv-purple">
      {reason?.trim() || "Met your auto-shortlist mark."}
    </p>
  );
}

function ApplicantCard({
  row,
  index,
  isTop,
  selected,
  onOpen,
  clock,
}: {
  row: CompanyApplicantRow;
  index: number;
  /** Genuine top match — see TOP_MATCH_MIN_SCORE, not "first in the list". */
  isTop: boolean;
  selected: boolean;
  onOpen: () => void;
  clock: PageClock;
}) {
  const tint = getTint(row.id);
  const applied = fmtApplied(row.created_at, clock);
  const stage = stageOf(row);
  const pill = STAGE_PILL[stage];
  const worthALook = showsWorthALook(row);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative w-full border-b border-[var(--ai-line-soft)] px-4 py-4 text-left transition-colors last:border-b-0 active:bg-[#FCFBFA] ${
        selected
          ? "bg-[var(--ai-purple-tint)]"
          : worthALook
            ? "bg-remotiv-purple/[0.035]"
            : "bg-[var(--ai-surface)]"
      }`}
    >
      {/* The accent stays on for a flagged row, not only when selected — it is
          what makes the flag findable while scrolling. Selection still wins. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${
          selected || worthALook ? "opacity-100" : "opacity-0"
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
            {worthALook && <WorthALookChip />}
          </p>
          {worthALook ? (
            <FlagReasonLine reason={row.shortlist.reason} />
          ) : (
            <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">{row.email}</p>
          )}
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

/** Close, previous and next — the three square controls in the panel header. */
const PANEL_ICON_BTN =
  "grid size-[30px] shrink-0 place-items-center rounded-[11px] border border-[var(--ai-line)] text-[var(--ai-t3)] transition-colors hover:border-[var(--ai-line-strong)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--ai-line)] disabled:hover:bg-transparent disabled:hover:text-[var(--ai-t3)]";

/**
 * An underline tab, not a pill in a tray. The 12px of padding is all below the
 * text so the 2px rule lands on the header's own bottom border.
 */
const PANEL_TAB_BASE =
  "relative whitespace-nowrap pb-3 text-[13px] font-bold transition-colors after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-t-sm";

/** The design system's secondary button, for the Review card's action column. */
const REVIEW_BTN_SEC =
  "inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-2.5 text-[13.5px] font-bold text-[var(--ai-t1)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-40";

/** The design's `.card` — the white panel every block in every pane sits in. */
const CARD_SURFACE =
  "rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]";

/**
 * Human correction of an AI score — the editor half.
 *
 * Available on ANY row that has a score record, including failed and skipped
 * ones — "the model couldn't read this CV but I did, and it's a 78" is a real
 * and useful judgement, and the server contract is the same either way.
 *
 * The note is optional but pushed hard in the copy: two numbers say the model
 * was wrong, only the note says why, and why is the part a readout can never
 * reconstruct after the fact.
 *
 * Mounted only while open, and its fields seed from `detail` in the useState
 * initialisers. That is why there is no `editing` flag and no effect keeping
 * the inputs in step with the row: closing unmounts, and the next open re-seeds
 * from whatever is showing by then. The open/closed bit lives in the drawer
 * because the button that flips it is in the score card, not here.
 */
function ScoreAdjustForm({
  detail,
  saving,
  onSave,
  onClose,
}: {
  detail: ApplicantScoreDetail;
  saving: boolean;
  onSave: (score: number, feedback: string) => void;
  onClose: () => void;
}) {
  // Seeded from whatever is showing now, so a small correction is a small edit
  // rather than a retype.
  const [value, setValue] = useState(String(detail.overall ?? detail.ai_overall ?? 50));
  const [note, setNote] = useState(detail.human_feedback ?? "");
  const [error, setError] = useState<string | null>(null);

  function commit() {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setError("Enter a whole number from 0 to 100.");
      return;
    }
    onClose();
    onSave(parsed, note);
  }

  return (
    <div className="mx-6 mb-[22px] rounded-2xl bg-[var(--ai-purple-tint)] px-[18px] py-4">
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
        <p className="m-0 mt-1.5 text-xs text-[var(--ai-t3)]">The AI scored {detail.ai_overall}.</p>
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
        <button type="button" onClick={onClose} disabled={saving} className={ADJ_BTN_QUIET}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The standing record of a human override: the note, and the two ways back out.
 *
 * Separate from the form because it is not a transient state. An adjusted score
 * carries this line for as long as the adjustment stands, so it cannot live
 * inside a component that only exists while the editor is open.
 */
function AdjustmentRecord({
  detail,
  saving,
  onEdit,
  onClear,
  local,
}: {
  detail: ApplicantScoreDetail;
  saving: boolean;
  onEdit: () => void;
  onClear: () => void;
  /** False until hydration; see PageClock. */
  local: boolean;
}) {
  return (
    <div className="mx-6 mb-[22px] rounded-2xl bg-[var(--ai-inset)] px-[18px] py-4">
      <p className="m-0 text-[13px] font-semibold text-[var(--ai-t1)]">
        Adjusted to {detail.overall} from the AI&apos;s {detail.ai_overall ?? "—"}
        <span className="font-normal text-[var(--ai-t3)]">{adjustmentByline(detail, local)}</span>
      </p>
      {detail.human_feedback && (
        <p className="m-0 mt-2 border-l-2 border-[var(--ai-line-strong)] pl-2.5 text-[13px] italic leading-relaxed text-[var(--ai-t2)]">
          {detail.human_feedback}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={saving} className={ADJ_BTN_QUIET}>
          Edit adjustment
        </button>
        <button type="button" onClick={onClear} disabled={saving} className={ADJ_BTN_QUIET}>
          Revert to AI score
        </button>
      </div>
    </div>
  );
}

/**
 * A section heading with a rule running to a right-aligned sub-line.
 *
 * The sub-line is optional, and where the design put an invented one — the
 * dimensions' "Weighted to 87 · model v4.2" — this renders nothing rather than
 * a plausible number.
 */
function ReviewSubhead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-[13px] flex items-center gap-3">
      <h2 className="m-0 whitespace-nowrap font-heading text-[15px] font-bold tracking-[-0.025em] text-[var(--ai-t1)]">
        {title}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-[var(--ai-line)]" />
      {meta && <span className="shrink-0 text-[11px] font-medium text-[var(--ai-t3)]">{meta}</span>}
    </div>
  );
}

/**
 * A dimension's supporting CV span, shown open.
 *
 * The toggle in EvidenceQuote exists because the lists can run to a dozen
 * quotes; a scorecard has at most four dimensions, and a bar with no quote
 * under it is just an assertion. So this one renders expanded and is styled as
 * a quotation rather than as a disclosure.
 */
function DimQuote({ quote }: { quote: string }) {
  return (
    <figure className="m-0 mt-3 overflow-hidden rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
      <blockquote className="relative m-0 py-[13px] pl-[42px] pr-4 text-[13px] font-medium leading-[1.65] text-[var(--ai-t1)]">
        <span
          aria-hidden
          className="absolute left-[15px] top-[11px] font-heading text-[30px] font-extrabold leading-none text-remotiv-purple opacity-30"
        >
          &ldquo;
        </span>
        {quote}
      </blockquote>
    </figure>
  );
}

/**
 * One of Evidence's four boxes: a tinted badge, a real count, and its rows.
 *
 * The count is the length of the array being rendered, or evidenced-over-total
 * on the must-haves — see the Must-haves block for why a ratio is on screen at
 * all, given CriterionRow used to argue against exactly that.
 */
function EvidenceList({
  label,
  badge,
  dot,
  count,
  children,
}: {
  label: string;
  badge: string;
  dot: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${CARD_SURFACE} px-5 py-[18px]`}>
      <h3 className="m-0 mb-3 flex items-center gap-2 text-[13px] font-bold">
        <span
          className={`inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-2 py-[3px] text-[10.5px] font-bold ${badge}`}
        >
          <span aria-hidden className={`size-[5px] rounded-full ${dot}`} />
          {label}
        </span>
        <em className="rounded-full bg-[var(--ai-slate-tint)] px-[7px] py-0.5 text-[10.5px] font-bold not-italic text-[var(--ai-t3)]">
          {count}
        </em>
      </h3>
      {children}
    </div>
  );
}

const EVIDENCE_ICON = "mt-px grid size-4 shrink-0 place-items-center rounded-full";

/**
 * One row inside an Evidence box.
 *
 * Carries what survived CriterionRow, which this replaces: the item is
 * rendered in the employer's or the model's own words at full weight, and an
 * absent one is described as absent from the DOCUMENT rather than as a failing
 * of the person. What did not survive is that component's refusal of a count
 * and of a warning mark — both are the design's call, and both are now here.
 * The unmet mark is amber, not the red the missing-requirements rows use: a
 * must-have the CV did not mention is a gap to ask about, not a rejection.
 */
function EvidenceRow({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5 py-[7px] text-[12.5px] leading-[1.6] text-[var(--ai-t2)]">
      {tone === "ok" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]`}
          aria-hidden
        >
          <Check className="size-2.5" strokeWidth={2.4} />
        </span>
      )}
      {tone === "warn" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]`}
          aria-hidden
        >
          <AlertTriangle className="size-2.5" strokeWidth={2.4} />
        </span>
      )}
      {tone === "danger" && (
        <span
          className={`${EVIDENCE_ICON} bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
          aria-hidden
        >
          <X className="size-[9px]" strokeWidth={2.6} />
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * What an Evidence box says when its list is empty.
 *
 * All four boxes render on every scored card, so an empty one has to say which
 * kind of empty it is. For three of them that is unambiguous and worth stating:
 * the scorer runs strengths, missing_requirements and concerns through a
 * normaliser that always yields an array, so an empty one is the model
 * reporting it found none — never a field the card is too old to have. "No
 * gaps found" is a finding, and the box disappearing said nothing.
 *
 * Must-haves is the exception and passes its own text, because an empty array
 * there has two possible causes and only the job's current count separates
 * them.
 */
function EvidenceEmpty({ children }: { children: React.ReactNode }) {
  return <p className="m-0 py-[7px] text-[12.5px] leading-[1.6] text-[var(--ai-t3)]">{children}</p>;
}

/**
 * The Summary card's sub-line.
 *
 * Genuine, which is why it survived when the design's other sub-lines did not:
 * the screening answers are frozen at apply time, and the scorer is handed them
 * as context beside the CV text, so the count on the row is the count the model
 * actually read.
 */
function summarySource(answers: number): string {
  if (answers === 0) return "Generated from the CV";
  return `Generated from CV + ${answers} screening answer${answers === 1 ? "" : "s"}`;
}

/**
 * The Scored dimensions sub-line — how many of them the overall is an average
 * of, which is the one thing about the set a reader cannot see by looking.
 *
 * NOT the design's "Weighted to 87 · model v4.2". The weights are not stored on
 * the scorecard, and the model and date are already in the card's disclaimer.
 */
function dimensionsMeta(detail: ApplicantScoreDetail): string {
  const total = detail.dimensions.length;
  const counted = detail.dimensions.filter((d) => !d.unstated).length;
  if (counted === total) return `All ${total} averaged into the overall`;
  return `${counted} of ${total} averaged into the overall`;
}

/**
 * The Evidence sub-line. Counts what the JOB names today, not what the card
 * judged — the line describes the bar being measured against, and a card that
 * predates a must-have should still say the bar exists. Omitted for a job that
 * names none, where there is no bar to describe.
 */
function evidenceMeta(detail: ApplicantScoreDetail): string | undefined {
  const n = detail.job_must_have_count;
  if (n === 0) return undefined;
  return `Against the job's ${n} named must-have${n === 1 ? "" : "s"}`;
}

/** The count pill on Must-haves met, which is three different things. */
function mustHaveCount(detail: ApplicantScoreDetail): string {
  if (detail.must_haves.length > 0) {
    const met = detail.must_haves.filter((m) => m.status === "evidenced").length;
    return `${met} of ${detail.must_haves.length}`;
  }
  // No "0 of N" for a card that predates the list: nothing was judged and
  // failed, the question was never put.
  return detail.job_must_have_count === 0 ? "None" : "—";
}

/**
 * One dimension: its name, a bar, the score out of 100, the reasoning, and the
 * CV span behind it.
 *
 * The design put a weight under each name. Cut — the job carries weight columns
 * but the scorecard does not record which weights produced it, so today's
 * numbers set beside an older score would misdescribe the figure above them.
 */
function ScoredDimension({ dimension: d }: { dimension: ScoreDimensionRow }) {
  const label = DIMENSION_LABEL[d.dimension] ?? d.dimension;

  /*
   * A dimension the job stated nothing for shows NO number and NO bar.
   *
   * The model was still made to score it — all four are mandatory so scores
   * stay comparable between jobs — but it judged the CV against an empty
   * section, so the number is an invention. It is excluded from the overall
   * (see applyCvWeights), and rendering it here would put a figure on screen
   * that the headline score deliberately ignores. The reason is stated inline
   * rather than in a tooltip: three bars where every other job shows four
   * reads as a bug unless the fourth line says why.
   */
  if (d.unstated) {
    return (
      <div className="border-t border-[var(--ai-line-soft)] px-[22px] py-[18px] first:border-t-0">
        <div className="flex items-baseline justify-between gap-4">
          <h4 className="m-0 text-[13px] font-bold text-[var(--ai-t3)]">{label}</h4>
          <span className="text-[12px] font-semibold text-[var(--ai-t3)]">Not scored</span>
        </div>
        <p className="m-0 mt-3 text-[12.5px] leading-[1.65] text-[var(--ai-t3)] min-[840px]:pl-[216px]">
          This job lists no requirements, so there was nothing to judge the CV against. It is left
          out of the overall score rather than guessed at.
        </p>
      </div>
    );
  }

  const band = scoreBand(d.score);
  return (
    <div className="border-t border-[var(--ai-line-soft)] px-[22px] py-[18px] first:border-t-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 min-[840px]:grid-cols-[200px_minmax(0,1fr)_auto]">
        <h4 className="m-0 text-[13px] font-bold tracking-[-0.01em] text-[var(--ai-t1)]">
          {label}
        </h4>
        {/* Below the breakpoint there is no room for a 200px name column, so
            the track drops to a full-width row under the name/score pair
            rather than being dropped altogether. */}
        <span className="order-last col-span-2 block h-2 overflow-hidden rounded-full bg-[var(--ai-slate-tint)] min-[840px]:order-none min-[840px]:col-span-1">
          <span
            className="block h-full rounded-full"
            style={{ width: `${d.score}%`, background: band.stroke }}
          />
        </span>
        <span
          className="min-w-[62px] text-right font-heading text-[25px] font-extrabold leading-none tracking-[-0.03em] tabular-nums"
          style={{ color: band.ink }}
        >
          {d.score}
          <small className="ml-px text-[12px] font-bold tracking-normal text-[var(--ai-t3)]">
            /100
          </small>
        </span>
      </div>
      <div className="min-[840px]:pl-[216px]">
        {d.reasoning && (
          <p className="m-0 mt-3 text-[12.5px] leading-[1.65] text-[var(--ai-t2)]">{d.reasoning}</p>
        )}
        {d.quote && <DimQuote quote={d.quote} />}
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
  historyFailed,
  messages,
  messagesLoading,
  comments,
  commentsLoading,
  viewerMemberId,
  viewerRole,
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
  onDismissFlag,
  dismissing,
  clock,
  tab,
  onTabChange,
  position,
  onStep,
}: {
  row: CompanyApplicantRow;
  history: StageHistoryRow[];
  scoreDetail: ApplicantScoreDetail | null;
  historyLoading: boolean;
  /** The trail could not be READ. Distinct from "there is no trail". */
  historyFailed: boolean;
  messages: CandidateMessage[];
  messagesLoading: boolean;
  comments: ApplicantComment[];
  commentsLoading: boolean;
  /** company_members.id of the viewer — decides whose Edit and Delete show. */
  viewerMemberId: string;
  /** Owner and admin may delete anyone's comment; everyone else only their own. */
  viewerRole: CompanyRole;
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
  /** The third dismiss entry point — chip, row menu, and this banner. */
  onDismissFlag: (id: string) => void;
  /** The id currently being dismissed, or null. */
  dismissing: string | null;
  clock: PageClock;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /**
   * Where this applicant sits in the list as displayed, or null when the panel
   * was deep-linked to someone the current filters exclude — prev/next then
   * has no sequence to walk and hides itself.
   */
  position: { index: number; total: number } | null;
  onStep: (delta: number) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tint = getTint(row.id);
  const name = fullName(row);
  const applied = fmtApplied(row.created_at, clock);
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

  /**
   * Which side of a threshold the number fell — null when there is no number.
   *
   * Read from the shared score-bands module, not the local colour helper above:
   * a band means the same thing on a CV as on an interview, and the label has
   * to come from wherever the thresholds do or the two products drift.
   */
  const band =
    headerScore.status === "scored" && headerScore.overall != null
      ? bandKey(headerScore.overall)
      : null;

  /**
   * Whether the adjuster is open. Lives here rather than inside the form
   * because the button that opens it is in the score card, and the form is
   * mounted only while true so its inputs seed from `scoreDetail` on mount.
   *
   * Resets per applicant, which is correct: the drawer is keyed on the row id,
   * so stepping to the next candidate cannot leave a half-typed override for
   * the previous one on screen.
   */
  const [adjusting, setAdjusting] = useState(false);

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
    // var(--vh-full), not h-screen: vh resolves against the UNZOOMED
    // viewport inside .ai-shell and would render 18% short. The width is a
    // min() so the panel is a panel on a laptop and the whole screen on a
    // phone, where 1100px of anything is not available.
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} — applicant detail`}
      className="fixed right-0 top-0 z-[95] flex h-[var(--vh-full)] w-full max-w-[min(96%,1100px)] flex-col bg-[var(--ai-surface)] shadow-[-24px_0_70px_rgba(20,16,32,0.24)] outline-none"
    >
      {/* Panel header. White, per the design: everything above the body is one
          block — the back row, the identity row, and the tabs — so the tabs'
          underline lands on the header's own bottom border.

          Gutter is 22px, not the design's 30px. The body has always been 22 and
          a 30px header would set the avatar 8px left of everything under it. */}
      <header className="shrink-0 border-b border-[var(--ai-line)] bg-[var(--ai-surface)] px-[22px] pt-4">
        {/* Back, not an X. Closing the panel IS returning to the list, and the
            list is still behind it — an arrow says where you land, an X only
            says something goes away. The X stays at the right for the reader
            who reads it as a dismissable overlay; both call onClose. */}
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="-ml-1.5 flex items-center gap-2 rounded-[11px] py-1.5 pl-1.5 pr-2.5 text-[12.5px] font-semibold text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
          >
            <ChevronLeft className="size-4" strokeWidth={1.6} />
            Back to applicants
          </button>

          {/* Stepping through a shortlist without closing is most of why a
              wide panel beats a modal. Hidden, not disabled, when the panel
              was deep-linked to someone outside the current filters: there
              is no sequence to step through, and a dead arrow says less than
              no arrow. */}
          <div className="flex items-center gap-1.5">
            {position && (
              <>
                <button
                  type="button"
                  onClick={() => onStep(-1)}
                  disabled={position.index === 0}
                  aria-label="Previous applicant"
                  className={PANEL_ICON_BTN}
                >
                  <ChevronLeft className="size-[14px]" strokeWidth={1.6} />
                </button>
                <span className="px-1.5 text-[11.5px] font-semibold tabular-nums text-[var(--ai-t3)]">
                  {position.index + 1} of {position.total}
                </span>
                <button
                  type="button"
                  onClick={() => onStep(1)}
                  disabled={position.index >= position.total - 1}
                  aria-label="Next applicant"
                  className={PANEL_ICON_BTN}
                >
                  <ChevronRight className="size-[14px]" strokeWidth={1.6} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className={`${PANEL_ICON_BTN} ml-1.5`}
            >
              <X className="size-[14px]" strokeWidth={1.6} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-[15px] pb-4">
          <span
            className="grid size-[54px] shrink-0 place-items-center rounded-full font-heading text-[18px] font-extrabold shadow-[0_0_0_3px_rgba(126,71,255,0.1)]"
            style={{ background: tint.bg, color: tint.fg }}
          >
            {initials(row.first_name, row.last_name, row.email)}
          </span>
          <div className="min-w-0">
            <h2 className="m-0 truncate font-heading text-[21px] font-extrabold leading-[1.15] tracking-[-0.03em] text-[var(--ai-t1)]">
              {name}
            </h2>
            {/* Email, then whichever of location and applied date exist. The
                separators are joined to their following item so a missing
                location does not leave a dot floating. */}
            <div className="mt-1 flex items-center gap-[9px] text-[12.5px] font-medium text-[var(--ai-t3)]">
              <b className="truncate font-semibold text-[var(--ai-t2)]">{row.email}</b>
              {location && (
                <>
                  <IdDot />
                  <span className="whitespace-nowrap">{location}</span>
                </>
              )}
              <IdDot />
              {/* The absolute date, not the list's "40d ago". A relative age
                  earns its place in a column being scanned; here it is the one
                  date on the record and the reader may be about to quote it. */}
              <span className="whitespace-nowrap">
                Applied {fmtDay(row.created_at, clock.local)}
              </span>
            </div>
          </div>

          <div className="flex-1" />

          {/* Mini ring only. The full card lives on Review, where the reader
              has the breakdown in front of them; this keeps the number
              itself on screen from every tab. Absent rather than a dashed
              placeholder when unscored — Review carries that explanation. */}
          {band && headerScore.overall != null && (
            <>
              <div className="flex shrink-0 items-center gap-[11px]">
                <DrawerMiniRing score={headerScore.overall} />
                <div>
                  <span className="block text-[12.5px] font-bold leading-[1.25] text-[var(--ai-t1)]">
                    {BAND_MATCH_LABEL[band]}
                  </span>
                  {/* The design's second line here is rank. Cut — nothing
                      computes it — so the slot closes up, except when a human
                      has overridden: then the number beside it is not the
                      AI's and the header has to say so. */}
                  {headerScore.adjusted && (
                    <span className="mt-0.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                      Adjusted
                    </span>
                  )}
                </div>
              </div>
              <span aria-hidden className="h-9 w-px shrink-0 bg-[var(--ai-line)]" />
            </>
          )}

          {/* The stage select used to sit mid-scroll, where the one edit a
              recruiter makes most often scrolled away from them.

              Neutral, where the design tints it blue. That blue is the mock's
              one stage showing through — there is no stage colour system to
              read it from, and painting all six blue would make the dot mean
              nothing. Shape, size and the leading dot match the design. */}
          <div className="flex shrink-0 items-center gap-2.5">
            <label
              htmlFor="applicant-stage"
              className="text-[11.5px] font-bold tracking-[0.02em] text-[var(--ai-t3)]"
            >
              Stage
            </label>
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute left-[13px] top-1/2 size-[7px] -translate-y-1/2 rounded-full bg-[var(--ai-t3)]"
              />
              <select
                id="applicant-stage"
                value={stage}
                disabled={saving}
                onChange={(e) => onStageChange(e.target.value as PipelineStage)}
                className="cursor-pointer appearance-none rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] py-[9px] pl-[30px] pr-[34px] text-[13px] font-bold text-[var(--ai-t1)] transition-colors hover:border-[var(--ai-line-strong)] focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.16] disabled:cursor-wait disabled:opacity-70"
              >
                {PIPELINE_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {PIPELINE_STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 size-3 -translate-y-1/2 text-[var(--ai-t1)] opacity-55"
                strokeWidth={1.8}
              />
            </div>
          </div>
        </div>

        <div className="flex gap-[26px]">
          {PANEL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`${PANEL_TAB_BASE} ${
                tab === t.key
                  ? "text-[var(--ai-t1)] after:bg-[var(--ai-sidebar)]"
                  : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Inset body, white cards on top — the design's `.pbody{background:var(--inset)}`.
          The contrast is what makes each section read as a card; on white the
          card borders were the only thing separating a section from the page.

          The panes UNMOUNT rather than hide: InterviewPanel fires three fetches
          on mount, and a display:none pane would still pay for all three on
          every open. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ai-inset)] px-[22px] pb-7 pt-[18px]">
        {/* Top of the body rather than inside a pane: it is the reason the panel
            was opened, and a reader who lands on Profile would never see it from
            behind a tab. Inside the scroller, so it shares the inset the design
            gives it — above it, the lime would sit in a white band of its own. */}
        {showsWorthALook(row) && (
          <div className="mb-5 flex items-center gap-3 rounded-2xl bg-remotiv-lime px-4 py-[13px]">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[rgba(20,16,32,0.1)] text-[#2F3A00]">
              <Flag className="size-[15px]" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <b className="block font-heading text-[13px] font-bold text-[#2F3A00]">
                Worth a look
              </b>
              {/* The design uses a second, lighter olive here. Held to one lime
                  ink at reduced opacity instead — see the banner's colour note
                  in the report: three olives would be three untokened hexes. */}
              <p className="m-0 mt-0.5 text-xs leading-[1.5] text-[#2F3A00]/70">
                {row.shortlist.reason?.trim() || "Met your auto-shortlist mark."}
              </p>
            </div>
            {/* Icon-only, per the design. The sentence that used to sit beside a
                text button — that dismissing clears the flag rather than hiding
                the person, and a materially better score re-flags them — has
                nowhere to go in this layout, so it becomes the button's title. */}
            <button
              type="button"
              disabled={dismissing === row.id}
              onClick={() => onDismissFlag(row.id)}
              aria-label="Dismiss flag"
              title="Clears the flag. A materially better score later flags them again."
              className="ml-auto grid size-[26px] shrink-0 place-items-center rounded-[9px] text-[#2F3A00]/70 transition-colors hover:bg-[rgba(20,16,32,0.1)] hover:text-[#2F3A00] disabled:opacity-40"
            >
              <X className="size-[13px]" strokeWidth={1.8} />
            </button>
          </div>
        )}

        {tab === "profile" && (
          /* The design's `.two`: a 1.32fr/1fr grid of `.stack` columns, with
             the same 20px between cards in both directions. */
          <div className="grid gap-5 min-[840px]:grid-cols-[minmax(0,1.32fr)_minmax(0,1fr)] min-[840px]:items-start">
            <div className="flex flex-col gap-5">
              <PaneCard title="Application">
                <p className="m-0 text-[13px] leading-relaxed text-[var(--ai-t3)]">
                  Applied to <b className="font-bold text-[var(--ai-t1)]">{row.job_title}</b> ·{" "}
                  {applied.main}
                </p>

                {/* The design's `.acts`: the actions sit under a hairline rather
                    than floating below the fact they act on. */}
                <div className="mt-4 flex gap-[9px] border-t border-[var(--ai-line-soft)] pt-4">
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
                    <File className="size-[15px]" strokeWidth={1.9} />
                    {cvLabel(row)}
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

                {/* Says WHY the button is dead, rather than leaving a greyed control
                    to be read as a bug. Only on expiry — "no CV" needs no excuse. */}
                {row.cv_expired && (
                  <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-[var(--ai-t4)]">
                    CVs are deleted 24 months after the application. Everything else on this
                    applicant is unaffected.
                  </p>
                )}
              </PaneCard>

              {row.screening_answers.length > 0 && (
                <PaneCard title="Screening questions">
                  {/* Provenance stated ONCE here rather than repeated on every
                    pill. The pills then stay short enough to sit inline beside
                    the answer, and this line can say the thing a pill never
                    could — that nobody verified any of it. */}
                  <p className="m-0 mb-2.5 text-[11.5px] leading-snug text-[var(--ai-t3)]">
                    Answered by the candidate at apply time and checked against the thresholds you
                    set. Self-reported — not verified by Remotiv.
                  </p>
                  <div className="flex flex-col gap-[9px]">
                    {row.screening_answers.map((a) => (
                      <div
                        key={a.question_id}
                        className="rounded-xl border border-[var(--ai-line)] px-[13px] py-[11px] transition-colors hover:border-[var(--ai-line-strong)] hover:bg-[var(--ai-inset)]"
                      >
                        <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs leading-snug text-[var(--ai-t3)]">
                          {a.question}
                          {/* Sits on the question, not the answer: "required" is
                            a property of what the employer asked, and an
                            unmatched essential is what turns a below-threshold
                            answer into a listed missing requirement. */}
                          {a.essential && (
                            <span className="shrink-0 rounded-full bg-[var(--ai-purple-tint)] px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--ai-purple-ink)]">
                              Essential
                            </span>
                          )}
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
                </PaneCard>
              )}
            </div>

            <div className="flex flex-col gap-5">
              {hasDetails && (
                <PaneCard title="Details">
                  {/* Each row is conditional, so `last:border-b-0` lands on
                      whichever row actually renders last — a `{cond && …}` that
                      resolves false produces no DOM node, so :last-child stays
                      correct. */}
                  <div className="flex flex-col">
                    {location && <DetailRow label="Location" value={location} />}
                    {experienceText && <DetailRow label="Experience" value={experienceText} />}
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
                </PaneCard>
              )}

              <PaneCard title="Stage history">
                <div className="flex flex-col gap-[14px]">
                  {history.map((h) => {
                    const when = fmtApplied(h.created_at, clock);
                    // The seeded first entry has no from_stage — it reads as plain
                    // "Applied" rather than an arrow from nowhere.
                    const meta = [h.changed_by_name, when.main].filter(Boolean).join(" · ");
                    return (
                      <div key={h.id} className="relative flex items-start gap-3">
                        <span
                          className={`z-[1] mt-[3px] size-[11px] shrink-0 rounded-full shadow-[0_0_0_1px_rgba(20,16,32,0.1)] ${STAGE_PILL[h.to_stage].dot}`}
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
                  {historyFailed && (
                    <p className="m-0 mb-3 text-[12.5px] leading-relaxed text-[var(--ai-danger)]">
                      Couldn't load this applicant's activity just now — it hasn't been lost. Close
                      the panel and reopen it to try again.
                    </p>
                  )}
                  {!historyLoading && !historyFailed && history.length === 0 && (
                    <div className="relative flex items-start gap-3">
                      <span className="z-[1] mt-[3px] size-[11px] shrink-0 rounded-full bg-[var(--ai-t4)] shadow-[0_0_0_1px_rgba(20,16,32,0.1)]" />
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
              </PaneCard>

              {/* Danger, last — same placement and weight as the jobs drawer's.
                  Opens a confirm rather than deleting on click; this is
                  irreversible and takes the CV with it. */}
              <PaneCard title="Danger">
                <button
                  type="button"
                  onClick={onDelete}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ai-danger-tint)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-danger)] transition-opacity hover:opacity-80"
                >
                  <Trash className="size-3.5" strokeWidth={2} />
                  Delete applicant
                </button>
                <p className="m-0 mt-2 text-[10px] leading-relaxed text-[var(--ai-t4)]">
                  Permanently removes this applicant, their CV file, their AI scorecard and their
                  pipeline history. This cannot be undone.
                </p>
              </PaneCard>
            </div>
          </div>
        )}

        {tab === "review" && (
          <>
            {/* The score card. It leads Review because it is the answer the
                rest of the tab is evidence for — the ring, the verdict, and
                the terms under which the number was produced. */}
            <div className="mb-7 rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
              {headerScore.status === "scored" && headerScore.overall != null ? (
                <div className="grid items-center gap-[30px] px-[26px] py-6 min-[840px]:grid-cols-[auto_minmax(0,1fr)_auto]">
                  <div className="flex flex-col items-center gap-[11px]">
                    <ReviewScoreRing score={headerScore.overall} />
                    {/* Subordinate to the verdict beside it: the model's
                        sentence is the considered answer, this is only which
                        side of a threshold the number fell. When the two
                        disagree — an 81 reads "Strong" while the verdict is
                        cautious — the sentence wins. */}
                    {band && (
                      <span
                        className={`whitespace-nowrap rounded-full px-[11px] py-1 text-[10.5px] font-bold uppercase tracking-[0.06em] ${BAND_PILL[band]}`}
                      >
                        {BAND_LABEL[band]}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0">
                    {/* v1-v3 scorecards predate the verdict and simply have
                        none — the line is omitted rather than guessed at. */}
                    {scoreDetail?.verdict ? (
                      <h2 className="m-0 font-heading text-[19px] font-extrabold leading-[1.25] tracking-[-0.03em] text-[var(--ai-t1)]">
                        {scoreDetail.verdict}
                      </h2>
                    ) : null}

                    <div className="mt-[9px] flex items-start gap-[9px] text-[12.5px] leading-[1.55] text-[var(--ai-t2)]">
                      {headerScore.confidence && (
                        <span
                          className={`mt-px inline-flex shrink-0 items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[10.5px] font-bold ${CONFIDENCE_BADGE[headerScore.confidence]?.pill ?? ""}`}
                        >
                          <span
                            className={`size-[5px] rounded-full ${CONFIDENCE_BADGE[headerScore.confidence]?.dot ?? ""}`}
                          />
                          {CONFIDENCE_LABEL[headerScore.confidence]}
                        </span>
                      )}
                      <span>
                        {headerScore.confidence
                          ? "Based on how much the CV actually showed."
                          : "Scored against this job's stated requirements."}
                        {/* NOT "completed": screening_score is the weighted
                            share of thresholds MET (computeScreeningScore
                            counts a.matched), so someone who answered
                            everything but met nothing scores 0%, not 100%. */}
                        {scoreDetail?.screening_score != null && (
                          <> Self-reported thresholds met: {scoreDetail.screening_score}%.</>
                        )}
                      </span>
                    </div>

                    {/* When a human has overridden, the AI's own number stays
                        on screen beside theirs. Hiding it would leave nothing
                        to calibrate against — the pair, and the gap between
                        them, is the whole signal this feature collects. */}
                    {headerScore.adjusted && headerScore.ai_overall != null && (
                      <p className="m-0 mt-[9px] text-[12.5px] leading-[1.55] text-[var(--ai-t2)]">
                        <span className="font-semibold text-[var(--ai-t1)]">
                          AI scored {headerScore.ai_overall}
                        </span>
                        {adjustmentByline(scoreDetail, clock.local)}
                      </p>
                    )}

                    <p className="m-0 mt-[11px] max-w-[520px] border-t border-[var(--ai-line-soft)] pt-[11px] text-[11px] leading-[1.6] text-[var(--ai-t3)]">
                      Scored from written application text only. Remotiv AI does not analyse face,
                      voice or accent, and the score is advisory — a person decides.
                      {scoreProvenance(scoreDetail, clock.local)}
                    </p>
                  </div>

                  <div className="flex flex-col items-stretch gap-2">
                    {/* Re-score is omitted when stale: the staleness banner
                        further down carries the same action, and that is the
                        one a reader should reach for — it says why re-scoring
                        matters. Adjust is never omitted. */}
                    {canRescore && !scoreDetail?.stale && (
                      <>
                        <button
                          type="button"
                          onClick={onRescore}
                          disabled={rescoring}
                          className={REVIEW_BTN_SEC}
                        >
                          <RotateCcw className="size-[14px]" strokeWidth={2} />
                          {rescoring ? "Queueing…" : "Re-score"}
                        </button>
                        {/* The cost stays visible rather than becoming a
                            tooltip — it is money, and a tooltip is invisible
                            on a touch screen. */}
                        <span className="text-center text-[11px] leading-[1.5] text-[var(--ai-t3)]">
                          About two cents
                        </span>
                      </>
                    )}
                    {scoreDetail && !adjusting && (
                      <button
                        type="button"
                        onClick={() => setAdjusting(true)}
                        disabled={scoreSaving}
                        className={REVIEW_BTN_SEC}
                      >
                        {scoreDetail.adjusted ? "Edit adjustment" : "Adjust score"}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* Solid border for scoring-off, dashed for the rest — same
                   reasoning as PendingScore: dashed reads as "in progress",
                   and nothing is in progress on a job with scoring off. */
                <div
                  className={`m-px rounded-[19px] border px-[26px] py-7 text-center ${
                    isScoringOff(headerScore)
                      ? "border-transparent"
                      : "border-dashed border-[var(--ai-line-strong)]"
                  }`}
                >
                  <b className="mb-[3px] block text-[13px] text-[var(--ai-t1)]">
                    {drawerScoreHeading(headerScore)}
                  </b>
                  <span className="text-xs leading-relaxed text-[var(--ai-t3)]">
                    {headerScore.error ??
                      "The breakdown appears here once this CV has been scored."}
                  </span>
                  {/* These rows get no ring and so no action column, but the
                      judgement is still available to them — see
                      ScoreAdjustForm. Without this the failed and skipped
                      cards would have no way to reach the adjuster at all. */}
                  {scoreDetail && !adjusting && (
                    <button
                      type="button"
                      onClick={() => setAdjusting(true)}
                      disabled={scoreSaving}
                      className={`${ADJ_BTN_QUIET} mt-3.5`}
                    >
                      {scoreDetail.adjusted ? "Edit adjustment" : "Score it yourself"}
                    </button>
                  )}
                </div>
              )}

              {/* The adjuster lives in the card the button that opens it sits
                  in, not in a block of its own at the foot of the tab. The
                  number being corrected and the field correcting it are one
                  thought, and a reviewer should not have to scroll past the
                  whole breakdown to find the form they just asked for. */}
              {scoreDetail && adjusting && (
                <ScoreAdjustForm
                  detail={scoreDetail}
                  saving={scoreSaving}
                  onSave={onAdjustScore}
                  onClose={() => setAdjusting(false)}
                />
              )}
              {scoreDetail?.adjusted && !adjusting && (
                <AdjustmentRecord
                  detail={scoreDetail}
                  saving={scoreSaving}
                  onEdit={() => setAdjusting(true)}
                  onClear={onClearAdjustment}
                  local={clock.local}
                />
              )}
            </div>

            {scoreDetail?.status === "scored" && (
              <>
                {scoreDetail.summary && (
                  <div className={`${CARD_SURFACE} mb-7 px-[22px] py-5`}>
                    <div className="mb-3.5 flex items-center justify-between gap-4">
                      <h3 className="m-0 whitespace-nowrap font-heading text-[15px] font-bold tracking-[-0.02em] text-[var(--ai-t1)]">
                        Summary
                      </h3>
                      {/* Real, unlike most of the design's sub-lines. The
                          answers are frozen at apply time and the scorer is
                          handed them as context alongside the CV, so the count
                          on the row is the count the model read. */}
                      <span className="text-right text-[11px] font-medium text-[var(--ai-t3)]">
                        {summarySource(row.screening_answers.length)}
                      </span>
                    </div>
                    <p className="m-0 text-[13px] leading-[1.72] text-[var(--ai-t2)]">
                      {scoreDetail.summary}
                    </p>
                  </div>
                )}

                {scoreDetail.dimensions.length > 0 && (
                  <div className="mb-7">
                    <ReviewSubhead title="Scored dimensions" meta={dimensionsMeta(scoreDetail)} />
                    <div className={`${CARD_SURFACE} py-1`}>
                      {scoreDetail.dimensions.map((d) => (
                        <ScoredDimension key={d.dimension} dimension={d} />
                      ))}
                    </div>
                  </div>
                )}

                <div className="mb-7">
                  <ReviewSubhead title="Evidence" meta={evidenceMeta(scoreDetail)} />
                  {/* All four boxes, always. An absent box used to mean "the
                      model found none", which is a finding, and it read as
                      missing UI — worst on the strongest candidates, where
                      Missing requirements and Risks are empty precisely
                      because there is nothing wrong. */}
                  <div className="grid gap-4 min-[840px]:grid-cols-2">
                    <EvidenceList
                      label="Strengths"
                      badge="bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]"
                      dot="bg-remotiv-green"
                      count={String(scoreDetail.strengths.length)}
                    >
                      {/* Each strength carries its own quote — no pairing
                          by position, which is what misattributed quotes
                          in v1. The quote stays behind its toggle, unlike
                          the dimensions': a strong card runs to eight of
                          these, and the design's supporting sentence is
                          prose it wrote where ours is a verbatim CV span
                          that would read as prose if set inline. */}
                      {scoreDetail.strengths.map((str) => (
                        <EvidenceRow key={str.point} tone="ok">
                          {str.point}
                          {str.quote && <EvidenceQuote quote={str.quote} />}
                        </EvidenceRow>
                      ))}
                      {scoreDetail.strengths.length === 0 && (
                        <EvidenceEmpty>
                          Nothing in the CV was evidenced strongly enough to quote.
                        </EvidenceEmpty>
                      )}
                    </EvidenceList>

                    <EvidenceList
                      label="Must-haves met"
                      badge="bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                      dot="bg-remotiv-purple"
                      count={mustHaveCount(scoreDetail)}
                    >
                      {scoreDetail.must_haves.map((mh) => (
                        <EvidenceRow key={mh.item} tone={mh.status === "evidenced" ? "ok" : "warn"}>
                          {mh.item}
                          {mh.status === "not_found" && (
                            <>
                              {" — "}
                              <b className="font-bold text-[var(--ai-t1)]">not evidenced</b>
                            </>
                          )}
                          {mh.status === "evidenced" && mh.quote && (
                            <EvidenceQuote quote={mh.quote} />
                          )}
                        </EvidenceRow>
                      ))}
                      {/* The one box whose empty state is not self-evident.
                          Nothing on the card distinguishes "the job asks for
                          none" from "written before the job asked" — only the
                          job's count does, so it decides which is said. */}
                      {scoreDetail.must_haves.length === 0 && (
                        <EvidenceEmpty>
                          {scoreDetail.job_must_have_count === 0
                            ? "This job names no must-haves, so there was nothing to check the CV against."
                            : `This score was written before the job named its ${scoreDetail.job_must_have_count === 1 ? "must-have" : `${scoreDetail.job_must_have_count} must-haves`}, so they were never checked. Re-scoring fills this in.`}
                        </EvidenceEmpty>
                      )}
                    </EvidenceList>

                    <EvidenceList
                      label="Missing requirements"
                      badge="bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]"
                      dot="bg-[var(--ai-danger)]"
                      count={String(scoreDetail.missing_requirements.length)}
                    >
                      {scoreDetail.missing_requirements.map((m) => (
                        <EvidenceRow key={m} tone="danger">
                          {m}
                        </EvidenceRow>
                      ))}
                      {scoreDetail.missing_requirements.length === 0 && (
                        <EvidenceEmpty>
                          Every requirement the job states was evidenced somewhere in the CV.
                        </EvidenceEmpty>
                      )}
                    </EvidenceList>

                    <EvidenceList
                      label="Risks to verify"
                      badge="bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]"
                      dot="bg-[var(--ai-amber-dot)]"
                      count={String(scoreDetail.concerns.length)}
                    >
                      {scoreDetail.concerns.map((c) => (
                        <EvidenceRow key={c} tone="warn">
                          {c}
                        </EvidenceRow>
                      ))}
                      {scoreDetail.concerns.length === 0 && (
                        <EvidenceEmpty>
                          No contradictions or gaps were raised against the CV.
                        </EvidenceEmpty>
                      )}
                    </EvidenceList>
                  </div>
                </div>
              </>
            )}

            {/* Staleness + re-score. The action sits in the banner rather than
                in a menu because the flag and its remedy are the same thought;
                the card's Re-score is suppressed while this is on screen, so
                there is one button and it is the one that says why. */}
            {scoreDetail?.stale && (
              <div className="mt-[22px] rounded-[13px] border border-[var(--ai-amber-dot)] bg-[var(--ai-amber-tint)] px-4 py-3.5">
                <p className="m-0 text-[13px] font-semibold text-[var(--ai-amber-ink)]">
                  Scored against older criteria
                </p>
                <p className="m-0 mt-1 text-xs leading-relaxed text-[var(--ai-amber-ink)]">
                  This job&apos;s requirements or screening questions have changed since this CV was
                  scored, so the numbers below were judged against a different brief.
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

            {/* The strip is now only for rows the card above cannot carry the
                action for: failed, skipped and pending scorecards, which get
                no action column because they get no ring. Scored rows take
                the button in the card, stale ones take it in the banner — the
                action never appears twice. */}
            {scoreDetail && !scoreDetail.stale && canRescore && headerScore.status !== "scored" && (
              <div className="mt-[22px] flex items-center justify-between gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 py-3">
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
          </>
        )}

        {tab === "comm" && (
          /* One card for the whole trail, as the design has it — the messages
             are one continuous record, and a card each would read as four
             unrelated events. The design's `.chead` carries a "New message"
             button; there is no composer in this drawer, so the head is the
             title alone rather than a control that does nothing. */
          <PaneCard title="Messages sent">
            <div className="flex flex-col gap-2.5">
              {messagesLoading && messages.length === 0 && (
                <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
              )}
              {!messagesLoading && messages.length === 0 && (
                <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">No messages sent yet.</p>
              )}
              {messages.map((m) => (
                <MessageEntry key={m.id} message={m} />
              ))}
            </div>
          </PaneCard>
        )}

        {tab === "interviews" && (
          /* ONE card, not one per section. The design's Interviews pane is a
             different feature — a results ring, the employer's criteria and
             per-question transcripts — and its cards map onto nothing we hold.
             Ours is a single decision taken in three places (async, live,
             booking) whose boxes appear and vanish with the job's settings, so
             a card per section would leave a page of empty heads. */
          <PaneCard title="Video interview">
            <InterviewPanel applicationId={row.id} onToast={onToast} />
          </PaneCard>
        )}

        {tab === "comments" && (
          <CommentsPane
            applicationId={row.id}
            initial={comments}
            loading={commentsLoading}
            viewerMemberId={viewerMemberId}
            viewerRole={viewerRole}
            onToast={onToast}
          />
        )}
      </div>
    </div>
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

// ── Comments ─────────────────────────────────────────────────

const COMMENT_BTN =
  "border-none bg-transparent p-0 text-[11px] font-bold text-[var(--ai-t3)] transition-colors disabled:opacity-40";
const COMMENT_TEXTAREA =
  "w-full resize-y rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-3 text-[13.5px] leading-relaxed text-[var(--ai-t1)] outline-none transition-colors placeholder:text-[var(--ai-t4)] hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const COMMENT_PRIMARY =
  "inline-flex shrink-0 items-center rounded-full border border-remotiv-purple bg-remotiv-purple px-4 py-2 text-[12.5px] font-bold text-white transition-colors hover:bg-[var(--ai-purple-hover,#6D38F0)] disabled:cursor-not-allowed disabled:opacity-40";
const COMMENT_GHOST =
  "rounded-full border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3.5 py-1.5 text-[12px] font-bold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white";

type CommentsResult = { ok: true; comments: ApplicantComment[] } | { ok: false; error: string };

/**
 * The hiring team's thread. Composer at the top, then the conversation
 * oldest-first, replies indented one level under their root.
 *
 * The server is the only source of the list: every mutation returns the whole
 * thread and this replaces state with it wholesale. No optimistic insert —
 * unlike a stage change, a comment has no local id to paint with, and a
 * half-rendered one that then failed would be worse than a moment's wait.
 */
function CommentsPane({
  applicationId,
  initial,
  loading,
  viewerMemberId,
  viewerRole,
  onToast,
}: {
  applicationId: string;
  initial: ApplicantComment[];
  loading: boolean;
  viewerMemberId: string;
  viewerRole: CompanyRole;
  onToast: (message: string) => void;
}) {
  const [comments, setComments] = useState(initial);
  useEffect(() => {
    setComments(initial);
  }, [initial]);

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Mirrors deleteApplicationComment's own test. The action re-checks it — this
  // only decides whether to offer a button that would otherwise always fail.
  const moderator = viewerRole === "owner" || viewerRole === "admin";

  /** Roots in order, each with its replies. A reply always has its root: the
      one-level FK cascades, and a root with replies tombstones rather than
      going, so nothing can be orphaned underneath. */
  const threads = useMemo(() => {
    const byParent = new Map<string, ApplicantComment[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const seen = byParent.get(c.parentId);
      if (seen) seen.push(c);
      else byParent.set(c.parentId, [c]);
    }
    return comments
      .filter((c) => c.parentId === null)
      .map((root) => ({ root, replies: byParent.get(root.id) ?? [] }));
  }, [comments]);

  /** Tombstones hold a place, not a comment, so they are not counted. */
  const liveCount = comments.filter((c) => c.deletedAt === null).length;

  async function run(fn: () => Promise<CommentsResult>, success?: string) {
    setBusy(true);
    const res = await fn().catch(
      (): CommentsResult => ({ ok: false, error: "Something went wrong. Please try again." }),
    );
    setBusy(false);
    if (!res.ok) {
      onToast(res.error);
      return false;
    }
    setComments(res.comments);
    if (success) onToast(success);
    return true;
  }

  function beginEdit(c: ApplicantComment) {
    setReplyTo(null);
    setEditingId(c.id);
    setEditDraft(c.body ?? "");
  }

  const actionsFor = (c: ApplicantComment, repliable: boolean, editLocked: boolean) => (
    <CommentActions
      repliable={repliable}
      editLocked={editLocked}
      mine={c.authorMemberId === viewerMemberId && viewerMemberId !== ""}
      moderator={moderator}
      busy={busy}
      onReply={() => {
        setEditingId(null);
        setReplyTo(c.id);
        setReplyDraft("");
      }}
      onEdit={() => beginEdit(c)}
      onDelete={() => {
        void run(() => deleteApplicationComment(applicationId, c.id), "Comment deleted");
      }}
    />
  );

  return (
    <PaneCard title="Team comments" meta={liveCount > 0 ? `${liveCount}` : undefined}>
      <textarea
        value={draft}
        maxLength={COMMENT_MAX}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="What do you make of this candidate?"
        className={`min-h-[96px] ${COMMENT_TEXTAREA}`}
      />
      <div className="mt-[11px] flex items-start justify-between gap-3">
        {/* The disclosure sits ON the composer, not in a settings page nobody
            opens. These are recorded opinions about a named person and they are
            that person's data, so they come back in a subject access request.
            People write differently when they know that, which is the point. */}
        <span className="flex items-start gap-[7px] text-[11.5px] leading-snug text-[var(--ai-t3)]">
          <Users className="mt-[2px] size-[13px] shrink-0 text-[var(--ai-t4)]" strokeWidth={1.9} />
          <span>
            Visible to everyone on this job&apos;s team. Comments are part of the candidate&apos;s
            record and may be disclosed if they ask for their data.
          </span>
        </span>
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => {
            void run(() => addApplicationComment(applicationId, draft)).then((ok) => {
              if (ok) setDraft("");
            });
          }}
          className={`${COMMENT_PRIMARY} shadow-[0_5px_16px_rgba(126,71,255,0.28)] disabled:shadow-none`}
        >
          Comment
        </button>
      </div>

      {loading && comments.length === 0 && (
        <div className="mt-4 h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
      )}

      {!loading && comments.length === 0 && (
        <p className="m-0 mt-3.5 border-t border-[var(--ai-line-soft)] pt-3.5 text-[11.5px] leading-relaxed text-[var(--ai-t4)]">
          No comments yet. Comments are attributed and timestamped, and you can reply to one, or
          edit and delete your own — your teammates&apos; stay as they wrote them.
        </p>
      )}

      {threads.length > 0 && (
        <div className="mt-4 flex flex-col gap-4 border-t border-[var(--ai-line-soft)] pt-4">
          {threads.map(({ root, replies }) => (
            <div key={root.id} className="flex flex-col gap-3">
              {editingId === root.id ? (
                <CommentEditor
                  value={editDraft}
                  busy={busy}
                  onChange={setEditDraft}
                  onCancel={() => setEditingId(null)}
                  onSave={() => {
                    void run(() =>
                      updateApplicationComment(applicationId, root.id, editDraft),
                    ).then((ok) => {
                      if (ok) setEditingId(null);
                    });
                  }}
                />
              ) : (
                <CommentEntry
                  comment={root}
                  actions={
                    root.deletedAt === null ? actionsFor(root, true, replies.length > 0) : null
                  }
                />
              )}

              {(replies.length > 0 || replyTo === root.id) && (
                /* Indented to clear the root's avatar, with a rule down the
                   left so a long thread still reads as one exchange rather
                   than as comments that happen to sit close together. */
                <div className="ml-[34px] flex flex-col gap-3 border-l border-[var(--ai-line)] pl-3.5">
                  {replies.map((r) =>
                    editingId === r.id ? (
                      <CommentEditor
                        key={r.id}
                        value={editDraft}
                        busy={busy}
                        onChange={setEditDraft}
                        onCancel={() => setEditingId(null)}
                        onSave={() => {
                          void run(() =>
                            updateApplicationComment(applicationId, r.id, editDraft),
                          ).then((ok) => {
                            if (ok) setEditingId(null);
                          });
                        }}
                      />
                    ) : (
                      <CommentEntry
                        key={r.id}
                        comment={r}
                        actions={r.deletedAt === null ? actionsFor(r, false, false) : null}
                      />
                    ),
                  )}

                  {replyTo === root.id && (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={replyDraft}
                        maxLength={COMMENT_MAX}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        placeholder={`Reply to ${root.authorName}`}
                        className={`min-h-[72px] ${COMMENT_TEXTAREA} text-[12.5px]`}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setReplyTo(null)}
                          className={COMMENT_GHOST}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={busy || !replyDraft.trim()}
                          onClick={() => {
                            void run(() =>
                              addApplicationComment(applicationId, replyDraft, root.id),
                            ).then((ok) => {
                              if (ok) {
                                setReplyTo(null);
                                setReplyDraft("");
                              }
                            });
                          }}
                          className={`${COMMENT_PRIMARY} px-3.5 py-1.5 text-[12px]`}
                        >
                          Reply
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PaneCard>
  );
}

/**
 * The reply/edit/delete row under one comment.
 *
 * Top-level rather than nested inside CommentsPane: a component declared in a
 * render body is a new type on every pass, so React unmounts and remounts it —
 * which would drop keyboard focus off these buttons whenever anything in the
 * thread changed.
 */
function CommentActions({
  repliable,
  editLocked,
  mine,
  moderator,
  busy,
  onReply,
  onEdit,
  onDelete,
}: {
  /** Roots only — a reply has nothing that may hang off it. */
  repliable: boolean;
  /** A colleague has already answered this one. */
  editLocked: boolean;
  mine: boolean;
  moderator: boolean;
  busy: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      {repliable && (
        <button
          type="button"
          onClick={onReply}
          className={`${COMMENT_BTN} hover:text-remotiv-purple`}
        >
          Reply
        </button>
      )}
      {/* Editing closes once a colleague has answered: rewriting words someone
          has already replied to would leave their reply answering something
          that was never said. The action enforces it — this keeps the button
          from offering what it cannot do, and says why to the one person who
          would go looking for it. */}
      {mine && !editLocked && (
        <button
          type="button"
          onClick={onEdit}
          className={`${COMMENT_BTN} hover:text-remotiv-purple`}
        >
          Edit
        </button>
      )}
      {mine && editLocked && (
        <small className="text-[11px] text-[var(--ai-t4)]">Replied to — editing closed</small>
      )}
      {(mine || moderator) && (
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className={`${COMMENT_BTN} hover:text-[var(--ai-danger)]`}
        >
          Delete
        </button>
      )}
    </span>
  );
}

/**
 * One comment, live or removed.
 *
 * A tombstone keeps the same two lines a live comment has — body then byline —
 * so the thread's rhythm holds and a reply underneath still knows who it was
 * answering. What it does NOT do is name who removed it: the row records the
 * author and the time, not the hand that deleted, and a moderator's deletion
 * attributed to the author would be a lie. "Removed" alone, in the passive, is
 * the only claim the data supports.
 */
function CommentEntry({
  comment,
  actions,
}: {
  comment: ApplicantComment;
  /** Null on a tombstone — there is nothing left to reply to, edit or delete. */
  actions: React.ReactNode;
}) {
  const removed = comment.deletedAt !== null;
  const edited = comment.updatedAt !== comment.createdAt && !removed;

  return (
    <div className="flex gap-2.5">
      {removed ? (
        <span className="mt-px size-6 shrink-0 rounded-full border border-dashed border-[var(--ai-line-strong)]" />
      ) : (
        <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--ai-mint-tint)] text-[9.5px] font-extrabold text-[var(--ai-mint-ink)]">
          {msgInitials(comment.authorName)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {removed ? (
          <p className="m-0 text-[12.5px] italic leading-relaxed text-[var(--ai-t4)]">
            This comment was removed.
          </p>
        ) : (
          <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
            {comment.body}
          </p>
        )}
        <div className="mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-1">
          <small className="text-[11px] text-[var(--ai-t4)]">
            {comment.authorName} · {fmtMessageWhen(comment.createdAt)}
            {/* An edit is disclosed rather than silent — words that changed
                after a colleague read them should say so. */}
            {edited ? " · edited" : ""}
          </small>
          {actions}
        </div>
      </div>
    </div>
  );
}

function CommentEditor({
  value,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        maxLength={COMMENT_MAX}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[80px] w-full resize-y rounded-xl border border-remotiv-purple bg-[var(--ai-surface)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--ai-t1)] outline-none ring-[3px] ring-remotiv-purple/[0.16]"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={COMMENT_GHOST}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={onSave}
          className={`${COMMENT_PRIMARY} px-3.5 py-1.5 text-[12px]`}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * One section of a pane: the design's `.card.cpad` with its `.chead`.
 *
 * Replaces DrawerLabel wherever a pane's sections became cards. The label was
 * an uppercase rule-and-caption that worked on a white body; on the inset body
 * the card's own edge does that job, and the design heads each card with a
 * 15px Sora title instead.
 *
 * `meta` is the right-aligned sub-line the design puts beside some titles
 * ("Answered 3 of 3 · 17 Sep"). Omitted rather than invented where we hold no
 * equivalent fact — same rule as ReviewSubhead's.
 */
function PaneCard({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${CARD_SURFACE} px-[22px] py-5`}>
      <div className="mb-3.5 flex items-center justify-between gap-4">
        <h3 className="m-0 whitespace-nowrap font-heading text-[15px] font-bold tracking-[-0.02em] text-[var(--ai-t1)]">
          {title}
        </h3>
        {meta && (
          <span className="text-right text-[11px] font-medium text-[var(--ai-t3)]">{meta}</span>
        )}
      </div>
      {children}
    </section>
  );
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
  viewerMemberId,
  applicants: initialApplicants,
  loadFailed,
  newThisWeek,
  openRoles,
  companyName,
  replyToAddress,
  manualTemplates,
  unassigned,
  renderedAt,
}: {
  viewerRole: CompanyRole;
  /**
   * The viewer's own company_members.id, for deciding which comments carry an
   * Edit and a Delete. Compared client-side only as a display rule — every
   * mutation re-derives it server-side and puts it on the statement itself.
   */
  viewerMemberId: string;
  applicants: CompanyApplicantRow[];
  /** The list could not be READ. Distinct from "this pipeline is empty". */
  loadFailed: boolean;
  newThisWeek: number;
  openRoles: number;
  companyName: string;
  replyToAddress: string | null;
  manualTemplates: ManualTemplate[];
  /** True for a scoped member on no hiring teams — see the empty state. */
  unassigned: boolean;
  /**
   * The SERVER's clock at render time, so the server pass and the hydrating
   * client pass agree on "2d ago". Replaced by the live clock once hydrated.
   */
  renderedAt: number;
}) {
  // Same predicate the server action enforces (owner / admin / recruiter).
  // Hiring managers review candidates but do not spend the company's scoring
  // budget — rescoreApplication would reject them anyway; this stops the UI
  // offering a button that can only fail.
  const canRescore = canCreateJobs(viewerRole);
  const router = useRouter();

  // Local copy so a delete can drop the row immediately. Re-synced whenever
  // the server sends a fresh list, the same pattern the jobs list uses.
  const [applicants, setApplicants] = useState<CompanyApplicantRow[]>(initialApplicants);
  useEffect(() => {
    setApplicants(initialApplicants);
  }, [initialApplicants]);

  const [tab, setTab] = useState<"all" | PipelineStage>("all");
  const [jobFilter, setJobFilter] = useState("all");
  /** The Flagged chip: a filter alongside the stage tabs, not one of them. */
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  /** Server aggregate over the workspace — never a count of rendered rows. */
  const [flaggedCount, setFlaggedCount] = useState<number | null>(null);
  /** The id mid-dismiss, so one chip disables without freezing the list. */
  const [dismissing, setDismissing] = useState<string | null>(null);

  /*
   * The Flagged badge, from a server aggregate.
   *
   * Deliberately NOT `rows.filter(showsWorthALook).length`: the badge is a claim
   * about the workspace and the table shows a page, so a client count would
   * quietly become wrong the moment the list is genuinely paged. Re-fetched
   * whenever the job filter moves, because the count is scoped the same way.
   */
  useEffect(() => {
    let cancelled = false;
    countFlaggedApplicants(jobFilter === "all" ? {} : { jobId: jobFilter })
      .then((read) => {
        // null is what this component already uses for "no number to show", and
        // it is what the .catch below has always set. A failed count now takes
        // the same path instead of arriving as a confident 0.
        if (!cancelled) setFlaggedCount(read.ok ? read.value : null);
      })
      .catch(() => {
        if (!cancelled) setFlaggedCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobFilter]);

  /**
   * Dismiss a flag optimistically, reverting if the server refuses.
   *
   * The row is re-rendered without its chip immediately — a dismiss that waits
   * on a round trip feels broken — and `router.refresh()` reconciles with the
   * server afterwards. On failure the toast says so and the refresh puts the
   * chip back, so the UI never keeps a lie.
   */
  async function dismissFlag(id: string) {
    if (dismissing) return;
    setDismissing(id);
    setFlaggedCount((n) => (typeof n === "number" ? Math.max(0, n - 1) : n));
    const result = await dismissShortlistFlagAction(id);
    setDismissing(null);
    if (!result.success) {
      setToast(result.error);
    }
    // Either way: success needs the row's stored flag cleared, failure needs the
    // optimistic change undone. One refresh covers both.
    router.refresh();
  }
  // Seeded from ?q= so a topbar search result lands on this list already
  // filtered, rather than on an unfiltered page the reader has to search again.
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  /**
   * Opened from ?applicant=, so a notification about ONE candidate opens that
   * candidate.
   *
   * No filter is touched to get there. `rows` holds every applicant this member
   * can see — the server pages the whole set in, and the tab, job filter and
   * pagination are applied further down for display only — so the drawer opens
   * on someone the current view is not showing, which is the point: a link from
   * the bell should not depend on which tab was left selected.
   *
   * ── Why an effect and NOT a useState initialiser ─────────────
   *
   * Seeding at first render put the drawer in the SERVER HTML, which is the one
   * thing that separated this path from a click. The drawer is a `fixed`
   * overlay with a backdrop-blur, inside `.ai-shell`'s `zoom: 0.82` — and in
   * the window before the Tailwind chunk applies, that markup is laid out once
   * unstyled and again once the sheet lands, which is what painted it twice,
   * offset. A click can never hit that window because it happens long after
   * hydration.
   *
   * Opening in an effect makes the deep link behave exactly like a click: the
   * drawer is absent from the server HTML and mounts after hydration. It costs
   * one frame — the list paints, then the drawer opens over it.
   *
   * This is a mitigation, not a cure. Any fixed overlay that IS server-rendered
   * inside .ai-shell can still hit the same window.
   */
  const hydrated = useIsHydrated();
  const clock = useMemo<PageClock>(
    // Date.now() inside a memo is deliberate: it is read ONCE, on the render
    // where `hydrated` flips, and never again. A live-ticking clock would
    // rerender the whole list to change nothing most minutes.
    () => ({ now: hydrated ? Date.now() : renderedAt, local: hydrated }),
    [hydrated, renderedAt],
  );

  const deepLinkId = searchParams.get("applicant");
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (deepLinkId) setOpenId(deepLinkId);
  }, [deepLinkId]);

  /**
   * Which pane the panel is showing. Seeded from ?tab= by the same effect
   * pattern as openId, and held HERE rather than inside the panel: the panel is
   * keyed by applicant id and remounts when prev/next moves, so panel-local tab
   * state would drop the reader back to Profile on every step.
   */
  const deepLinkTab = searchParams.get("tab");
  const [panelTab, setPanelTab] = useState<PanelTab>("profile");
  useEffect(() => {
    if (isPanelTab(deepLinkTab)) setPanelTab(deepLinkTab);
  }, [deepLinkTab]);

  /**
   * The address bar follows the panel.
   *
   * ?applicant= was inbound-only before this: a deep link opened the right
   * person, but opening one by clicking never wrote the URL, and closing left
   * the param behind — so a reload reopened a panel the reader had shut. Both
   * directions now go through here.
   *
   * `replace`, not `push`: stepping through twelve applicants should not put
   * twelve entries in the history stack for Back to walk out of one at a time.
   * `scroll: false` because the list behind is exactly where it was.
   */
  const pathname = usePathname();
  const syncPanelUrl = useCallback(
    (applicantId: string | null, tab: PanelTab) => {
      const params = new URLSearchParams(searchParams.toString());
      if (applicantId) {
        params.set("applicant", applicantId);
        params.set("tab", tab);
      } else {
        params.delete("applicant");
        params.delete("tab");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const openApplicant = useCallback(
    (id: string) => {
      setOpenId(id);
      syncPanelUrl(id, panelTab);
    },
    [syncPanelUrl, panelTab],
  );

  const closePanel = useCallback(() => {
    setOpenId(null);
    syncPanelUrl(null, panelTab);
  }, [syncPanelUrl, panelTab]);

  const selectPanelTab = useCallback(
    (tab: PanelTab) => {
      setPanelTab(tab);
      if (openId) syncPanelUrl(openId, tab);
    },
    [syncPanelUrl, openId],
  );
  /** "Review top 10" — a view mode over the same filtered set, not a filter. */
  const [topOnly, setTopOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>("best");
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<CompanyApplicantRow | null>(null);
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
  const [stageOverrides, setStageOverrides] = useState<Record<string, PipelineStage>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [history, setHistory] = useState<StageHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [scoreDetail, setScoreDetail] = useState<ApplicantScoreDetail | null>(null);
  /** The team's thread, loaded with the rest of the detail. */
  const [comments, setComments] = useState<ApplicantComment[]>([]);
  const [scoreSaving, setScoreSaving] = useState(false);
  /** Same optimistic-override trick as stageOverrides, for the list's ring. */
  const [scoreOverrides, setScoreOverrides] = useState<Record<string, ApplicantScore>>({});

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

  /** Everything the tabs, job filter, flag and search select — in no order. */
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "all" && stageOf(r) !== tab) return false;
      if (jobFilter !== "all" && r.job_id !== jobFilter) return false;
      if (flaggedOnly && !showsWorthALook(r)) return false;
      if (q) {
        const blob = `${fullName(r)} ${r.email}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [rows, tab, jobFilter, search, flaggedOnly]);

  /**
   * The same set, ALWAYS in score order, whatever the display sort is.
   *
   * "Top match" and "Review top 10" are claims about the score and have to be
   * computed from a score-ranked list. Reading them off the displayed order
   * would make "Review top 10" show the ten most RECENT scored candidates the
   * moment someone switches to Newest — a label asserting something the data
   * behind it no longer says.
   */
  const byScore = useMemo(() => [...matching].sort(compareByScore), [matching]);

  /** What the list actually renders. The only thing the sort control changes. */
  const filtered = useMemo(
    () => (sort === "newest" ? [...matching].sort(compareByNewest) : byScore),
    [matching, byScore, sort],
  );

  /**
   * The ids wearing a "Top match" chip: scored >= 90, best first, capped.
   * Computed over the WHOLE result set rather than the current page so a
   * candidate doesn't gain or lose the chip by being paginated — and off
   * `byScore` rather than `filtered` so it cannot change with the sort either.
   */
  const topMatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of byScore) {
      if (ids.size >= TOP_MATCH_MAX_CHIPS) break;
      if (r.score.status === "scored" && (r.score.overall ?? 0) >= TOP_MATCH_MIN_SCORE) {
        ids.add(r.id);
      }
    }
    return ids;
  }, [byScore]);

  /** Scored candidates only — "top 10" of a pending list would be arbitrary. */
  const topTen = useMemo(
    () => byScore.filter((r) => r.score.status === "scored").slice(0, TOP_N),
    [byScore],
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
  }, [tab, jobFilter, search, topOnly, flaggedOnly, sort]);

  const openRow = openId ? (rows.find((r) => r.id === openId) ?? null) : null;

  /**
   * Where the open applicant sits in the sequence prev/next walks.
   *
   * `visible` rather than `rows`: stepping follows the order and the filters
   * the list is actually showing, so "next" means the next person on screen
   * rather than the next one in the unfiltered fetch.
   *
   * -1 when the panel was opened from a deep link to someone the current
   * filters exclude — `rows` holds everyone, `visible` does not. The control
   * hides itself in that case rather than stepping somewhere arbitrary.
   */
  const openIndex = openId ? visible.findIndex((r) => r.id === openId) : -1;

  const stepApplicant = useCallback(
    (delta: number) => {
      const target = openIndex + delta;
      const next = visible[target];
      if (!next) return;
      openApplicant(next.id);
      // The dimmed list follows, so closing the panel doesn't leave the reader
      // on a page that no longer holds the person they were just reading.
      setPage(Math.floor(target / PAGE_SIZE) + 1);
    },
    [visible, openIndex, openApplicant],
  );

  /**
   * A deep link whose candidate isn't here.
   *
   * `openRow` is looked up in `rows`, so a missing id already fails safely —
   * the drawer simply doesn't render. That silence is the problem: the click
   * appears to do nothing, which reads as a broken bell rather than as a
   * candidate who has since been deleted. Say which.
   *
   * Deletion is the likely cause and the one applicant_deleted anticipates, but
   * it is not the only one: a scoped member who opens someone else's link is
   * also looking at an id that is not in their `rows`. The wording covers both
   * rather than asserting a deletion that may not have happened.
   *
   * Reported once per id. `rows` changes on every optimistic stage or score
   * edit, and a toast that reappears on each of those would be worse than the
   * silence it replaces.
   */
  const deadLinkReportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkId || deadLinkReportedFor.current === deepLinkId) return;
    if (rows.some((r) => r.id === deepLinkId)) return;
    deadLinkReportedFor.current = deepLinkId;
    setOpenId((current) => (current === deepLinkId ? null : current));
    setToast("That applicant isn't in your list — they may have been deleted.");
  }, [deepLinkId, rows]);

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
    // Not setOpenId(null): the id has to leave the URL too, or the dead-link
    // guard below reports the applicant we just deleted as a broken link.
    closePanel();
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
      setComments([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryFailed(false);
    setHistory([]);
    setComments([]);
    fetchCompanyApplicant(openId)
      .then((read) => {
        if (cancelled) return;
        // A failed read must not blank the trail. An applicant with a week of
        // activity would render as one who has done nothing, and the drawer
        // gives no hint that anything went wrong.
        if (!read.ok) {
          setHistoryFailed(true);
          return;
        }
        setHistory(read.value?.history ?? []);
        setScoreDetail(read.value?.scoreDetail ?? null);
        setComments(read.value?.comments ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setHistory([]);
        setScoreDetail(null);
        setComments([]);
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
    // On a failed re-read the trail is left exactly as it was: stale beats
    // blank, and the move itself already succeeded.
    const read = await fetchCompanyApplicant(id);
    if (read.ok && openIdRef.current === id) setHistory(read.value?.history ?? []);
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
    const read = await fetchCompanyApplicant(id);
    const detail = read.ok ? read.value : null;
    if (read.ok && openIdRef.current === id) setScoreDetail(detail?.scoreDetail ?? null);
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
    const read = await fetchCompanyApplicant(id);
    const detail = read.ok ? read.value : null;
    if (read.ok && openIdRef.current === id) setScoreDetail(detail?.scoreDetail ?? null);
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
          r.score.status === "scored" && r.score.overall != null ? String(r.score.overall) : "",
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
    /*
     * Ahead of the search state, and deliberately NOT echoing the query.
     *
     * `No applicants match "sarah"` is a claim about sarah, and its body tells
     * the reader to try a different spelling — so the copy itself directs a
     * retype that fails identically every time, until the recruiter concludes
     * the candidate is not in the system. Naming the query at all invites
     * re-examining it, so this says the search never ran.
     */
    if (loadFailed) {
      return {
        title: "We couldn't run that search",
        text: "A different spelling won't help — this is on our side, not your query. Reload the page to try again.",
      };
    }
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
      {/* The list dims and goes inert behind the panel rather than sitting
          under a scrim. At 1100px the panel still leaves a strip of list
          visible, and being able to see where you are in the queue is most of
          why a wide panel beats a modal. `inert` and not just
          pointer-events-none: without it Tab walks focus into a list nobody
          can see. */}
      <div
        inert={openRow ? true : undefined}
        className={`transition-opacity duration-200 ${openRow ? "pointer-events-none opacity-30" : ""}`}
      >
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
              Your AI recruiter will <LimeHighlight>read every CV</LimeHighlight> and put the best
              ones first.
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
          delta={newThisWeek > 0 ? <HeroDelta>+{newThisWeek} this week</HeroDelta> : null}
          subline={`Across ${openRoles} open ${openRoles === 1 ? "role" : "roles"}`}
        >
          <div className="flex flex-wrap items-stretch min-[840px]:flex-nowrap">
            {FUNNEL_STEPS.map((step, i) => {
              const value = stageCounts[step.stage] ?? 0;
              const pct = applicants.length > 0 ? Math.round((value / applicants.length) * 100) : 0;
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
                  <p className="m-0 mt-2 text-[11px] text-white/[0.38]">{pct}% of total</p>
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
              <TabButton on={tab === "all"} count={applicants.length} onClick={() => setTab("all")}>
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

              {/* A FILTER, not a stage — it composes with whichever tab is on,
                  because "flagged, in Screening" is a question worth asking. Its
                  badge is the server aggregate, not filtered.length. */}
              <button
                type="button"
                aria-pressed={flaggedOnly}
                onClick={() => setFlaggedOnly((v) => !v)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-[6px] text-[12.5px] font-semibold transition-colors ${
                  flaggedOnly
                    ? "border-[var(--ai-sidebar)] bg-[var(--ai-sidebar)] text-white"
                    : "border-[var(--ai-line-strong)] bg-[var(--ai-surface)] text-[var(--ai-t2)] hover:text-[var(--ai-t1)]"
                }`}
              >
                Flagged
                {typeof flaggedCount === "number" && flaggedCount > 0 && (
                  <span
                    className={`rounded-full px-[6px] py-px text-[10.5px] font-bold tabular-nums ${
                      flaggedOnly
                        ? "bg-white/20 text-white"
                        : "bg-remotiv-purple/10 text-remotiv-purple"
                    }`}
                  >
                    {flaggedCount}
                  </span>
                )}
              </button>
            </div>

            {/* Full-width on phones so the selects + search stack under the tabs
                instead of forcing the toolbar wider than the viewport.
                `flex-wrap` because this cluster holds three controls now: on a
                narrow screen search drops to its own line rather than being
                squeezed to nothing between the two selects. */}
            <div className="flex w-full flex-wrap items-center gap-[9px] min-[630px]:ml-auto min-[630px]:w-auto min-[630px]:flex-nowrap">
              {/*
                A SELECT, not a segmented toggle, and that is the whole reason it
                reads correctly here. A two-button Best/Newest control is the same
                shape as the tab strip's buttons a few pixels to the left, so at a
                glance it would read as two more tabs. A select is a shape this
                toolbar has already taught — sitting beside the job filter, in the
                cluster that answers "how is this list shaped" rather than the
                strip that answers "which stage".
              */}
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                aria-label="Sort applicants"
                className={`${TOOLBAR_SELECT} shrink-0`}
              >
                <option value="best">Best match</option>
                <option value="newest">Newest first</option>
              </select>

              <select
                value={jobFilter}
                onChange={(e) => setJobFilter(e.target.value)}
                aria-label="Filter by job"
                className={`${TOOLBAR_SELECT} max-w-[45%] shrink min-[630px]:max-w-none`}
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
            <div data-twin-narrow className="min-[1049px]:hidden">
              {paged.map((r, i) => (
                <ApplicantCard
                  key={r.id}
                  row={r}
                  index={pageStart + i}
                  isTop={topMatchIds.has(r.id)}
                  selected={openId === r.id}
                  onOpen={() => openApplicant(r.id)}
                  clock={clock}
                />
              ))}
            </div>
          )}

          {/* Desktop table — unchanged above the breakpoint. overflow-x-auto is
              kept as a belt-and-braces guard; at >=1049px the grid fits. */}
          <div data-twin-wide className="hidden overflow-x-auto min-[1049px]:block">
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
                const applied = fmtApplied(r.created_at, clock);
                const stage = stageOf(r);
                const pill = STAGE_PILL[stage];
                const isTop = topMatchIds.has(r.id);
                const rank = pageStart + i;

                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openApplicant(r.id)}
                    className={`${GRID} group/row group relative w-full cursor-pointer border-b border-[var(--ai-line-soft)] py-[13px] text-left transition-all last:border-b-0 hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)] ${
                      openId === r.id
                        ? "bg-[var(--ai-purple-tint)]"
                        : showsWorthALook(r)
                          ? "bg-remotiv-purple/[0.035]"
                          : "bg-[var(--ai-surface)]"
                    }`}
                  >
                    {/* Always on for a flagged row — the accent is what makes a
                          flag findable while scrolling, so it does not wait for a
                          hover the way the default row's does. */}
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 w-[3px] bg-remotiv-purple transition-opacity ${
                        openId === r.id || showsWorthALook(r)
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100"
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
                          {/* Display-only, exactly as ApplicantCard renders it.
                              Passing onDismiss puts a <button> inside this row's
                              <button>, which is invalid HTML: the parser closes
                              the row early and reparents everything after the
                              chip — reason, job, score, stage, date — as
                              siblings. The server tree and the client tree then
                              disagree, hydration fails, and React leaves the
                              mangled server DOM orphaned below the page. Only
                              FLAGGED rows carried the chip, which is why only
                              they broke. Dismissal lives in the drawer's
                              Worth-a-look banner, one click away on the row the
                              reader is already pointing at. */}
                          {showsWorthALook(r) && <WorthALookChip />}
                        </p>
                        {showsWorthALook(r) ? (
                          <FlagReasonLine reason={r.shortlist.reason} />
                        ) : (
                          <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
                            {r.email}
                          </p>
                        )}
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
          clock={clock}
          history={history}
          scoreDetail={scoreDetail}
          historyLoading={historyLoading}
          historyFailed={historyFailed}
          messages={messages}
          messagesLoading={messagesLoading}
          comments={comments}
          commentsLoading={historyLoading}
          viewerMemberId={viewerMemberId}
          viewerRole={viewerRole}
          saving={savingId === openRow.id}
          scoreSaving={scoreSaving}
          canRescore={canRescore}
          rescoring={rescoringId === openRow.id}
          onRescore={() => {
            void handleRescore(openRow.id);
          }}
          tab={panelTab}
          onTabChange={selectPanelTab}
          position={openIndex >= 0 ? { index: openIndex, total: visible.length } : null}
          onStep={stepApplicant}
          onEmail={() => setComposerOpen(true)}
          onToast={setToast}
          onClose={closePanel}
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
          onDismissFlag={(id) => {
            void dismissFlag(id);
          }}
          dismissing={dismissing}
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
                <Trash className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
              </div>
              <h3
                id="confirm-delete-applicant"
                className="font-heading text-lg font-bold text-[var(--ai-t1)]"
              >
                Delete this applicant?
              </h3>
              <p className="m-0 mt-2 text-sm text-[var(--ai-t2)]">
                <span className="font-semibold">{fullName(deleteTarget)}</span> will be permanently
                removed, along with their CV file, AI scorecard and pipeline history. This cannot be
                undone.
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
