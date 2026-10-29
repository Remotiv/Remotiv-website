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
  Plus,
  RotateCcw,
  Search as SearchIcon,
  Trash,
  Upload,
  Users,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DashboardHero, HeroDelta } from "@/app/ai-dashboard/_components/dashboard-hero";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { TipCard } from "@/app/ai-dashboard/_components/tip-card";
import { Toast, useToast } from "@/app/ai-dashboard/_components/toast";
import { Composer, initialsOf as msgInitials } from "@/app/ai-dashboard/(gated)/messages/_composer";
import {
  fetchApplicationInbound,
  fetchApplicationMessages,
} from "@/app/ai-dashboard/(gated)/messages/actions";
import {
  APPLICATION_INBOUND_CAP,
  APPLICATION_MESSAGE_CAP,
  type MessageRow as CandidateMessage,
  type InboundMatchBasis,
  type InboundMessageRow,
  type ManualTemplate,
} from "@/app/ai-dashboard/(gated)/messages/types";
import {
  type AddApplicantDuplicate,
  type ApplicantComment,
  type ApplicantCounts,
  type ApplicantScore,
  type ApplicantScoreDetail,
  type ApplicantScoringFacts,
  type ApplicantSort,
  type AssignableJob,
  COMMENT_MAX,
  type CompanyApplicantPage,
  type CompanyApplicantRow,
  CV_LIMIT_REACHED_REASON,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
  pipelineStageLabel,
  SCORE_FEEDBACK_MAX,
  SCORING_OFF_REASON,
  type ScoreDimensionRow,
  type StageHistoryRow,
  showsWorthALook,
  TOP_MATCH_MIN_SCORE,
  TOP_SCORED_LIMIT,
} from "@/app/ai-dashboard/lib/applicant-types";
import {
  type CompanyRole,
  canCreateJobs,
  canMakeHiringDecision,
  isDecisionStage,
} from "@/app/ai-dashboard/lib/company-roles";
import {
  BAND_LABEL,
  BAND_MATCH_LABEL,
  BAND_PILL,
  scoreBand as bandKey,
} from "@/app/ai-dashboard/lib/score-bands";
import { stagePill } from "@/app/ai-dashboard/lib/stage-pill";
import { unscoredCardState } from "@/app/ai-dashboard/lib/unscored-card";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { placeholderFor } from "@/lib/whatsapp/inbound-display";
import { InterviewPanel } from "./_interview-panel";
import { StageTabs } from "./_stage-tabs";
import {
  addApplicationComment,
  addCompanyApplicant,
  adjustScore,
  attachApplicationCv,
  clearScoreAdjustment,
  countFlaggedApplicants,
  deleteApplication,
  deleteApplicationComment,
  dismissShortlistFlagAction,
  fetchApplicantCounts,
  fetchCompanyApplicant,
  fetchCompanyApplicants,
  fetchScreeningAnswers,
  fetchTopScoredApplicants,
  rescoreApplication,
  updateApplicationComment,
  updateApplicationStage,
} from "./actions";
import {
  type CountsState,
  countLabel,
  countsKey,
  countsView,
  ledeCount,
  requestCounts,
  seedCounts,
  settleCounts,
  stagePercent,
} from "./counts-state";
import { buildApplicantsCsv, type CsvApplicant } from "./csv-export";
import {
  clampPage,
  decodeListUrl,
  dropRow,
  encodeListUrl,
  encodePanelUrl,
  filterKey,
  type ListRequest,
  type ListState,
  type ListUrlState,
  listKey,
  listQueryFor,
  listView,
  populationIndex,
  rangeStart,
  requestList,
  SEARCH_DEBOUNCE_MS,
  type StepTarget,
  seedList,
  settleList,
  stepRow,
  stepTarget,
} from "./list-state";
import {
  type ScreeningState,
  screeningCard,
  screeningCount,
  selectScreening,
} from "./screening-state";
import { TAB_FADE_PX, tabScrollLeft } from "./tab-scroll";

// ── Constants ────────────────────────────────────────────────

/** Mock's `.gridrow`: # / Candidate / Job / CV Score / Stage / Applied / ⋯ */
const GRID =
  "grid grid-cols-[46px_minmax(0,2.1fr)_1.35fr_104px_1fr_0.8fr_40px] items-center gap-[14px] px-5";

/**
 * The funnel and the stage tabs both key off pipeline stage, counted in the
 * database over the whole population rather than over the rendered rows.
 *
 * Five of the seven stages. Offer and Rejected are deliberately absent from
 * the funnel, so these percentages do not sum to 100 and are not meant to —
 * each is that stage's share of the total, not of the ones shown.
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

/*
 * The chip threshold, the page size, the "top N" and the sort union all moved
 * to applicant-types.ts in this pass.
 *
 * Not tidying: every one of them is now enforced by a query. The page size is
 * the `.range()` width, "top N" is the top-scored read's `.limit()`, and the
 * sort union is what the action switches its ORDER BY on. A second copy here
 * would be a number the browser believes and the database does not — and the
 * disagreement would show up as rows silently missing from a page boundary,
 * which is the exact defect this pass exists to fix.
 */

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
  /* `short` is the label below the strip's breakpoint, not a rename: "comm"
     is in the URL and every link anyone has sent resolves through it.
     "Communication" alone is 102px of a 377px strip, more than a quarter of
     it for one of six tabs. Comments keeps its full label at every width —
     those are the team's comments on a candidate, and "Notes" is a different
     thing elsewhere in the product. */
  { key: "comm", label: "Communication", short: "Comms" },
  { key: "interviews", label: "Interviews" },
  /* Fifth, where the design puts it — after the panes that answer "who is this
     and how good are they" and before the team's own discussion.

     It still REPLACES the stage-history card that used to sit at the foot of
     Profile, which the design confirms: its Profile pane has no such card
     either. Keeping both would have meant two renderings of one history, and
     the one on Profile had a bug (see appliedEvent). */
  { key: "timeline", label: "Timeline" },
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
 * Toolbar select. Shared by the job filter and the sort control so the two
 * cannot drift — they sit side by side, where a 1px difference would show.
 */
const TOOLBAR_SELECT =
  "min-w-0 cursor-pointer appearance-none truncate rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.14]";

/** Every field in the Add candidate form, so the five cannot drift apart. */
const ADD_FIELD =
  "w-full rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[9px] text-[13px] text-[var(--ai-t1)] placeholder:text-[var(--ai-t4)] focus:border-remotiv-purple focus:outline-none focus:ring-[3px] focus:ring-remotiv-purple/[0.14]";

const ADD_LABEL = "mb-[5px] block text-[11.5px] font-bold text-[var(--ai-t2)]";

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
  if (Number.isNaN(d.getTime())) return { main: "-", sub: "" };
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
 *
 * Silent unless the MODEL's own attempt succeeded. `ai_model` is NOT NULL, so a
 * skipped CV still carries a model name, and a row the AI never read would
 * otherwise credit its number to "Model v10" — under (B) that number can be a
 * reviewer's, and attributing it to the model is the one claim this line must
 * never make.
 */
function scoreProvenance(detail: ApplicantScoreDetail | null, local: boolean): string {
  if (detail?.ai_status !== "scored") return "";
  const parts: string[] = [];
  if (detail.ai_model) parts.push(`Model ${detail.ai_model}`);
  const when = fmtDay(detail.scored_at, local);
  if (when) parts.push(`scored ${when}`);
  return parts.length > 0 ? ` ${parts.join(" · ")}.` : "";
}

/**
 * What the number beside the ring actually is.
 *
 * Both of the old branches describe an AI score, and under (B) the ring can be
 * showing a reviewer's own number on a CV the model never read — where
 * "scored against this job's stated requirements" is simply false, and the
 * confidence line can't fire because there is no model confidence to report.
 * So the AI's own status is asked first; the two original branches are
 * unchanged beneath it.
 */
function scoreLede(score: ApplicantScore): string {
  if (score.adjusted && score.ai_status !== "scored") {
    return "Scored by a reviewer. The AI did not produce a score for this CV.";
  }
  return score.confidence
    ? "Based on how much the CV actually showed."
    : "Scored against this job's stated requirements.";
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

/** Held by the company's monthly AI scoring limit. Matched on the fixed reason, as above. */
function isLimitReached(score?: ApplicantScore): boolean {
  return score?.status === "skipped" && score.error === CV_LIMIT_REACHED_REASON;
}

/** Extracted rather than nested-ternaried inline — four cases, one order. */
function pendingLabel(score?: ApplicantScore): string {
  if (isScoringOff(score)) return "Scoring off";
  if (isLimitReached(score)) return "Limit reached";
  if (score?.status === "failed") return "Failed";
  if (score?.status === "skipped") return "No CV text";
  return "Pending";
}

/** The drawer's version of pendingLabel — longer, since it has the room. */
function drawerScoreHeading(score: ApplicantScore): string {
  if (isScoringOff(score)) return "Scoring off for this job";
  if (isLimitReached(score)) return "Not scored - monthly AI scoring limit reached";
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
  // Nothing is coming for either: a setting, or a limit only a re-score lifts.
  const off = isScoringOff(score) || isLimitReached(score);
  return (
    <div
      className="flex items-center gap-[9px]"
      // A failed row's error may be provider text on rows written before
      // Phase 6; the Review card carries the safe sentence, so no tooltip.
      title={score?.status === "failed" ? undefined : (score?.error ?? undefined)}
    >
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
  /** The filtered population. Null is unreadable — an em dash, never a 0. */
  total: number | null;
  /** The workspace population, for the "(filtered from N)" aside. */
  grandTotal: number | null;
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
        of {countLabel(total)}
        {/* Both numbers have to be KNOWN before this can claim they differ.
            Either one unreadable makes "filtered from" unprovable, so the
            aside is omitted rather than shown against an em dash — and a null
            total would otherwise never equal grandTotal and the aside would
            appear on every failed count. */}
        {total !== null && grandTotal !== null && total !== grandTotal && (
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
 * "Added by team" — this person was filed by hand and did not apply.
 *
 * SLATE, deliberately, and not purple. Purple is this dashboard's primary
 * action colour: it marks the things worth clicking — Open CV, Add candidate,
 * Worth a look. This is a fact about where the row came from, with nothing
 * behind it to click, so borrowing that colour would promise an action it does
 * not have. Slate is the same neutral the Applied stage pill already uses.
 *
 * Says "team", not "manual" or "you": the row records no author, so naming one
 * would be an invention. And "manual", sitting a column from CV score, reads
 * as manually scored.
 *
 * Beside the job title rather than on the name line, which already carries Top
 * match and Worth a look and truncates the name behind them.
 */
function AddedByTeamChip() {
  return (
    <span
      title="Added by someone on your team. They didn't apply through the job board, and weren't emailed."
      className="inline-flex shrink-0 items-center rounded-lg bg-[var(--ai-slate-tint)] px-2 py-[5px] text-[10.5px] font-bold uppercase tracking-[0.05em] text-[var(--ai-slate-ink)]"
    >
      Added by team
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
  rank,
  isTop,
  selected,
  onOpen,
  clock,
}: {
  row: CompanyApplicantRow;
  /**
   * The row's 1-based position in the filtered population — "21" on page 2.
   *
   * Was a 0-based `index` the caller built from a 0-based page offset and this
   * component incremented. The offset is now `rangeStart`, which is 1-based by
   * contract because the pager's "21–40" needs the same number, so the +1
   * moved out of here rather than being applied twice.
   */
  rank: number;
  /** Genuine top match — see TOP_MATCH_MIN_SCORE, not "first in the list". */
  isTop: boolean;
  selected: boolean;
  onOpen: () => void;
  clock: PageClock;
}) {
  const tint = getTint(row.id);
  const applied = fmtApplied(row.created_at, clock);
  const stage = stageOf(row);
  const pill = stagePill(stage);
  const worthALook = showsWorthALook(row);

  return (
    <button
      type="button"
      data-applicant-id={row.id}
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
          {String(rank).padStart(2, "0")}
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

      <div className="mt-3 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate rounded-lg border border-[var(--ai-line-soft)] bg-[var(--ai-inset)] px-2.5 py-[5px] text-[12.5px] font-semibold text-[var(--ai-t2)]">
          {row.job_title}
        </span>
        {row.added_manually && <AddedByTeamChip />}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <ScoreRing score={row.score} />
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${pill.cls}`}
        >
          <span className={`size-[5px] shrink-0 rounded-full ${pill.dot}`} />
          {pipelineStageLabel(stage)}
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

/**
 * The tab strip's right-edge fade: the affordance that says there is more tab
 * off the edge. It carries that on its own because the scrollbar cannot — an
 * overlay scrollbar draws nothing until a scroll is already under way, which
 * is the wrong order for a hint.
 *
 * A mask rather than a gradient element so nothing has to be positioned over a
 * scroll container, and applied only while something is genuinely hidden: a
 * permanent fade would dim the last tab of a desktop strip that fits.
 */
const TAB_FADE_MASK = `linear-gradient(to right, #000 calc(100% - ${TAB_FADE_PX}px), transparent)`;

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
          placeholder="Optional, but this is the part that teaches us something - e.g. “Undervalued 6 years of agency work because the CV lists clients, not employers.”"
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
        Adjusted to {detail.overall} from the AI&apos;s {detail.ai_overall ?? "-"}
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
  return detail.job_must_have_count === 0 ? "None" : "-";
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
  screeningState,
  showScoringTip,
  history,
  scoreDetail,
  historyLoading,
  historyFailed,
  messages,
  messagesLoading,
  messagesFailed,
  messagesTruncated,
  inbound,
  inboundLoading,
  inboundFailed,
  inboundTruncated,
  inboundBasis,
  comments,
  commentsLoading,
  viewerMemberId,
  viewerRole,
  saving,
  scoreSaving,
  canRescore,
  rescoring,
  onRescore,
  scoring,
  attaching,
  onAttachCv,
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
  stepBusy,
}: {
  row: CompanyApplicantRow;
  /**
   * The screening read, still keyed by the applicant it was started for.
   *
   * Passed raw rather than pre-resolved so the id comparison happens against
   * the row being RENDERED here — the drawer steps between applicants while a
   * read is in flight, and matching at the point of use is what makes one
   * candidate's answers under another's name unrepresentable.
   */
  screeningState: ScreeningState;
  /** Undismissed per member. The render condition below narrows it further. */
  showScoringTip: boolean;
  history: StageHistoryRow[];
  scoreDetail: ApplicantScoreDetail | null;
  historyLoading: boolean;
  /** The trail could not be READ. Distinct from "there is no trail". */
  historyFailed: boolean;
  messages: CandidateMessage[];
  messagesLoading: boolean;
  /** The trail could not be READ. Distinct from "no messages were sent". */
  messagesFailed: boolean;
  /** More messages exist than were fetched — the feed says so rather than ending. */
  messagesTruncated: boolean;
  /** Replies the candidate sent us on WhatsApp, matched on their phone. */
  inbound: InboundMessageRow[];
  inboundLoading: boolean;
  /** The replies could not be READ. Distinct from "they have not replied". */
  inboundFailed: boolean;
  inboundTruncated: boolean;
  /** Whether replies could be looked for at all — see InboundMatchBasis. */
  inboundBasis: InboundMatchBasis;
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
  /** The unscored card's facts. Null while the detail read is in flight. */
  scoring: ApplicantScoringFacts | null;
  attaching: boolean;
  /** F4: replace an unreadable (or missing) CV with a readable one. */
  onAttachCv: (file: File) => void;
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
   * Where this applicant sits in the FILTERED POPULATION — "21 of 128", not a
   * position on the page. Null when the panel was deep-linked to someone the
   * current filters exclude, or when the population is unreadable: prev/next
   * then has no sequence to walk and hides itself rather than offering a dead
   * arrow.
   */
  position: { index: number; total: number } | null;
  onStep: (delta: number) => void;
  /**
   * A step that crosses a page boundary is a server read, and until it lands
   * the row under `position.index` is not on screen. Both arrows go disabled
   * for the duration, so a second click cannot be resolved against the page
   * being left.
   */
  stepBusy: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tint = getTint(row.id);
  const name = fullName(row);
  const applied = fmtApplied(row.created_at, clock);
  const stage = stageOf(row);

  // Escape, scroll lock, focus in, Tab containment, inert page behind, and
  // focus back to the row that opened it - all from the one modal primitive.
  // A confirm dialog opened from inside this drawer stacks on top of it.
  useModalFocus(panelRef, true, { onClose });

  /*
   * Revealing the current tab in the strip that now scrolls.
   *
   * Two entry points, one effect: a deep link can open this drawer straight
   * onto Comments, which is the tab furthest off the right edge, and prev/next
   * remounts the drawer on the same tab for the next candidate. Both are just
   * "whichever tab is current, show it", so neither gets its own handler.
   */
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [tabFade, setTabFade] = useState(false);

  const syncTabFade = useCallback(() => {
    const el = tabStripRef.current;
    if (!el) return;
    // The 1px of slack is for a fractional scrollLeft at the end of the range,
    // which would otherwise leave the fade painted over the last tab with
    // nothing behind it to promise.
    setTabFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    // Found by `data-tab` rather than by `aria-current="page"`, so the tab
    // this effect reveals is the one its dependency array names. Reading the
    // ARIA attribute instead made `tab` an unused dependency that was doing
    // all the work, which is a trap for whoever next prunes the array.
    const active = el.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (active) {
      const target = tabScrollLeft({
        scrollLeft: el.scrollLeft,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        itemLeft: active.offsetLeft,
        itemWidth: active.offsetWidth,
      });
      if (target !== el.scrollLeft) el.scrollTo({ left: target });
    }
    syncTabFade();
  }, [tab, syncTabFade]);

  // A rotation changes what fits without firing a scroll event, so without
  // this the fade would go on claiming hidden tabs on a strip that now fits.
  useEffect(() => {
    window.addEventListener("resize", syncTabFade);
    return () => window.removeEventListener("resize", syncTabFade);
  }, [syncTabFade]);

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

  // Resolved against row.id, so a response that arrived for the previously
  // open applicant reads as "loading" rather than as this one's answers.
  const screening = selectScreening(screeningState, row.id);
  const screeningView = screeningCard(screening);
  // Null until the answers are known. The Review summary's source line is
  // omitted on null rather than quoting a count of 0, which reads as "the job
  // asked nothing" — a different claim from "we have not loaded it yet".
  const screeningAnswerCount = screeningCount(screening);

  // The Communication tab's single list. Both directions are in flight
  // separately, so the skeleton stands until neither is still arriving —
  // showing half the conversation and calling it loaded would be worse.
  const commEntries = mergeComm(messages, inbound);
  const commLoading = messagesLoading || inboundLoading;

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

  /*
   * The unscored card's whole state, or null until the detail read lands (the
   * card then falls back to the old heading/reason for that moment). canEdit
   * is the re-score permission: the same three roles may upload a CV, open the
   * job's settings and re-score, and a viewer outside them gets copy only.
   */
  const unscored = scoring
    ? unscoredCardState({
        scoreStatus: scoreDetail?.status ?? null,
        scoreError: scoreDetail?.error ?? null,
        hasCv: row.has_cv,
        cvExpired: row.cv_expired,
        facts: scoring,
        canEdit: canRescore,
        jobId: row.job_id,
      })
    : null;

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
      aria-label={`${name} - applicant detail`}
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
                  disabled={stepBusy || position.index === 0}
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
                  disabled={stepBusy || position.index >= position.total - 1}
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
              placeholder when unscored — Review carries that explanation.

              Hidden below 525px (the segment's `sm`, scaled by the shell's
              0.82 zoom), because at a 360px viewport this row has 377px to
              place 446px of content and the ring block plus its divider are
              the first 136px of the excess. What was being lost instead was
              the NAME: the h2 and the email both carry `truncate`, so they
              clipped to zero width and vanished while the ring stayed, and
              the only survivor was the whitespace-nowrap applied date
              painting across the ring. Hiding the ring brings the identity
              row's overflow to 0 and the name back to 99px at 360 / 117px at
              375, at no vertical cost — the header stays 163px tall. The
              argument for which one goes is the comment above: the score has
              a full card one tab away and the name has nowhere else to be.

              This also fixes the Stage select, which was sitting 46px past
              the drawer edge for the same reason and needs no edit of its
              own. */}
          {band && headerScore.overall != null && (
            <>
              <div className="hidden shrink-0 items-center gap-[11px] min-[525px]:flex">
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
              {/* Same breakpoint as the ring it separates: a divider with
                  nothing on one side of it is just a stray line. */}
              <span
                aria-hidden
                className="hidden h-9 w-px shrink-0 bg-[var(--ai-line)] min-[525px]:block"
              />
            </>
          )}

          {/* The stage select used to sit mid-scroll, where the one edit a
              recruiter makes most often scrolled away from them.

              Neutral, where the design tints it blue. That blue is the mock's
              one stage showing through — there is no stage colour system to
              read it from, and painting all six blue would make the dot mean
              nothing. Shape, size and the leading dot match the design. */}
          {/* The decision stages (Hired, Rejected) are reserved to owner, admin
              and recruiter. A hiring manager is not offered them, and once a
              candidate is in one, sees the stage as text rather than a menu
              that would refuse. Same rule as the server (canChangeStage). */}
          {!canMakeHiringDecision(viewerRole) && isDecisionStage(stage) ? (
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="text-[11.5px] font-bold tracking-[0.02em] text-[var(--ai-t3)]">
                Stage
              </span>
              <div className="min-w-0">
                <span className="block rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-[13px] py-[9px] text-[13px] font-bold text-[var(--ai-t1)]">
                  {PIPELINE_STAGE_LABELS[stage]}
                </span>
                <span className="mt-1 block text-[11px] leading-[1.4] text-[var(--ai-t3)]">
                  Only an owner, admin or recruiter can change this.
                </span>
              </div>
            </div>
          ) : (
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
                  {PIPELINE_STAGES.filter(
                    (s) => canMakeHiringDecision(viewerRole) || !isDecisionStage(s),
                  ).map((s) => (
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
          )}
        </div>

        {/* Scrolls sideways rather than wrapping, which is the opposite of the
            call made for the dashboard's filter-chip strips, and for a reason
            that does not transfer: those scrollers sat inside an
            overflow-hidden card with the body's overflow-x hidden too, so
            nothing was draggable and a hidden chip was unreachable. This row
            IS the scroll container and is directly touch-draggable. Wrapping
            was measured and rejected separately: it costs 57px of header
            height and splits the 2px underline across two baselines.

            `pb-px -mb-px` is load-bearing, not tidying. PANEL_TAB_BASE puts
            the underline at `after:-bottom-px`, 1px OUTSIDE each button's box
            so the rule lands on the header's own border. `overflow-x: auto`
            forces computed `overflow-y` from visible to auto — CSS does not
            allow one axis to clip while the other does not — so that 1px
            became scrollable overflow and half the active tab's underline was
            clipped. 1px of padding brings it inside the padding box and the
            1px negative margin gives the height back, leaving every button's
            bottom edge at the pixel it was at before. Remove either class and
            the underline goes back to half thickness.

            `relative` makes this box the tabs' offsetParent, so their
            offsetLeft is already in the strip's content coordinates. Rects
            are not an option here: the shell's unconditional `zoom: 0.82`
            returns them in visual px while scrollLeft is layout px. */}
        <div
          ref={tabStripRef}
          onScroll={syncTabFade}
          className="relative -mb-px flex gap-[26px] overflow-x-auto pb-px"
          style={tabFade ? { maskImage: TAB_FADE_MASK, WebkitMaskImage: TAB_FADE_MASK } : undefined}
        >
          {PANEL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-tab={t.key}
              onClick={() => onTabChange(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`${PANEL_TAB_BASE} ${
                tab === t.key
                  ? "text-[var(--ai-t1)] after:bg-[var(--ai-sidebar)]"
                  : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
              }`}
            >
              {"short" in t ? (
                <>
                  <span className="min-[525px]:hidden">{t.short}</span>
                  <span className="hidden min-[525px]:inline">{t.label}</span>
                </>
              ) : (
                t.label
              )}
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
                  {/* "Added to", not "Applied to", on a manual row — the verb
                      is the claim, and they did not apply. */}
                  {row.added_manually ? "Added to" : "Applied to"}{" "}
                  <b className="font-bold text-[var(--ai-t1)]">{row.job_title}</b> · {applied.main}
                </p>

                {/* The chip alone says how they arrived; this says what follows
                    from it. The no-email decision is otherwise invisible, and
                    this card is where someone lands before wondering why the
                    candidate never replied. */}
                {row.added_manually && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <AddedByTeamChip />
                    <span className="min-w-0 text-[12px] leading-relaxed text-[var(--ai-t4)]">
                      Not emailed - they didn't apply through the job board.
                    </span>
                  </div>
                )}

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
                  {/*
                    A general Replace / Add CV button stood here and was REMOVED
                    on purpose. Do not read its absence as an oversight, and do
                    not put it back here.

                    The gap it left did bite, in one specific shape: an applicant
                    whose CV extracted to nothing — a scan, a photo, a PDF of
                    images — had no way back to a scored state, because Re-score
                    re-reads the stored text and the text is what is missing.
                    That one state now has its own control: "Upload a readable
                    CV" on the Review tab's score card, shown only when the
                    stored text is under the scorer's floor (or there is no CV
                    at all), driven by unscoredCardState. It calls the same
                    attachApplicationCv this note always pointed at. A better CV
                    arriving for an applicant who already scored still has no
                    button — that remains the accepted trade.
                  */}
                </div>

                {/* Says WHY the CV button is dead, rather than leaving a greyed
                    control to be read as a bug. Only on expiry — "no CV" needs
                    no excuse. */}
                {row.cv_expired && (
                  <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-[var(--ai-t4)]">
                    CVs are deleted 24 months after the application. Everything else on this
                    applicant is unaffected.
                  </p>
                )}
              </PaneCard>

              {/* Absent entirely when the job asked nothing — same as before.
                  But an unreadable answer set is NOT that: "empty" is a claim
                  about the job, and making it on the strength of a failed read
                  leaves the reader no way to tell the difference. */}
              {screeningView !== "empty" && (
                <PaneCard title="Screening questions">
                  {screeningView === "failed" && (
                    <p
                      className={`${TIMELINE_NOTICE} border-[var(--ai-danger)]/30 bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
                    >
                      The screening answers couldn&apos;t be loaded. That isn&apos;t the same as the
                      candidate answering nothing - close and reopen to try again.
                    </p>
                  )}
                  {screeningView === "loading" && (
                    <div className="flex flex-col gap-3">
                      <div className="h-[11px] w-2/3 animate-pulse rounded-full bg-[var(--ai-inset)]" />
                      <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
                    </div>
                  )}
                  {screening.status === "ready" && screening.answers.length > 0 && (
                    <>
                      {/* Provenance stated ONCE here rather than repeated on every
                    pill. The pills then stay short enough to sit inline beside
                    the answer, and this line can say the thing a pill never
                    could — that nobody verified any of it. */}
                      <p className="m-0 mb-2.5 text-[11.5px] leading-snug text-[var(--ai-t3)]">
                        Answered by the candidate at apply time and checked against the thresholds
                        you set. Self-reported - not verified by Remotiv.
                      </p>
                      <div className="flex flex-col gap-[9px]">
                        {screening.answers.map((a) => (
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
                              {a.answer_label || a.answer || "-"}
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

              {/* The stage-history card that used to sit here is now the
                  Timeline tab, which shows the same rows merged with comments,
                  messages and scoring. Two renderings of one history meant the
                  synthesised "Applied" had to be right in both places, and here
                  it was not: it appeared only when the history was EMPTY, so
                  anyone moved even once had a card that never said when they
                  applied. */}

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
                        {scoreLede(headerScore)}
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
                        them, is the whole signal this feature collects.

                        Keyed on `adjusted` alone, not on ai_overall: under (B)
                        a reviewer can score a CV the model skipped, and there
                        is then no AI number to show. The byline still has to
                        run — it is the only thing on the card saying whose
                        judgement the ring is, and dropping it would leave the
                        number reading as the AI's. */}
                    {headerScore.adjusted && (
                      <p className="m-0 mt-[9px] text-[12.5px] leading-[1.55] text-[var(--ai-t2)]">
                        <span className="font-semibold text-[var(--ai-t1)]">
                          {headerScore.ai_overall != null
                            ? `AI scored ${headerScore.ai_overall}`
                            : "Scored by hand"}
                        </span>
                        {adjustmentByline(scoreDetail, clock.local)}
                      </p>
                    )}

                    <p className="m-0 mt-[11px] max-w-[520px] border-t border-[var(--ai-line-soft)] pt-[11px] text-[11px] leading-[1.6] text-[var(--ai-t3)]">
                      Scored from written application text only. Remotiv AI does not analyse face,
                      voice or accent, and the score is advisory - a person decides.
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
                        {/* What it spends stays visible rather than becoming
                            a tooltip - it is a credit from the monthly
                            allowance, and a tooltip is invisible on a touch
                            screen. */}
                        <span className="text-center text-[11px] leading-[1.5] text-[var(--ai-t3)]">
                          Uses one AI scoring credit
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
                /* Dashed only while something is genuinely in the queue -
                   dashed reads as "in progress", and until the facts arrive
                   (or when nothing is queued) a solid border says so. The
                   heading, body and control all come from unscoredCardState:
                   F4, F5 and F6 are one decision, made from the row's facts
                   rather than from the wording of the last skip reason. */
                <div
                  className={`m-px rounded-[19px] border px-[26px] py-7 text-center ${
                    unscored?.kind === "in_progress" || unscored?.kind === "retrying"
                      ? "border-dashed border-[var(--ai-line-strong)]"
                      : "border-transparent"
                  }`}
                >
                  <b className="mb-[3px] block text-[13px] text-[var(--ai-t1)]">
                    {unscored?.heading ?? drawerScoreHeading(headerScore)}
                  </b>
                  <span className="text-xs leading-relaxed text-[var(--ai-t3)]">
                    {unscored?.body ??
                      headerScore.error ??
                      "The breakdown appears here once this CV has been scored."}
                  </span>
                  {unscored?.control === "upload" && (
                    <label
                      className={`${ADJ_BTN_QUIET} mt-3.5 inline-flex cursor-pointer items-center gap-1.5 ${
                        attaching ? "pointer-events-none opacity-60" : ""
                      }`}
                    >
                      <Upload className="size-3.5" strokeWidth={2} />
                      {attaching ? "Uploading…" : "Upload a readable CV"}
                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        className="sr-only"
                        disabled={attaching}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          // Reset so choosing the same file again re-fires.
                          e.target.value = "";
                          if (file) onAttachCv(file);
                        }}
                      />
                    </label>
                  )}
                  {unscored?.control === "job_settings" && unscored.href && (
                    <span className="mt-3.5 flex flex-col items-center gap-1">
                      <Link href={unscored.href} className={ADJ_BTN_QUIET}>
                        Open job settings
                      </Link>
                      {unscored.hint && (
                        <span className="text-[11.5px] text-[var(--ai-t4)]">{unscored.hint}</span>
                      )}
                    </span>
                  )}
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

            {/*
              Under the score card, not above it.
              Measured: the card costs 185px including its margin, and the
              Review pane shows 550px of 1920. Above the score card that pushes
              the ring to 200 and the dimensions to 543 — off the bottom of the
              window, so opening Review would show a tip and nothing else.
              Here the ring and verdict do not move at all, the tip sits fully
              in view at 191–356, and it is directly beneath the Adjust score
              button it describes.

              Never beside the Worth-a-look banner: that is not a tip, the gate
              does not know about it, and 16 of 133 applications carry it — the
              high scorers, the ones opened first. The same helper decides both,
              so they are exactly complementary.
            */}
            {showScoringTip && headerScore.status === "scored" && !showsWorthALook(row) && (
              <TipCard tipKey="cv_scoring" />
            )}

            {/* The AI's OWN status, not the synthesized one. Everything below
                is the model's output — its summary, its dimensions, its
                evidence, its reading of the must-haves — so the question is
                whether the model produced a scorecard, not whether the row has
                a number. Under (B) those diverge: a reviewer scoring a CV the
                model skipped makes `status` 'scored' while no scorecard exists,
                and this gate would then render empty dimensions, four empty
                Evidence boxes that are documented to mean "the model found
                none", and a must-haves line asserting "this score was written
                before the job named its N must-haves" about a score the model
                never wrote. */}
            {scoreDetail?.ai_status === "scored" && (
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
                          is the count the model read.

                          The scorecard arrives before the answers do, so this
                          clause waits for them instead of claiming the CV was
                          the only input. */}
                      {screeningAnswerCount !== null && (
                        <span className="text-right text-[11px] font-medium text-[var(--ai-t3)]">
                          {summarySource(screeningAnswerCount)}
                        </span>
                      )}
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
                              {" - "}
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
                action for, and only when a re-score can actually change the
                answer: unscoredCardState says "rescore" for a lost request, a
                dead one, a failed run and a skip whose cause has gone - and
                says something else for scoring-off and unreadable-CV, where
                this button used to reproduce the same result for a credit.
                Scored rows take the button in the card, stale ones take it in
                the banner — the action never appears twice. */}
            {unscored?.control === "rescore" &&
              !scoreDetail?.stale &&
              headerScore.status !== "scored" && (
                <div className="mt-[22px] flex items-center justify-between gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 py-3">
                  <p className="m-0 text-xs leading-relaxed text-[var(--ai-t3)]">
                    Re-run the AI on this CV - uses one AI scoring credit.
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
             title alone rather than a control that does nothing.

             "Messages sent" was accurate while the card was outbound only. It
             now carries the candidate's WhatsApp replies too, so the title can
             no longer claim a direction. */
          <PaneCard title="Messages">
            <div className="flex flex-col gap-2.5">
              {commLoading && commEntries.length === 0 && (
                <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
              )}
              {/* A failed read is not an empty trail. Until the action reported
                  its query error this pane said "No messages sent yet." on a
                  database failure — the reassuring answer, and the wrong one.
                  The two directions are separate reads, so they say which one
                  failed rather than blaming the whole card. */}
              {messagesFailed && (
                <p className="m-0 text-[13px] leading-relaxed text-[var(--ai-danger)]">
                  Couldn't load the messages sent to this candidate just now - nothing has been
                  lost. Close the panel and reopen it to try again.
                </p>
              )}
              {inboundFailed && (
                <p className="m-0 text-[13px] leading-relaxed text-[var(--ai-danger)]">
                  Couldn't load this candidate's WhatsApp replies just now. Anything they sent is
                  still stored.
                </p>
              )}
              {!commLoading && !messagesFailed && !inboundFailed && commEntries.length === 0 && (
                <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">
                  Nothing sent or received yet.
                </p>
              )}
              {commEntries.map((entry) =>
                entry.kind === "sent" ? (
                  <MessageEntry key={entry.message.id} message={entry.message} />
                ) : (
                  <InboundEntry key={entry.message.id} message={entry.message} />
                ),
              )}
              {messagesTruncated && (
                <p className="m-0 pt-1 text-[12px] leading-relaxed text-[var(--ai-t3)]">
                  Older messages aren't shown - this trail carries the most recent{" "}
                  {APPLICATION_MESSAGE_CAP} sent.
                </p>
              )}
              {inboundTruncated && (
                <p className="m-0 pt-1 text-[12px] leading-relaxed text-[var(--ai-t3)]">
                  Older replies aren't shown - this trail carries the most recent{" "}
                  {APPLICATION_INBOUND_CAP} received.
                </p>
              )}
              {/* Why no WhatsApp can appear here, when that is the reason and
                  not the answer. Without this an unmatchable number reads as a
                  candidate who never replied. */}
              {INBOUND_BASIS_NOTE[inboundBasis] && (
                <p className="m-0 pt-1 text-[12px] leading-relaxed text-[var(--ai-t3)]">
                  {INBOUND_BASIS_NOTE[inboundBasis]}
                </p>
              )}
            </div>
          </PaneCard>
        )}

        {tab === "timeline" && (
          <TimelinePane
            row={row}
            history={history}
            historyLoading={historyLoading}
            historyFailed={historyFailed}
            scoreDetail={scoreDetail}
            comments={comments}
            messages={messages}
            messagesLoading={messagesLoading}
            messagesFailed={messagesFailed}
            messagesTruncated={messagesTruncated}
            clock={clock}
          />
        )}

        {tab === "interviews" && (
          /* No PaneCard here: the panel draws its own three sections, each with
             the design's subhead and its own card, because async, AI video and
             the call with your team are three separate decisions with separate
             status. */
          <InterviewPanel applicationId={row.id} viewerRole={viewerRole} onToast={onToast} />
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

const INBOUND_BASIS_NOTE: Record<InboundMatchBasis, string> = {
  phone: "",
  "no-phone-on-file":
    "No phone number on file for this candidate, so WhatsApp replies can't be matched to them.",
  "phone-not-normalisable":
    "This candidate's phone number isn't in a shape we can match on, so any WhatsApp reply from " +
    "them is in the admin inbox rather than here.",
};

type CommEntry =
  | { kind: "sent"; at: number; message: CandidateMessage }
  | { kind: "received"; at: number; message: InboundMessageRow };

function commTime(iso: string): number {
  const t = Date.parse(iso);
  // An unreadable stamp sinks to the bottom rather than landing somewhere
  // arbitrary in the middle of a list the reader is treating as chronological.
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Interleave the two directions into the one list the Communication tab shows.
 *
 * Sorted on `createdAt` for outbound and `receivedAt` for inbound. Those are
 * the same clock — both are the moment OUR database wrote the row — which is
 * what makes them comparable at all; Meta's own send time is not used on
 * either side.
 *
 * The stamp each entry DISPLAYS is a different field: an outbound message
 * shows when it was sent, or when a queued one is due. Sorting on the
 * displayed field would reorder the existing outbound trail, which has been
 * ordered by creation since it was built. So a scheduled message still sits at
 * its creation point while showing a future date, exactly as it did before
 * inbound existed.
 */
function mergeComm(sent: CandidateMessage[], received: InboundMessageRow[]): CommEntry[] {
  const entries: CommEntry[] = [
    ...sent.map((m) => ({ kind: "sent" as const, at: commTime(m.createdAt), message: m })),
    ...received.map((m) => ({
      kind: "received" as const,
      at: commTime(m.receivedAt),
      message: m,
    })),
  ];
  return entries.sort((a, b) => b.at - a.at);
}

/**
 * One reply the candidate sent us on WhatsApp.
 *
 * Direction has to read before anything else here, because this is the only
 * place a message the candidate sent sits beside one we sent, and the two
 * sources have nothing in common structurally. Three signals carry it, all
 * pointing the same way:
 *
 *  - a solid green left rule, the one colour no outbound kind uses (outbound
 *    is a grey rule, a heavier grey rule, or dashed amber);
 *  - a "Received" pill in the same slot outbound puts Scheduled / Automatic /
 *    Failed, so the reader is already looking there;
 *  - a first line that is the message itself. Outbound leads with a bold
 *    subject; WhatsApp has no subject, so the body IS the headline.
 *
 * No sender name. The drawer is already headed with the candidate, and the
 * only name WhatsApp offers is Meta's profile name — whatever the person set
 * on their own account, often not what they applied under. Beside the tab
 * header it reads as a mismatch rather than as information.
 *
 * The body is shown whole. Outbound entries are one line because a subject is
 * one line, but clamping a reply with no way to expand it would hide the only
 * thing this tab was extended to show.
 */
function InboundEntry({ message }: { message: InboundMessageRow }) {
  const placeholder = message.body ? null : placeholderFor(message.messageType);

  return (
    <div className="border-l-[2.5px] border-solid border-l-remotiv-green py-px pl-3 transition-colors hover:border-l-[var(--ai-mint-ink)]">
      {placeholder ? (
        <p className="m-0 text-[13.5px] italic leading-snug text-[var(--ai-t4)]">
          {placeholder.label}{" "}
          <span className="not-italic text-[var(--ai-t4)]">· {placeholder.note}</span>
        </p>
      ) : (
        <p className="m-0 whitespace-pre-wrap text-[13.5px] leading-snug text-[var(--ai-t1)]">
          {message.body}
        </p>
      )}
      <small className="mt-[3px] flex flex-wrap items-center gap-[7px] text-[11.5px] text-[var(--ai-t3)]">
        <span className="shrink-0 rounded-[5px] bg-[var(--ai-mint-tint)] px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-mint-ink)]">
          Received
        </span>
        <span>WhatsApp</span>
        {fmtMessageWhen(message.receivedAt)}
      </small>
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

// ── Timeline ─────────────────────────────────────────────────

/**
 * Where a timeline entry came from. Also its tie-break rank — see SOURCE_RANK.
 */
type TimelineSource = "applied" | "stage" | "score" | "shortlist" | "message" | "comment";

/**
 * Order between two entries that resolve to the SAME instant.
 *
 * Two causal pairs are produced here, and in both the consequence outranks its
 * cause, because a newest-first feed puts the later thing on top.
 *
 * Moving someone to `rejected` writes the history row and then fires the
 * rejection email, back to back, in one action; those two can land in the same
 * millisecond. Auto-shortlisting is the weaker case: the flag is written by a
 * score landing, but from its own `new Date()` rather than from `scored_at`, so
 * it is strictly later in practice and the tie is theoretical. It is ranked
 * anyway — a rank that only holds when observed is not a rank.
 *
 * The rest of the order is arbitrary but FIXED. A comment landing on the same
 * instant as a stage change is coincidence, and there is no true answer for
 * which came first; what matters is that the answer is the same on every render
 * rather than falling out of whatever order the arrays happened to concatenate
 * in. `applied` is lowest because nothing can precede it.
 */
const SOURCE_RANK: Record<TimelineSource, number> = {
  applied: 0,
  stage: 1,
  score: 2,
  shortlist: 3,
  message: 4,
  comment: 5,
};

/**
 * Who an entry is attributed to.
 *
 * Deliberately not "a person, possibly unnamed". Roughly half of what reaches
 * this feed — every automatic email, every AI score — had no human behind it,
 * and giving those a circle of initials would invent one. See TimelineAvatar.
 *
 * A system actor carries a name too. It is not used for initials; it is what
 * the sentence calls the thing that acted, so an automatic row reads "Remotiv
 * AI scored the application" rather than beginning with a verb and leaving the
 * actor to be guessed from an icon.
 */
type TimelineActor =
  | { kind: "person"; name: string }
  | { kind: "system"; icon: "score" | "mail"; name: string };

type TimelineBadge = { label: string; cls: string };

type TimelineEvent = {
  id: string;
  /**
   * Epoch milliseconds, resolved ONCE when the entry is built and never
   * re-derived inside the comparator.
   *
   * Not because ISO text sorts wrongly — for stamps in one format it does not,
   * since the fractional digits compare correctly left to right. The reason is
   * that sorting on raw stamps puts the FAILURE case inside the sort. An absent
   * or unparseable stamp parses to NaN, every comparison involving NaN answers
   * 0, and an inconsistent comparator does not merely misplace that one entry —
   * it leaves the order of the whole feed undefined. Resolving up front lets
   * instantOf return null and the builders drop the entry, so nothing that
   * cannot be placed ever reaches the sort.
   *
   * It also puts the sources on one axis: "applied" is timed from a column on
   * job_applications, scoring from application_scores.scored_at, and the rest
   * from their own created_at.
   */
  at: number;
  source: TimelineSource;
  actor: TimelineActor;
  /**
   * The sentence, with the actor bolded inside it — "Sana Riaz moved the stage
   * from Screening to Interview".
   *
   * A node rather than a string because the sentence embeds real stage pills
   * and status badges mid-clause, and because prose is what stops three
   * consecutive events by one person reading as the same label stamped three
   * times. It carries no state; the comparator never looks at it.
   */
  what: React.ReactNode;
  /** The entry's own words, in an inset box: a comment's body, a subject line. */
  excerpt?: string;
  /** Trailing muted clause — "due in 2 days", "edited". */
  suffix?: string;
};

/** Epoch ms, or null when the stamp is absent or unparseable. */
function instantOf(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * What the two automatic actors are called in a sentence.
 *
 * Not the company name. "Remotiv" is what company_members holds for this
 * workspace's owner, so using it here would make a human's stage change and a
 * model's score read as the same actor.
 */
const AI_ACTOR = "Remotiv AI";
const AUTO_ACTOR = "Automatic email";

/** The actor's name, bolded inside the sentence. */
function Who({ name }: { name: string }) {
  return <b className="font-bold text-[var(--ai-t1)]">{name}</b>;
}

/** A real stage pill, rendered mid-sentence rather than described in words. */
function TimelineStagePill({ stage }: { stage: PipelineStage }) {
  const pill = stagePill(stage);
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[3px] align-baseline text-[11px] font-bold ${pill.cls}`}
    >
      <span className={`size-[5px] shrink-0 rounded-full ${pill.dot}`} aria-hidden="true" />
      {pipelineStageLabel(stage)}
    </span>
  );
}

/**
 * "Applied" — synthesised from job_applications.created_at, always.
 *
 * There is no row for it. application_stage_history is only ever written by a
 * stage CHANGE, so the first entry any applicant has is their first move, and
 * an applicant who has never been moved has none at all. The card this pane
 * replaces synthesised "Applied" only when the history was empty, which meant
 * anyone moved even once had a history that never said when they applied.
 */
function appliedEvent(row: CompanyApplicantRow): TimelineEvent | null {
  const at = instantOf(row.created_at);
  if (at === null) return null;
  const name = fullName(row);
  return {
    id: `applied:${row.id}`,
    at,
    source: "applied",
    actor: { kind: "person", name },
    what: (
      <>
        <Who name={name} /> applied to{" "}
        <b className="font-bold text-[var(--ai-t1)]">{row.job_title}</b>
      </>
    ),
  };
}

/**
 * "Auto-shortlisted" — from the flag on the row, not from a log.
 *
 * The reason is a sentence the server already wrote ("CV score 72 met the
 * auto-shortlist threshold of 60.", flagReason in lib/interviews/shortlist.ts),
 * so it goes in the excerpt verbatim. Both sources it can name — a CV score and
 * an interview score — are the model's, which is why this is AI_ACTOR with the
 * score icon rather than a new kind of system actor.
 *
 * ── This entry is not permanent, and that is the flag's doing ─
 *
 * Dismissing the flag nulls `shortlist_flagged_at` while deliberately KEEPING
 * the reason (shortlist.ts:326), so a dismissed applicant has the sentence but
 * no instant. Keying on the instant means the entry disappears when a recruiter
 * dismisses it. That is the honest reading of the column — the feed can only
 * say "is flagged", because nothing records "was flagged and then was not" —
 * but it does mean this one line is a current state and not an audit record,
 * unlike every other entry here.
 */
function shortlistEvent(row: CompanyApplicantRow): TimelineEvent | null {
  const at = instantOf(row.shortlist.flaggedAt);
  if (at === null) return null;
  return {
    id: `shortlist:${row.id}`,
    at,
    source: "shortlist",
    actor: { kind: "system", icon: "score", name: AI_ACTOR },
    what: (
      <>
        <Who name={AI_ACTOR} /> flagged the application as{" "}
        <b className="font-bold text-[var(--ai-t1)]">worth a look</b>
      </>
    ),
    excerpt: row.shortlist.reason ?? undefined,
  };
}

function stageEvents(history: StageHistoryRow[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const h of history) {
    const at = instantOf(h.created_at);
    if (at === null) continue;
    // changed_by_name is snapshotted on write and has never been null in
    // practice; a stage change is always somebody's doing.
    const name = h.changed_by_name ?? "Someone";
    out.push({
      id: `stage:${h.id}`,
      at,
      source: "stage",
      actor: { kind: "person", name },
      what: h.from_stage ? (
        <>
          <Who name={name} /> moved the stage from <TimelineStagePill stage={h.from_stage} /> to{" "}
          <TimelineStagePill stage={h.to_stage} />
        </>
      ) : (
        <>
          <Who name={name} /> moved the stage to <TimelineStagePill stage={h.to_stage} />
        </>
      ),
      excerpt: h.note ?? undefined,
    });
  }
  return out;
}

/**
 * Scoring, and the human adjustment of a score.
 *
 * scored_at is the model's own stamp and lands roughly 100ms BEFORE the row's
 * created_at — well inside a second, so it cannot reorder this entry against
 * anything from another source, and it is the closest thing the detail exposes
 * to when the score entered the record.
 *
 * It is null on exactly the rows where overall_score is null (89 of 130 at the
 * time of writing, correlation exact) — cards where scoring produced nothing.
 * There is no event to show for those, so the guard costs nothing.
 *
 * NOTE: the adjustment branch is UNTESTED against real data. adjusted_at has
 * never been set on any row in the database, so this has only ever been
 * exercised by reading the code.
 */
function scoreEvents(detail: ApplicantScoreDetail | null): TimelineEvent[] {
  if (!detail) return [];
  const out: TimelineEvent[] = [];

  const scored = instantOf(detail.scored_at);
  // ai_overall, never `overall` — this entry records what the MODEL said at
  // that moment, and `overall` carries a later human override. Showing the
  // override here would date someone else's number to the model's timestamp.
  if (scored !== null && detail.ai_overall !== null) {
    out.push({
      id: "score:ai",
      at: scored,
      source: "score",
      actor: { kind: "system", icon: "score", name: AI_ACTOR },
      what: (
        <>
          <Who name={AI_ACTOR} /> scored the application{" "}
          <b className="font-bold text-[var(--ai-t1)]">{detail.ai_overall} / 100</b>
        </>
      ),
      // The model that produced it, and nothing more. The design's second
      // clause here named the inputs ("CV + 3 screening answers"); no column
      // records what was actually fed at scored_at, and rebuilding it from the
      // row as it stands today would describe this moment, not that one.
      excerpt: detail.ai_model ? `Model ${detail.ai_model}` : undefined,
    });
  }

  const adjusted = instantOf(detail.adjusted_at);
  if (adjusted !== null) {
    // An adjustment is always somebody's doing, so an unnamed one is an unknown
    // person rather than the model — the same fallback stageEvents uses.
    const name = detail.adjusted_by_name ?? "Someone";
    out.push({
      id: "score:adjusted",
      at: adjusted,
      source: "score",
      actor: { kind: "person", name },
      what:
        detail.adjusted && detail.overall !== null ? (
          <>
            <Who name={name} /> adjusted the score to{" "}
            <b className="font-bold text-[var(--ai-t1)]">{detail.overall}</b>
          </>
        ) : (
          <>
            <Who name={name} /> adjusted the score
          </>
        ),
      excerpt: detail.human_feedback ?? undefined,
    });
  }

  return out;
}

/**
 * Comments, minus the tombstones.
 *
 * A tombstone earns its place in the Comments tab because a reply sits under it
 * and needs to know what it was answering. Here there is no threading, so it
 * would be a row saying "something was here" among rows that say what they are
 * — and neither of its timestamps can be rendered honestly: created_at puts the
 * removal notice BEFORE the reply it was removed after, and deleted_at makes it
 * a deletion event that the table cannot attribute, since owners and admins may
 * delete anyone's.
 */
function commentEvents(comments: ApplicantComment[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const c of comments) {
    if (c.deletedAt !== null) continue;
    const at = instantOf(c.createdAt);
    if (at === null) continue;
    out.push({
      id: `comment:${c.id}`,
      at,
      source: "comment",
      actor: { kind: "person", name: c.authorName },
      what: (
        <>
          <Who name={c.authorName} /> {c.parentId ? "replied" : "commented"}
        </>
      ),
      excerpt: c.body ?? undefined,
      // The body on screen is the edited one, so the stamp beside it would
      // otherwise date text that did not exist at that moment.
      suffix: c.updatedAt !== c.createdAt ? "edited" : undefined,
    });
  }
  return out;
}

/**
 * Messages, placed by when they were WRITTEN.
 *
 * createdAt throughout, including for something still queued. Placing a
 * scheduled message at the instant it is due would put a future timestamp into
 * a feed ordered by the past — it would sort above today's events and read as
 * something that has already happened. The row says when it is due instead.
 *
 * Where a message actually left materially later than it was written, the meta
 * says so rather than letting createdAt quietly stand in for both. The
 * threshold keeps that off the ordinary row: across 204 sent messages the
 * largest gap was 3.1 seconds and none exceeded a minute, so this is dormant
 * until something is genuinely scheduled.
 */
const SENT_LAG_WORTH_SAYING_MS = 60_000;

/**
 * Only failure gets a badge now.
 *
 * The kind used to be one: Automatic, Scheduled, Failed. Two of those are now
 * said by the sentence itself — an automatic message names "Automatic email" as
 * its actor, and a queued one reads "scheduled" as its verb — so the badge was
 * repeating the clause beside it. A failure is worth the second signal.
 */
const FAILED_BADGE: TimelineBadge = {
  label: "Failed",
  cls: "bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]",
};

function messageEvents(messages: CandidateMessage[], local: boolean): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const m of messages) {
    const at = instantOf(m.createdAt);
    if (at === null) continue;

    const scheduled = m.kind === "scheduled";
    const sent = instantOf(m.sentAt);
    const lagged = sent !== null && sent - at > SENT_LAG_WORTH_SAYING_MS;

    const suffix = scheduled
      ? `due ${fmtMessageWhen(m.scheduledFor ?? m.createdAt)}`
      : lagged
        ? `sent ${fmtDay(m.sentAt, local) ?? ""}`.trim()
        : undefined;

    // A manual message whose sender was never recorded is still a person's
    // doing — it predates communication_logs.sent_by_name. Calling it automatic
    // would be the one reading of it that is certainly wrong.
    const automatic = m.kind === "automatic";
    const name = automatic ? AUTO_ACTOR : (m.sentByName ?? "Someone");
    const verb = scheduled
      ? "scheduled a message"
      : m.kind === "failed"
        ? "failed to send"
        : "sent a message";

    out.push({
      id: `message:${m.id}`,
      at,
      source: "message",
      actor: automatic
        ? { kind: "system", icon: "mail", name: AUTO_ACTOR }
        : { kind: "person", name },
      what: (
        <>
          <Who name={name} /> {verb}
          {m.kind === "failed" && (
            <>
              {" - "}
              <span
                className={`ml-0.5 inline-flex items-center rounded-[5px] px-[7px] py-0.5 align-baseline text-[9.5px] font-extrabold uppercase tracking-[0.06em] ${FAILED_BADGE.cls}`}
              >
                {FAILED_BADGE.label}
              </span>
            </>
          )}
        </>
      ),
      excerpt: `“${m.subject || "(no subject)"}”`,
      suffix,
    });
  }
  return out;
}

/**
 * Every source merged into one newest-first order.
 *
 * The comparator reads two numbers already resolved onto each entry and never
 * reaches back into a field: `at` first, then SOURCE_RANK for a shared instant,
 * then the id so that two entries from the same source at the same instant
 * still order the same way twice running. Array.prototype.sort's stability
 * would otherwise be resolving those, which means the answer would depend on
 * the order the arrays were concatenated in.
 */
function buildTimeline(
  row: CompanyApplicantRow,
  history: StageHistoryRow[],
  detail: ApplicantScoreDetail | null,
  comments: ApplicantComment[],
  messages: CandidateMessage[],
  local: boolean,
): TimelineEvent[] {
  const applied = appliedEvent(row);
  const shortlisted = shortlistEvent(row);
  const events = [
    ...(applied ? [applied] : []),
    ...(shortlisted ? [shortlisted] : []),
    ...stageEvents(history),
    ...scoreEvents(detail),
    ...commentEvents(comments),
    ...messageEvents(messages, local),
  ];

  return events.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    const rank = SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
    return rank !== 0 ? rank : a.id.localeCompare(b.id);
  });
}

/**
 * A circle is a person. A rounded square is not.
 *
 * A deliberate divergence from the design, which gives every actor the same
 * circle and separates the automatic ones by an ink fill and the letters "AI".
 * That works in the design because its feed never puts an automatic message
 * beside a human one — it attributes every message to a person and reserves the
 * ink circle for scoring. Ours shows automatic mail too, so an automatic email
 * and a colleague's comment sit one above the other in the same column, and a
 * circle of initials on both would say a person sent both.
 *
 * The naming IS taken from the design: the sentence says who acted, which is
 * the part an icon alone was leaving to be guessed.
 */
function TimelineAvatar({ actor }: { actor: TimelineActor }) {
  if (actor.kind === "system") {
    const Icon = actor.icon === "score" ? Zap : Mail;
    return (
      <span className="grid size-[34px] shrink-0 place-items-center rounded-[11px] bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]">
        <Icon className="size-4" strokeWidth={2.2} />
      </span>
    );
  }
  const tint = getTint(actor.name);
  return (
    <span
      className="grid size-[34px] shrink-0 place-items-center rounded-full text-[11px] font-bold"
      style={{ background: tint.bg, color: tint.fg }}
    >
      {msgInitials(actor.name)}
    </span>
  );
}

/**
 * "Today, 09:14" · "Yesterday, 17:40" · "17 Sept, 14:22". Deliberately not
 * fmtApplied, which stops at the day.
 *
 * Day granularity is right on the Profile card, which is read for what changed
 * rather than when. It is not right in a merged feed, where two events on one
 * day used to render byline-identical and the order was carried by vertical
 * position with nothing on screen corroborating it.
 *
 * Minute granularity, and the limit is worth stating rather than discovering:
 * it separates events minutes apart, NOT seconds apart. The three consecutive
 * stage changes in this workspace are six and eight seconds apart and still
 * render identically. The design has the same tie — it stamps two events
 * "17 Sep, 14:22" and does nothing about it — so this matches rather than
 * improves on it. Separating those needs seconds, which is audit-log precision.
 *
 * Today/Yesterday are CALENDAR days in the rendering zone, not a rolling 24
 * hours. Under a rolling window something at 23:00 last night reads "Today" for
 * most of the morning, which the old relative-only format could hide and this
 * one cannot: it prints an absolute date in the very next branch.
 *
 * The year appears only when it is not the current one. "17 Sept, 14:22" on a
 * row from two years ago is the kind of thing that reads as recent.
 *
 * `local` is threaded exactly as fmtApplied threads it. clock.now is the
 * server's renderedAt until hydration and clock.local false with it, so the
 * first client render reproduces the server's text and only the second differs.
 * `at` needs no NaN branch: instantOf rejects an unplaceable stamp and every
 * builder skips the row rather than pushing it.
 */
function fmtTimelineStamp(at: number, clock: PageClock): string {
  const zone = clock.local ? undefined : "UTC";
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
  // en-CA renders YYYY-MM-DD, which makes "same calendar day in this zone" a
  // string comparison instead of three getters that would read the wrong zone.
  const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: zone });
  const absolute = (withYear: boolean) =>
    `${d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      ...(withYear ? { year: "numeric" as const } : {}),
      timeZone: zone,
    })}, ${time}`;

  if (clock.now <= 0) return absolute(false);

  const key = dayKey(at);
  if (key === dayKey(clock.now)) return `Today, ${time}`;
  if (key === dayKey(clock.now - 86_400_000)) return `Yesterday, ${time}`;
  return absolute(key.slice(0, 4) !== dayKey(clock.now).slice(0, 4));
}

function TimelineRow({ event, clock }: { event: TimelineEvent; clock: PageClock }) {
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_max-content] items-start gap-3.5 border-t border-[var(--ai-line-soft)] py-3.5 first:border-t-0 first:pt-0">
      <TimelineAvatar actor={event.actor} />
      <div className="min-w-0">
        <p className="m-0 max-w-[700px] text-[12.5px] leading-[1.6] text-[var(--ai-t2)]">
          {event.what}
          {event.suffix && <span className="text-[var(--ai-t3)]"> · {event.suffix}</span>}
        </p>
        {event.excerpt && (
          <p className="m-0 mt-[7px] max-w-[700px] whitespace-pre-wrap rounded-xl bg-[var(--ai-inset)] px-[13px] py-2.5 text-[12.5px] leading-[1.6] text-[var(--ai-t2)]">
            {event.excerpt}
          </p>
        )}
      </div>
      <span className="whitespace-nowrap pt-px text-right text-[11px] font-semibold text-[var(--ai-t3)]">
        {fmtTimelineStamp(event.at, clock)}
      </span>
    </div>
  );
}

const TIMELINE_NOTICE = "m-0 rounded-xl border px-3.5 py-2.5 text-[12px] leading-relaxed";

/**
 * The merged feed.
 *
 * Two incompleteness notices, in two different places, because they mean
 * different things. A failed message read qualifies the WHOLE feed and cannot
 * say how much is missing, so it sits at the top before anything is read. A
 * truncated read knows exactly what it dropped — the oldest messages, since the
 * cap takes the most recent — so it sits at the bottom, where those entries
 * would have been.
 */
function TimelinePane({
  row,
  history,
  historyLoading,
  historyFailed,
  scoreDetail,
  comments,
  messages,
  messagesLoading,
  messagesFailed,
  messagesTruncated,
  clock,
}: {
  row: CompanyApplicantRow;
  history: StageHistoryRow[];
  historyLoading: boolean;
  historyFailed: boolean;
  scoreDetail: ApplicantScoreDetail | null;
  comments: ApplicantComment[];
  messages: CandidateMessage[];
  messagesLoading: boolean;
  messagesFailed: boolean;
  messagesTruncated: boolean;
  clock: PageClock;
}) {
  const events = useMemo(
    () => buildTimeline(row, history, scoreDetail, comments, messages, clock.local),
    [row, history, scoreDetail, comments, messages, clock.local],
  );

  const loading = historyLoading || messagesLoading;

  // Stated rather than assumed. The order is the one thing a merged feed cannot
  // show by looking at it, and the count tells a reader whether a short feed is
  // all there is — which the notices below then qualify when it is not.
  const meta = loading
    ? undefined
    : `Newest first · ${events.length} ${events.length === 1 ? "event" : "events"}`;

  return (
    <PaneCard title="Activity" meta={meta}>
      <div className="flex flex-col gap-4">
        {historyFailed && (
          <p
            className={`${TIMELINE_NOTICE} border-[var(--ai-danger)]/30 bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
          >
            This applicant's stage history and comments couldn't be loaded, so entries are missing
            from this feed. Close the panel and reopen it to try again.
          </p>
        )}
        {messagesFailed && (
          <p
            className={`${TIMELINE_NOTICE} border-[var(--ai-danger)]/30 bg-[var(--ai-danger-tint)] text-[var(--ai-danger)]`}
          >
            Messages couldn't be loaded, so any email sent to this candidate is missing from the
            feed below. Everything else is here.
          </p>
        )}

        {loading && events.length === 0 && (
          <div className="flex flex-col gap-3">
            <div className="h-[11px] w-2/3 animate-pulse rounded-full bg-[var(--ai-inset)]" />
            <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />
          </div>
        )}

        {/* Own wrapper so `first:border-t-0` lands on the first ROW. With the
            rows as direct siblings of the notices, a rendered notice would take
            that rule and every row would carry a top border. */}
        {events.length > 0 && (
          <div>
            {events.map((e) => (
              <TimelineRow key={e.id} event={e} clock={clock} />
            ))}
          </div>
        )}

        {messagesTruncated && (
          <p
            className={`${TIMELINE_NOTICE} border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t2)]`}
          >
            Older messages aren't shown - this feed carries the most recent{" "}
            {APPLICATION_MESSAGE_CAP}. Stage changes and comments above are complete.
          </p>
        )}
      </div>
    </PaneCard>
  );
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
          edit and delete your own - your teammates&apos; stay as they wrote them.
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
        <small className="text-[11px] text-[var(--ai-t4)]">Replied to - editing closed</small>
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
  initialPage,
  servedRequest,
  initialTopScored,
  assignableJobs,
  initialCounts,
  companyName,
  replyToAddress,
  manualTemplates,
  unassigned,
  showScoringTip,
  renderedAt,
  quotaBanner,
}: {
  viewerRole: CompanyRole;
  /**
   * The viewer's own company_members.id, for deciding which comments carry an
   * Edit and a Delete. Compared client-side only as a display rule — every
   * mutation re-derives it server-side and puts it on the statement itself.
   */
  viewerMemberId: string;
  /**
   * ONE page of applicants, already filtered, ordered and counted server-side,
   * plus the filtered total. Null when the read failed — which an empty page
   * cannot express, since "nobody matches" and "nothing was read" draw the
   * same table.
   */
  initialPage: CompanyApplicantPage | null;
  /**
   * The request `initialPage` answers, decoded from the URL by the server pass.
   *
   * The mount fetch is skipped by comparing the rendered request against this,
   * so it has to be what was actually read rather than the action's defaults.
   * A link carrying `?stage=screening&page=3` is served those rows, says so
   * here, and costs no second round trip; the defaults would have claimed page
   * 1 of everybody and the skip would have believed it.
   */
  servedRequest: ListRequest;
  /**
   * The ten best scored applicants over the whole population, for "Review top
   * 10" and the "Top match" chips. Null when that read failed, so the chips
   * stay off rather than asserting nobody cleared the bar.
   */
  initialTopScored: CompanyApplicantRow[] | null;
  /**
   * Every role the viewer may file a manual add under, and now also every role
   * the job filter offers.
   *
   * It could never be derived from the rows for the Add form — a job with no
   * applicants yet is exactly the one you are adding the first to — and as of
   * this pass the filter cannot derive it either, because the rows are a page.
   */
  assignableJobs: AssignableJob[];
  /**
   * Every population figure, counted server-side and resolved in the page's
   * first wave — so the first paint carries true numbers rather than a
   * skeleton. Null when the whole batch failed; a single unreadable count
   * arrives as a null FIELD. Either way the surfaces draw an em dash, never 0.
   */
  initialCounts: ApplicantCounts | null;
  companyName: string;
  replyToAddress: string | null;
  manualTemplates: ManualTemplate[];
  /** True for a scoped member on no hiring teams — see the empty state. */
  unassigned: boolean;
  /**
   * This member has not yet dismissed the CV scoring tip. Whether it actually
   * appears is narrower still: only on the Review pane of a scored applicant
   * who is not flagged, and only if no other tip has claimed this page load.
   */
  showScoringTip: boolean;
  /**
   * The SERVER's clock at render time, so the server pass and the hydrating
   * client pass agree on "2d ago". Replaced by the live clock once hydrated.
   */
  renderedAt: number;
  /** The recruiter's quota notices, already rendered on the server, or null. */
  quotaBanner: ReactNode;
}) {
  // Same predicate the server action enforces (owner / admin / recruiter).
  // Hiring managers review candidates but do not spend the company's scoring
  // budget — rescoreApplication would reject them anyway; this stops the UI
  // offering a button that can only fail.
  const canRescore = canCreateJobs(viewerRole);
  /**
   * Same predicate, separate name: adding a candidate and spending scoring
   * budget are different permissions that happen to coincide today, and the
   * server action gates them independently.
   */
  const canAddApplicant = canCreateJobs(viewerRole);
  const router = useRouter();

  /*
   * ── The URL holds the filters ───────────────────────────────
   *
   * Not a copy of them: the URL IS the state, and every filter below is read
   * out of it rather than held beside it. Two stores would have to be
   * reconciled, and the reconciliation is where this normally goes wrong —
   * a write echoes back and clobbers a newer value, or Back updates one store
   * and not the other.
   *
   * With one store, Back and Forward need no handling at all. They change the
   * query string, `useSearchParams` reports it, and the list re-reads for the
   * same reason it re-reads when a tab is clicked. A refresh is covered by the
   * server pass decoding the same URL — see `servedRequest`.
   *
   * ── Why the native history API and not router.push ──────────
   *
   * `page.tsx` now reads `searchParams`, so it is dynamic on them: a
   * `router.push` to the same route with a new query string re-runs that whole
   * server pass — seven parallel database reads — to produce rows this
   * component is about to fetch for itself. `window.history.pushState` is the
   * documented way to move the URL without a navigation, and it still feeds
   * `useSearchParams`. So a filter change costs exactly one read, as it did
   * when the filters were component state.
   */
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Memoised on the STRING, not the params object: a value comparison cannot
  // be defeated by a new wrapper identity for an unchanged query string, and
  // `request` has to be stable or the fetch effect below re-reads every render.
  const paramString = searchParams.toString();
  const urlState = useMemo(() => decodeListUrl(new URLSearchParams(paramString)), [paramString]);
  const request = urlState.request;
  const topOnly = urlState.topOnly;
  const tab: "all" | PipelineStage = request.stage ?? "all";
  const jobFilter = request.jobId ?? "all";
  const flaggedOnly = request.flaggedOnly;
  const sort = request.sort;
  const page = request.page;

  /**
   * Write a list state to the address bar.
   *
   * `window.location.search` rather than `paramString` as the base: two writes
   * in one handler must compose, and the second one needs what the first just
   * wrote. The hook's value is a render ago.
   */
  const writeUrl = useCallback(
    (next: ListUrlState, mode: "push" | "replace") => {
      const qs = encodeListUrl(next, window.location.search);
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    },
    [pathname],
  );

  /**
   * Move one or more filters, and go back to page 1 unless a page is named.
   *
   * The page reset used to be an effect watching every filter. It belongs
   * here: page 4 of the previous result set means nothing under a new filter,
   * and doing it in the same write avoids a render that asks the server for a
   * page the reader will never see.
   *
   * `push` by default, so Back undoes a filter rather than leaving the page —
   * which is what it did when no filter change ever reached the history stack.
   * `replace` is for the writes that are not decisions: the debounced search,
   * the out-of-range clamp, and a drawer step that happens to turn the page.
   */
  const setFilters = useCallback(
    (over: Partial<ListRequest> & { topOnly?: boolean }, mode: "push" | "replace" = "push") => {
      const { topOnly: nextTop, ...fields } = over;
      /*
       * The base is DECODED FROM THE LIVE URL, not from the `request` this
       * render closed over. Two reasons, and both are load-bearing:
       *
       *   - It composes. A handler that moves a filter and then writes again
       *     gets the first write's result, not a value from a render ago.
       *   - It makes this callback stable. Keyed on `request`, its identity
       *     changed on every filter move, which restarted the search debounce
       *     timer below each time any unrelated filter moved.
       */
      const live = decodeListUrl(new URLSearchParams(window.location.search));
      writeUrl(
        {
          request: { ...live.request, ...fields, page: fields.page ?? 1 },
          topOnly: nextTop ?? live.topOnly,
        },
        mode,
      );
    },
    [writeUrl],
  );

  /*
   * ── The page of rows ────────────────────────────────────────
   *
   * Seeded from the server pass, so the first paint needs no round trip, and
   * re-read whenever anything the query depends on moves. The reducer is in
   * list-state.ts and the sequence counter is a ref, for the same reason the
   * counts below use that shape: a reducer cannot mint the number and stay
   * pure, and deriving it from previous state would double-count under
   * StrictMode's deliberate double invocation.
   *
   * `initialPage` is the FIRST page under the default filters. Every later page
   * is a fetch, so unlike the old prop this one is not re-synced on every
   * server render — doing so would throw a reader on page 4 back to page 1
   * each time an unrelated mutation called router.refresh().
   */
  const [list, setList] = useState<ListState>(() => seedList(listKey(servedRequest), initialPage));
  const listSeq = useRef(0);
  const pageView = listView(list);
  /*
   * The request the rows on screen were read for.
   *
   * It starts at what the SERVER answered, which is how the mount fetch is
   * skipped — and skipping it by key rather than by an "is this the first
   * run" flag is what keeps the skip honest when the two disagree. They can
   * still disagree: `?applicant=` and `?tab=` are not part of the request, so
   * a URL carrying only those is served the default page and matches, while a
   * URL the server could not fully honour would not.
   */
  const servedKey = useRef(listKey(servedRequest));

  /*
   * The ten best scored, over the whole population.
   *
   * Its own read because it is a claim about everyone and the list is a page.
   * Null is "unread", which is why the chips and the Review-top button both
   * check it rather than treating an empty array as "nobody qualified".
   */
  const [topScored, setTopScored] = useState<CompanyApplicantRow[] | null>(initialTopScored);

  /** Server aggregate over the workspace — never a count of rendered rows. */
  const [flaggedCount, setFlaggedCount] = useState<number | null>(null);
  /** The id mid-dismiss, so one chip disables without freezing the list. */
  const [dismissing, setDismissing] = useState<string | null>(null);

  /*
   * ── The population figures ──────────────────────────────────
   *
   * Seeded from the server pass, so there is no first-paint skeleton and no
   * browser round trip on load. Re-read only when the job filter moves or a
   * mutation changes who is in the pipeline.
   *
   * The reducer is in counts-state.ts and the sequence counter is a ref here,
   * because the reducer cannot mint the number and stay pure — and deriving it
   * from the previous state inside a reducer would double-count under
   * StrictMode's deliberate double invocation.
   */
  const [counts, setCounts] = useState<CountsState>(() =>
    seedCounts(countsKey(null), initialCounts),
  );
  const countsSeq = useRef(0);
  const view = countsView(counts);

  /**
   * Re-read the counts for the filter now showing.
   *
   * Every response is tagged with the key it was asked for AND the sequence
   * number of its request, and `settleCounts` applies only the newest. Job A →
   * job B → job A leaves two outstanding requests both carrying key A, so the
   * key alone would let the older one land on top of the newer.
   */
  const refreshCounts = useCallback((jobId: string | null) => {
    const key = countsKey(jobId);
    const seq = ++countsSeq.current;
    setCounts((prev) => requestCounts(prev, key, seq));
    fetchApplicantCounts(jobId ? { jobId } : {})
      .then((read) => {
        setCounts((prev) => settleCounts(prev, { key, seq, counts: read.ok ? read.value : null }));
      })
      .catch(() => {
        setCounts((prev) => settleCounts(prev, { key, seq, counts: null }));
      });
  }, []);

  // Skips the very first run: the server already answered for "all", and
  // re-asking on mount would spend nine head-counts to learn what the page was
  // rendered with.
  const countsPrimed = useRef(false);
  useEffect(() => {
    if (!countsPrimed.current) {
      countsPrimed.current = true;
      return;
    }
    refreshCounts(jobFilter === "all" ? null : jobFilter);
  }, [jobFilter, refreshCounts]);

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
   * on a round trip feels broken — and the re-read reconciles with the server
   * afterwards. On failure the toast says so and the re-read puts the chip
   * back, so the UI never keeps a lie.
   */
  async function dismissFlag(id: string) {
    if (dismissing) return;
    setDismissing(id);
    setFlaggedCount((n) => (typeof n === "number" ? Math.max(0, n - 1) : n));
    const result = await dismissShortlistFlagAction(id);
    setDismissing(null);
    if (!result.success) {
      setToast({ message: result.error, tone: "error" });
    }
    /*
     * Either way: success needs the row's stored flag cleared, failure needs
     * the optimistic change undone. One re-read covers both — and it has to be
     * this rather than router.refresh(), because the flag is a column of a row
     * that is no longer a prop. Under the Flagged chip the row also has to
     * LEAVE the page, which only a re-read can do.
     */
    refreshList(request);
    router.refresh();
  }

  /**
   * Add someone who never applied.
   *
   * Two failure shapes, rendered differently on purpose. A plain error is a
   * sentence in the form. A DUPLICATE is not really an error — the candidate
   * the recruiter wants is already in the pipeline — so it becomes a panel that
   * names them and offers the thing they actually came to do: open that
   * applicant and attach the CV there.
   *
   * The refusal sentence is composed HERE rather than taken from `error`,
   * because the date has to be formatted in the reader's timezone off the same
   * clock every other date on this page uses.
   */
  async function submitAdd(form: FormData) {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(null);
    setAddDuplicate(null);
    const result = await addCompanyApplicant(form);
    setAddBusy(false);
    if (!result.success) {
      if (result.duplicate) setAddDuplicate(result.duplicate);
      else setAddError(result.error);
      return;
    }
    setAddOpen(false);
    if (result.data.cvTextStatus !== "completed") {
      setToast("Candidate added, but no text could be read from their CV. They won't be scored.");
    } else if (!result.data.scoreQueued) {
      setToast("Candidate added, but scoring could not be queued. Use Re-score to try again.");
    } else {
      setToast("Candidate added. Scoring their CV now.");
    }
    // One more person in the pipeline — see handleDelete for why neither the
    // rows nor the counts can be left to router.refresh().
    refreshCounts(jobFilter === "all" ? null : jobFilter);
    refreshList(request);
    router.refresh();
  }
  /*
   * ── The search box ──────────────────────────────────────────
   *
   * The one filter with local state as well as a URL param, and it needs both:
   * the box has to show every keystroke, while the FILTER is the debounced
   * value — a request per character would have the reader watching answers to
   * prefixes of what they typed.
   *
   * Two stores means a reconciliation, and `typedSearch` is what makes it
   * safe. The URL changes for two different reasons and they need opposite
   * handling: our own debounced write echoing back must be ignored (the box
   * already holds a newer value, and copying the echo over it drops the
   * characters typed since), while Back, Forward or a pasted link must
   * overwrite the box. The ref records what we wrote, so the echo is
   * recognisable and everything else is foreign by elimination.
   */
  const urlSearch = request.search;
  const typedSearch = useRef(urlSearch);
  const [search, setSearch] = useState(urlSearch);

  useEffect(() => {
    if (urlSearch === typedSearch.current) return;
    typedSearch.current = urlSearch;
    setSearch(urlSearch);
  }, [urlSearch]);

  /*
   * `replace`, not `push`: a committed search term is not a decision the way
   * picking a tab is, and a reader typing a name with pauses in it would
   * otherwise mint an entry per pause and have to press Back six times to
   * leave the page. Same reasoning as the panel's URL below.
   */
  useEffect(() => {
    if (search === urlSearch) return;
    const t = setTimeout(() => {
      typedSearch.current = search;
      setFilters({ search }, "replace");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, urlSearch, setFilters]);
  /**
   * Opened from ?applicant=, so a notification about ONE candidate opens that
   * candidate.
   *
   * No filter is touched to get there, and none needs to be. The link used to
   * work because `rows` held every applicant the member could see, so the id
   * always resolved locally; `rows` is now one page of twenty, and the id
   * usually will not be on it. What resolves the link instead is the drawer's
   * own detail read — see `offPageRow` and `openRow` — so a link from the bell
   * still does not depend on which tab, page or filter was left selected.
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
  /*
   * The URL wins outright, INCLUDING when it names nobody.
   *
   * The guard this replaces kept the open candidate whenever the URL had none,
   * which could not tell "this history entry predates the panel" from "nothing
   * changed". Back onto an entry pushed by a filter move before the panel
   * opened then left the panel open over a URL that said it was shut.
   *
   * Keyed on `deepLinkId` alone, which is what makes the unconditional write
   * safe: opening sets the state and then the param, so this runs only once the
   * param has caught up and the write is a no-op. Adding `openId` to the deps
   * would fire it during that gap and close the panel just opened.
   */
  useEffect(() => {
    setOpenId(deepLinkId);
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
   *
   * `window.history`, not `router.replace`, for the reason `writeUrl` gives —
   * `page.tsx` is dynamic on the query string now, so a router navigation to
   * open a panel would re-run seven database reads to change nothing on the
   * server. It also kept the scroll position, which the native call does by
   * not being a navigation at all.
   *
   * `window.location.search` rather than the hook's value, so that a handler
   * which moves a filter AND opens a panel composes instead of the second
   * write reverting the first.
   */
  const syncPanelUrl = useCallback(
    (applicantId: string | null, tab: PanelTab) => {
      const qs = encodePanelUrl(window.location.search, applicantId, tab);
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname],
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
  /**
   * Re-read the page for a request.
   *
   * A callback rather than only an effect because a mutation has to be able to
   * ask for the rows again without changing the request. The rows used to be a
   * prop, so `router.refresh()` reconciled them; it cannot now — it re-runs the
   * server pass, and this component deliberately ignores the page prop after
   * mount so a reader on page 4 is not thrown back to page 1. Every handler
   * that changes who is on the page therefore calls this.
   */
  const refreshList = useCallback((r: ListRequest) => {
    const key = listKey(r);
    const seq = ++listSeq.current;
    setList((prev) => requestList(prev, key, seq));
    fetchCompanyApplicants(listQueryFor(r))
      .then((read) => {
        setList((prev) => settleList(prev, { key, seq, page: read.ok ? read.value : null }));
      })
      .catch(() => {
        setList((prev) => settleList(prev, { key, seq, page: null }));
      });
  }, []);

  const listPrimed = useRef(false);
  useEffect(() => {
    /*
     * The mount fetch is skipped by KEY, not by "is this the first run".
     *
     * `servedRequest` is what the server pass actually read — it decodes the
     * same URL through the same codec — so on a cold load the keys match and
     * there is no round trip. The comparison is still a comparison rather than
     * a first-run flag because the two CAN disagree: a filter moved before
     * hydration completes changes `request` on the same first run, and a
     * first-run flag would skip the fetch and leave the unfiltered page under
     * a filled-in toolbar.
     */
    if (!listPrimed.current) {
      listPrimed.current = true;
      if (listKey(request) === servedKey.current) return;
    }
    refreshList(request);
  }, [request, refreshList]);

  /*
   * The top ten, re-read when a FILTER moves but not when the page or the sort
   * does — neither changes which ten are best.
   *
   * No sequence guard here, and it needs one less than the list does: the
   * filter key is checked against the request in flight, and the worst a late
   * response can do is replace ten chip ids with ten others for the same
   * filters. The list cannot take that risk because its rows are a page of an
   * ordering, and a stale page under a current filter is a different claim.
   */
  const topPrimed = useRef(false);
  const topKey = filterKey(request);
  /*
   * `request` carries the sort and the page, and neither changes which ten are
   * best — so depending on it would re-read the top ten on every page turn and
   * flicker the chips for no reason. `topKey` IS the filter half of that same
   * request, which is the dependency this effect actually has; the rule cannot
   * see that one is derived from the other.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the filter half of `request` — see above
  useEffect(() => {
    if (!topPrimed.current) {
      topPrimed.current = true;
      return;
    }
    let live = true;
    setTopScored(null);
    fetchTopScoredApplicants(listQueryFor(request))
      .then((read) => {
        if (live) setTopScored(read.ok ? read.value : null);
      })
      .catch(() => {
        if (live) setTopScored(null);
      });
    return () => {
      live = false;
    };
  }, [topKey]);

  /*
   * A page number past the end, corrected once the total is known.
   *
   * The clamp cannot happen before the read, because the total that defines
   * the range is what the read returns. So an out-of-range page costs one
   * extra round trip and then settles — `fetchCompanyApplicants` answers it
   * with no rows and a true total specifically so there is something to clamp
   * against. Writing `page` here re-runs the effect above exactly once, since
   * the clamped value is in range and the comparison then holds.
   */
  useEffect(() => {
    const clamped = clampPage(page, pageView.total);
    // `replace`: a page that does not exist was never a place the reader
    // chose, so Back must not return them to it.
    if (clamped !== page) setFilters({ page: clamped }, "replace");
  }, [page, pageView.total, setFilters]);

  const [deleteTarget, setDeleteTarget] = useState<CompanyApplicantRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The Add candidate form: open, mid-submit, and its two failure shapes. */
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addDuplicate, setAddDuplicate] = useState<AddApplicantDuplicate | null>(null);
  const [toast, setToast] = useToast();

  // The two page-level dialogs. Each stacks over the drawer when opened from
  // it; Escape closes the top one only, and focus returns into the drawer.
  const addDialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(addDialogRef, addOpen, { onClose: () => setAddOpen(false) });
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(deleteDialogRef, deleteTarget !== null, {
    onClose: () => setDeleteTarget(null),
  });

  /** The open applicant's message trail, and the composer over it. */
  const [messages, setMessages] = useState<CandidateMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesFailed, setMessagesFailed] = useState(false);
  const [messagesTruncated, setMessagesTruncated] = useState(false);
  const [inbound, setInbound] = useState<InboundMessageRow[]>([]);
  const [inboundLoading, setInboundLoading] = useState(false);
  const [inboundFailed, setInboundFailed] = useState(false);
  const [inboundTruncated, setInboundTruncated] = useState(false);
  const [inboundBasis, setInboundBasis] = useState<InboundMatchBasis>("phone");
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
  /**
   * The open applicant's own row, when they are not on the page in front of
   * the reader — a `?applicant=` deep link to page 9, typically.
   *
   * It comes from the drawer's existing detail read, which has always returned
   * it, so this costs no request. See that read for why it is safe.
   */
  const [offPageRow, setOffPageRow] = useState<CompanyApplicantRow | null>(null);
  /**
   * The screening answers, from the same read as scoreDetail and carrying the
   * id they belong to. See screening-state.ts for why the id travels with them.
   */
  const [screeningState, setScreeningState] = useState<ScreeningState>(null);
  /** The unscored card's facts, from the same read as scoreDetail. */
  const [scoring, setScoring] = useState<ApplicantScoringFacts | null>(null);
  /** The team's thread, loaded with the rest of the detail. */
  const [comments, setComments] = useState<ApplicantComment[]>([]);
  const [scoreSaving, setScoreSaving] = useState(false);
  /** The export's screening read is in flight — the button says so and blocks. */
  const [exporting, setExporting] = useState(false);
  /** Same optimistic-override trick as stageOverrides, for the list's ring. */
  const [scoreOverrides, setScoreOverrides] = useState<Record<string, ApplicantScore>>({});

  /*
   * The page's rows with the optimistic overlays applied.
   *
   * The overlays are unchanged, and they still key by id — but they now only
   * ever find rows on the page in front of the reader, which is all they were
   * ever used for. An override for a row that has since paged away simply
   * matches nothing, and is dropped with the rest when the read it anticipated
   * lands.
   */
  const rows = useMemo(
    () =>
      pageView.rows.map((r) => {
        const stage =
          stageOverrides[r.id] && stageOverrides[r.id] !== r.pipeline_stage
            ? stageOverrides[r.id]
            : r.pipeline_stage;
        const score = scoreOverrides[r.id] ?? r.score;
        if (stage === r.pipeline_stage && score === r.score) return r;
        return { ...r, pipeline_stage: stage, score };
      }),
    [pageView.rows, stageOverrides, scoreOverrides],
  );

  /*
   * ── What the filtering used to be ───────────────────────────
   *
   * `matching`, `byScore` and `filtered` lived here: three passes over the
   * whole population to apply the tabs, the job filter, the flag chip and the
   * search, then to sort twice. They are gone, and so is the reason they were
   * sound — they were computed over every applicant, and `rows` is now twenty.
   *
   * Re-deriving any of them from `rows` would be the defect this pass exists
   * to remove: a filter applied to one page answers about that page while the
   * label above it claims to answer about the role. Every one of them is now a
   * clause in the query, and `pageView` is the answer.
   */

  /**
   * The roles the job filter offers, from the company's own jobs.
   *
   * Was the distinct jobs present in the loaded rows, which was free and
   * correct only while "the loaded rows" meant everybody. Against a page it
   * would offer whichever handful of roles happened to land on it, and
   * selecting a role would then remove it from its own dropdown.
   */
  const jobOptions = useMemo<[string, string][]>(
    () => assignableJobs.map((j) => [j.id, j.title]),
    [assignableJobs],
  );

  /**
   * The ten best scored, with the optimistic overlays applied to them too.
   *
   * Still a claim about the whole filtered population rather than the page —
   * it just comes from a query that says so now, instead of from a sort over
   * everybody in memory. The overlay matters here because a rescore from the
   * drawer should change the chip, and the chip's row may not be on the page.
   */
  const topRows = useMemo(
    () =>
      (topScored ?? []).map((r) => {
        const score = scoreOverrides[r.id] ?? r.score;
        return score === r.score ? r : { ...r, score };
      }),
    [topScored, scoreOverrides],
  );

  /**
   * The ids wearing a "Top match" chip: scored >= 90, best first, capped.
   *
   * The cap USED to be its own constant and is now structural — the read
   * returns ten, so the chips cannot exceed ten. The score floor is still a
   * floor: ranking in the top ten of a weak field earns no chip, which is why
   * this filters rather than just taking the ids it was handed.
   */
  const topMatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of topRows) {
      if (r.score.status === "scored" && (r.score.overall ?? 0) >= TOP_MATCH_MIN_SCORE) {
        ids.add(r.id);
      }
    }
    return ids;
  }, [topRows]);

  /*
   * What the table draws, and the pager's arithmetic.
   *
   * "Review top 10" needs no paging: the read is limited to ten and the page
   * holds twenty, so it is always exactly one page. That was true before as
   * well — TOP_N was below PAGE_SIZE — but it was true by coincidence of two
   * constants rather than because a query said so.
   */
  const paged = topOnly ? topRows : rows;
  const total = topOnly ? topRows.length : pageView.total;
  const pageCount = topOnly ? 1 : (pageView.pageCount ?? 1);
  const safePage = topOnly ? 1 : page;
  const pageStart = topOnly ? (topRows.length === 0 ? 0 : 1) : rangeStart(page, rows.length);

  /*
   * The open applicant: the page, then the top ten, then the drawer's own read.
   *
   * It used to be a lookup in `rows`, which held everybody. `rows` is now
   * twenty people, so the last fallback is what keeps a valid `?applicant=`
   * link working — it resolves whoever the drawer actually fetched, whatever
   * page they are on. `topRows` is checked too, since "Review top 10" is the
   * other set genuinely in memory.
   */
  const openRow = openId
    ? (rows.find((r) => r.id === openId) ??
      topRows.find((r) => r.id === openId) ??
      (offPageRow?.id === openId ? offPageRow : null))
    : null;

  /**
   * The refusal sentence, dated in the reader's timezone off the page clock —
   * which is why it is composed here and not returned ready-made by the action.
   * The date drops out entirely when the timestamp is missing, rather than
   * printing a placeholder for a fact we don't have.
   */
  const duplicateDay = addDuplicate ? fmtDay(addDuplicate.appliedAt, clock.local) : null;
  const duplicateLine = addDuplicate
    ? `${addDuplicate.name} is already on this role${duplicateDay ? `, added ${duplicateDay}` : ""}.`
    : "";

  /**
   * Where the open applicant sits on the page in front of the reader.
   *
   * An offset into `paged`, so -1 means "not on this page" — a `?applicant=`
   * deep link to someone twelve pages away, resolved by the drawer's own read.
   * The control hides itself in that case: there is no sequence to step
   * through, and a dead arrow says less than no arrow.
   */
  const openIndex = openId ? paged.findIndex((r) => r.id === openId) : -1;

  /*
   * ── Stepping across a page boundary ─────────────────────────
   *
   * Prev/next walks the FILTERED POPULATION, not the twenty rows on screen.
   * When the step stays on the page it is the lookup it always was; when it
   * does not, the destination is in a page nobody has read yet, so the step is
   * a page turn plus an offset to open once the rows land.
   *
   * `pendingStep` is that promise, and it is deliberately a piece of state
   * rather than a chained await: the read goes through the same sequence-
   * guarded path as every other, so what resolves the step is a page ARRIVING
   * for the right request, not a particular promise settling. A filter moving
   * mid-flight therefore cannot open a stranger — `stepRow` checks the key the
   * rows were read for, and page 2 of one filter is page 2 of another by
   * number alone.
   */
  const [pendingStep, setPendingStep] = useState<StepTarget | null>(null);

  /**
   * Stepping is unavailable while a step is in flight, and while the rows on
   * screen belong to a different request than the one being displayed.
   *
   * Not politeness — correctness. `openIndex` is an offset into the rows now
   * drawn, and `request.page` is the page being fetched. While those two
   * disagree, combining them addresses a row in the population that nobody
   * asked for: an offset of 19 read against page 2 is index 39, which is two
   * pages from where the reader actually is.
   */
  const stepping = pendingStep !== null;
  const canStep = !stepping && !pageView.updating;

  const stepApplicant = useCallback(
    (delta: number) => {
      if (!canStep) return;
      /*
       * "Review top 10" is one page by construction — the read is limited to
       * ten and a page holds twenty — so its stepping is the page-local lookup
       * and there is no boundary to cross.
       */
      if (topOnly) {
        const next = paged[openIndex + delta];
        if (next) openApplicant(next.id);
        return;
      }
      const target = stepTarget(request, openIndex, delta, pageView.total);
      if (!target) return;
      if (target.request.page === request.page) {
        const next = paged[target.offset];
        if (next) openApplicant(next.id);
        return;
      }
      setPendingStep(target);
      // `replace`: twelve steps must not be twelve history entries, for the
      // same reason the panel's own URL is a replace.
      setFilters({ page: target.request.page }, "replace");
    },
    [canStep, topOnly, paged, openIndex, request, pageView.total, openApplicant, setFilters],
  );

  /*
   * The pending step, resolved when its page lands.
   *
   * A FAILED read clears it rather than waiting: the page the reader stepped
   * to is not coming, the table says so, and a step left pending would leave
   * both arrows dead until they closed the panel.
   */
  useEffect(() => {
    if (!pendingStep) return;
    if (pageView.failed) {
      setPendingStep(null);
      return;
    }
    const landed = stepRow(pendingStep, {
      key: list.shownKey,
      updating: pageView.updating,
      rows: paged,
    });
    if (!landed) return;
    setPendingStep(null);
    openApplicant(landed.id);
  }, [pendingStep, list.shownKey, pageView.updating, pageView.failed, paged, openApplicant]);

  /**
   * "21 of 128" — the position in the filtered population, not on the page.
   *
   * While a cross-page step is in flight the DESTINATION is reported, which is
   * the only correct answer available: the rows on screen are still the page
   * being left, so `openIndex` describes the old page while `request.page` is
   * already the new one, and combining them would read twenty out.
   *
   * Null when the population size is unknown or the open applicant is not on
   * the page — the two cases where no position can be stated honestly.
   */
  const stepPosition = ((): { index: number; total: number } | null => {
    if (total === null) return null;
    if (pendingStep) {
      return { index: populationIndex(pendingStep.request.page, pendingStep.offset), total };
    }
    if (openIndex < 0) return null;
    return { index: populationIndex(safePage, openIndex), total };
  })();

  /**
   * A deep link whose candidate really isn't there.
   *
   * The test used to be "absent from `rows`", and `rows` used to be everyone.
   * It is now twenty people, so that test would fire this toast at a recruiter
   * following a perfectly good link to someone on page 9 — telling them a
   * candidate they can see in their inbox "may have been deleted". The read
   * above decides instead, and it only reports a NULL answer: no such
   * applicant, or not this reader's.
   *
   * Deletion is the likely cause and the one applicant_deleted anticipates,
   * but a scoped member opening a colleague's link gets the same null. The
   * wording covers both rather than asserting a deletion that may not have
   * happened.
   *
   * Reported once per id, because the drawer's read re-runs on reopen.
   */
  const [deadLink, setDeadLink] = useState<string | null>(null);
  const deadLinkReportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!deadLink || deadLinkReportedFor.current === deadLink) return;
    deadLinkReportedFor.current = deadLink;
    setOpenId((current) => (current === deadLink ? null : current));
    setToast("That applicant isn't in your list - they may have been deleted.");
  }, [deadLink, setToast]);

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
      result = { success: false, error: "Couldn't delete - please try again." };
    }
    setDeleting(false);

    if (!result.success) {
      setToast({ message: result.error, tone: "error" });
      return;
    }

    // The row leaves the page at once, and the total comes down with it so the
    // pager and "of 143" do not keep counting someone who is gone. The refetch
    // below is what backfills the twentieth row; see dropRow.
    setList((prev) => dropRow(prev, target.id));
    setDeleteTarget(null);
    // Not setOpenId(null): the id has to leave the URL too, or the dead-link
    // guard below reports the applicant we just deleted as a broken link.
    closePanel();
    setToast(`${fullName(target)} deleted`);
    // The population changed, and neither the rows nor the counts are props
    // any more, so both have to be re-asked explicitly.
    refreshCounts(jobFilter === "all" ? null : jobFilter);
    refreshList(request);
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
      setScreeningState(null);
      setComments([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryFailed(false);
    setHistory([]);
    setScreeningState(null);
    setComments([]);
    fetchCompanyApplicant(openId)
      .then((read) => {
        if (cancelled) return;
        // A failed read must not blank the trail. An applicant with a week of
        // activity would render as one who has done nothing, and the drawer
        // gives no hint that anything went wrong.
        if (!read.ok) {
          setHistoryFailed(true);
          // Keyed to openId, so this failure can only ever render under the
          // applicant it was read for.
          setScreeningState({ id: openId, answers: null });
          return;
        }
        /*
         * The row itself, which this read has always returned and the client
         * has always discarded — it had no use for it while `rows` held every
         * applicant.
         *
         * It is the off-page deep link's answer. `?applicant=` from a
         * notification email names someone who may be on page 9, and keeping
         * this is the difference between opening their drawer and telling
         * their recruiter they "may have been deleted". The action already
         * scopes it on company_id_snapshot AND canAccessJob, answering null
         * for an applicant who is not the reader's, so holding the row grants
         * no access the drawer did not already have.
         */
        setOffPageRow(read.value?.applicant ?? null);
        /*
         * A null answer is the only honest basis for the dead-link toast: the
         * applicant does not exist, or is not this reader's. Absence from the
         * current page is not evidence of either, and that is what the guard
         * used to test.
         */
        if (!read.value) setDeadLink(openId);
        setHistory(read.value?.history ?? []);
        setScoreDetail(read.value?.scoreDetail ?? null);
        // No detail row is not an empty answer set — it is an answer set we
        // did not get, so it stays a failure rather than becoming "No
        // screening questions" under the candidate's name.
        setScreeningState({
          id: openId,
          answers: read.value ? read.value.screening_answers : null,
        });
        setScoring(read.value?.scoring ?? null);
        setComments(read.value?.comments ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setHistory([]);
        setScoreDetail(null);
        setScreeningState({ id: openId, answers: null });
        setScoring(null);
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
      setMessagesFailed(false);
      setMessagesTruncated(false);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesFailed(false);
    setMessagesTruncated(false);
    setMessages([]);
    fetchApplicationMessages(openId)
      .then((read) => {
        if (cancelled) return;
        setMessages(read.rows);
        setMessagesFailed(!read.ok);
        setMessagesTruncated(read.truncated);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setMessagesFailed(true);
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  // Inbound WhatsApp is its own read, deliberately: it matches on the phone
  // rather than on application_id, it can fail on its own, and a candidate
  // whose number we cannot normalise has no inbound trail to read at all.
  // Folding it into the outbound query would make all three of those
  // indistinguishable from "nobody has written to this person".
  useEffect(() => {
    if (!openId) {
      setInbound([]);
      setInboundFailed(false);
      setInboundTruncated(false);
      setInboundBasis("phone");
      return;
    }
    let cancelled = false;
    setInboundLoading(true);
    setInboundFailed(false);
    setInboundTruncated(false);
    setInbound([]);
    fetchApplicationInbound(openId)
      .then((read) => {
        if (cancelled) return;
        setInbound(read.rows);
        setInboundFailed(!read.ok);
        setInboundTruncated(read.truncated);
        setInboundBasis(read.basis);
      })
      .catch(() => {
        if (cancelled) return;
        setInbound([]);
        setInboundFailed(true);
      })
      .finally(() => {
        if (!cancelled) setInboundLoading(false);
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
      result = { success: false, error: "Couldn't save - please try again." };
    }

    setSavingId(null);

    if (!result.success) {
      setStageOverrides((prev) => ({ ...prev, [id]: previous }));
      setToast({ message: result.error, tone: "error" });
      return;
    }

    setToast(`Moved to ${PIPELINE_STAGE_LABELS[next]}`);

    /*
     * The funnel and the stage tabs are server counts now, so a move has to be
     * re-read rather than recomputed from `stageOverrides`. The optimistic
     * paint still moves the ROW immediately; the figures lag by one round trip
     * and say so while they do. That is the honest trade: an optimistic
     * decrement here would be arithmetic on a number this page did not
     * compute, and it would drift the moment two reviewers moved people at
     * once.
     */
    refreshCounts(jobFilter === "all" ? null : jobFilter);
    /*
     * And the page itself, because a stage move can change who belongs on it:
     * under a stage tab the row leaves, and under Best Match the ordering is
     * untouched but the twentieth row is not. The optimistic override keeps the
     * pill correct in the meantime.
     */
    refreshList(request);

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
      result = { success: false, error: "Couldn't save - please try again." };
    }
    setScoreSaving(false);

    if (!result.success) {
      setScoreDetail(beforeDetail);
      setScoreOverrides((prev) => ({ ...prev, [id]: beforeScore }));
      setToast({ message: result.error, tone: "error" });
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
      result = { success: false, error: "Couldn't save - please try again." };
    }
    setScoreSaving(false);

    if (!result.success) {
      setScoreDetail(beforeDetail);
      setScoreOverrides((prev) => ({ ...prev, [id]: beforeScore }));
      setToast({ message: result.error, tone: "error" });
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
      result = { success: false, error: "Couldn't queue a re-score - please try again." };
    }
    setRescoringId(null);
    if (!result.success) {
      setToast({ message: result.error, tone: "error" });
      return;
    }
    setToast(
      result.data.outcome === "already_queued"
        ? "Scoring is already queued for this applicant - the card appears here shortly."
        : "Re-score queued - the new card appears here shortly.",
    );
    // The card now has a live job to report. Pull the facts so it says
    // "in progress" rather than keeping the old skip on screen.
    const read = await fetchCompanyApplicant(id);
    if (read.ok && openIdRef.current === id) setScoring(read.value?.scoring ?? null);
  }

  /**
   * F4: replace an unreadable or missing CV.
   *
   * attachApplicationCv re-gates, uploads to a fresh key, extracts, updates the
   * row and enqueues scoring. What comes back decides the toast: the new text's
   * length against the scorer's floor is reported at once, so a second scan
   * does not have to go round the queue to be told it is a scan. The detail is
   * re-read so the card reflects the new CV and the queued job; the list is
   * refreshed for has_cv.
   */
  const [attachingId, setAttachingId] = useState<string | null>(null);

  async function handleAttachCv(id: string, file: File) {
    if (attachingId) return;
    setAttachingId(id);
    const form = new FormData();
    form.append("cv", file);
    let result: Awaited<ReturnType<typeof attachApplicationCv>>;
    try {
      result = await attachApplicationCv(id, form);
    } catch {
      result = { success: false, error: "Couldn't upload that CV - please try again." };
    }
    setAttachingId(null);
    if (!result.success) {
      setToast({ message: result.error, tone: "error" });
      return;
    }
    const { cvReadable, cvTextChars, minCvTextChars, scoreQueued } = result.data;
    if (!cvReadable) {
      setToast(
        `CV replaced, but only ${cvTextChars} characters of text could be read - the scorer needs ${minCvTextChars}. Try a PDF exported from a document rather than a scan.`,
      );
    } else if (scoreQueued) {
      setToast("CV replaced - scoring queued, the card appears here shortly.");
    } else {
      setToast("CV replaced, but scoring couldn't be queued. Use Re-score to try again.");
    }
    const read = await fetchCompanyApplicant(id);
    if (read.ok && openIdRef.current === id) {
      setScoreDetail(read.value?.scoreDetail ?? null);
      setScoring(read.value?.scoring ?? null);
    }
    // The row's score status moved with the CV, and the row is not a prop.
    refreshList(request);
    router.refresh();
  }

  /**
   * CSV of the CURRENT PAGE, not the whole result set.
   *
   * Page-wise because the button sits beside a paginated list and "Export"
   * silently emitting 2,000 rows when 20 are on screen is a surprise. The
   * label says so explicitly.
   *
   * Columns deliberately include the AI score, confidence and the screening
   * result — the three things a recruiter actually sorts on. `cv_path` and
   * signed URLs are NEVER included: the path is a capability that would bypass
   * the ownership gate and the signed_url_logs audit, so CVs stay reachable
   * only through the audited route.
   *
   * Async because the screening column is no longer in the list payload — it
   * is read for this page only, under the same company and job scope as the
   * list. The read is allowed to fail; the EXPORT is not allowed to proceed
   * when it does. A file with blank screening cells is indistinguishable from
   * a file reporting that nobody answered anything, and a recruiter filtering
   * that spreadsheet would act on it. So on any failure, or any missing
   * applicant in the response, this returns before a Blob exists.
   *
   * Everything that can be formatted wrongly — escaping, column order, the
   * threshold arithmetic, the completeness check — is in csv-export.ts, where
   * a test can execute it.
   */
  async function exportCsv() {
    if (paged.length === 0 || exporting) return;

    setExporting(true);
    let read: Awaited<ReturnType<typeof fetchScreeningAnswers>>;
    try {
      read = await fetchScreeningAnswers(paged.map((r) => r.id));
    } catch {
      read = { ok: false };
    }
    setExporting(false);

    if (!read.ok) {
      setToast({
        message:
          "Couldn't read the screening answers, so no file was written. The list is unaffected - try the export again.",
        tone: "error",
      });
      return;
    }

    const applicants: CsvApplicant[] = paged.map((r) => ({
      id: r.id,
      name: fullName(r),
      email: r.email,
      job_title: r.job_title,
      stage: stageOf(r),
      score: r.score,
      created_at: r.created_at,
    }));

    const built = buildApplicantsCsv(applicants, read.value);
    if (!built.ok) {
      console.error(
        `[applicants] export refused, screening answers missing for ${built.missing.length} of ${applicants.length}`,
      );
      setToast({
        message:
          "Couldn't read every applicant's screening answers, so no file was written. The list is unaffected - try the export again.",
        tone: "error",
      });
      return;
    }

    const blob = new Blob([built.csv], { type: "text/csv;charset=utf-8;" });
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
    /*
     * `pageView.failed`, not a `loadFailed` prop.
     *
     * The prop said only whether the SERVER pass failed, which was the whole
     * story while the rows were a prop. Every filter move is now its own read
     * that can fail on its own, and `seedList` already folds the server pass's
     * verdict into this same field — so one field covers both and there is no
     * second source of truth to drift.
     */
    if (pageView.failed) {
      return {
        title: "We couldn't run that search",
        text: "A different spelling won't help - this is on our side, not your query. Reload the page to try again.",
      };
    }
    /*
     * The term IN THE URL, because this copy describes the rows on screen and
     * the URL is what the rows answer. Reading the live box would flip to
     * "Nothing in this view" the instant a reader cleared it, while the table
     * still held the search's own results. Already trimmed by the codec.
     */
    if (urlSearch) {
      return {
        title: `No applicants match “${urlSearch}”`,
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
    /*
     * A claim about the WORKSPACE, so it is read off the workspace count.
     *
     * This used to be `applicants.length === 0`, which was sound while that
     * array was the whole population and is a lie now that it is one page: a
     * reviewer sitting on an empty Offer tab would be told their company has
     * no applicants while a hundred sit one tab away.
     *
     * `=== 0` rather than a falsy check, so an UNREADABLE count (null) falls
     * through to the neutral copy below. "No applicants yet" over a failed
     * head-count is the same lie arrived at a different way, and a reader has
     * no way to tell — there is no em dash to put in a sentence.
     */
    if (view.grandTotal === 0) {
      return {
        title: "No applicants yet",
        text: "When someone applies to one of your published roles, they'll appear here - scored and ranked by your AI recruiter.",
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
          why a wide panel beats a modal.

          The inert half comes from useModalFocus, which inerts everything
          outside the panel — this div included. Do NOT set `inert` here too.
          The hook records the attribute each element had and restores it on
          close, so an `inert` React put here is written back after React has
          removed it, and the list stays unclickable until a reload. */}
      <div
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
              {/* Present tense: CV scoring is shipped and on by default per job,
                  and the default sort is by score. The old future tense contradicted
                  the welcome modal one screen earlier. */}
              {ledeCount(view.total)}
              Each new application is <LimeHighlight>scored against the job</LimeHighlight>, unless
              you&apos;ve switched scoring off for that role.
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-[9px]">
            <button
              type="button"
              onClick={exportCsv}
              disabled={paged.length === 0 || exporting}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-[var(--ai-line-strong)] disabled:hover:bg-[var(--ai-surface)] disabled:hover:text-[var(--ai-t2)]"
            >
              <Download className="size-[15px]" strokeWidth={1.9} />
              {exporting ? "Exporting…" : "Export page"}
            </button>
            {/* A view MODE, not a filter: it narrows whatever the tabs, job
                filter and search already selected, so the two compose. Active
                state is unmistakable — the button inverts to purple, says "Show
                all", and a banner above the list states what is being shown. */}
            <button
              type="button"
              onClick={() => {
                /*
                 * Three outcomes, not two. `topScored` is null when the read
                 * has not landed or failed, and an empty array when nobody
                 * qualified — the old code could not tell them apart because
                 * the top ten were a slice of an array that was always there.
                 * Entering the mode on an unread set would show an empty
                 * table, so the honest refusal says the read is the problem.
                 */
                if (!topOnly && topScored === null) {
                  setToast("We couldn't read the top-scored applicants - reload to try again.");
                  return;
                }
                if (!topOnly && topRows.length === 0) {
                  setToast("No applicants have been scored yet");
                  return;
                }
                setFilters({ topOnly: !topOnly });
              }}
              aria-pressed={topOnly}
              className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-[17px] py-[11px] text-[13.5px] font-semibold transition-all ${
                topOnly
                  ? "border border-remotiv-purple bg-remotiv-purple text-white shadow-[0_10px_26px_rgba(126,71,255,0.34)]"
                  : "border border-[var(--ai-sidebar)] bg-[var(--ai-sidebar)] text-white hover:border-remotiv-purple hover:bg-remotiv-purple hover:shadow-[0_10px_26px_rgba(126,71,255,0.34)]"
              }`}
            >
              <Zap className="size-[15px]" strokeWidth={1.9} />
              {topOnly ? "Show all" : `Review top ${TOP_SCORED_LIMIT}`}
            </button>
          </div>
        </div>

        {quotaBanner}

        {/* Dark hero strip. Every figure in it is a server count, so every one
            can be unknown — `countLabel` draws an em dash rather than a 0, and
            `aria-busy` plus the subline say when the figures are being
            refreshed instead of letting the previous filter's stand as this
            one's. */}
        <DashboardHero
          eyebrow="Total applicants"
          value={countLabel(view.total)}
          delta={
            view.newThisWeek !== null && view.newThisWeek > 0 ? (
              <HeroDelta>+{view.newThisWeek} this week</HeroDelta>
            ) : null
          }
          subline={
            view.updating
              ? "Updating totals…"
              : `Across ${countLabel(view.openRoles)} open ${view.openRoles === 1 ? "role" : "roles"}`
          }
        >
          <div
            aria-busy={view.updating}
            className={`flex flex-wrap items-stretch transition-opacity min-[840px]:flex-nowrap ${
              view.updating ? "opacity-50" : ""
            }`}
          >
            {FUNNEL_STEPS.map((step, i) => {
              const value = view.stages[step.stage];
              const pct = stagePercent(value, view.total);
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
                    {countLabel(value)}
                  </div>
                  <div className="h-1 overflow-hidden rounded-[3px] bg-white/10">
                    <i
                      className="block h-full origin-left rounded-[3px]"
                      style={{ background: step.bar, width: `${pct ?? 0}%` }}
                    />
                  </div>
                  {/* An unknown share is a dash, not 0%. A 0%-wide bar is
                      indistinguishable from an empty stage, so the number
                      beside it is what has to carry the distinction. */}
                  <p className="m-0 mt-2 text-[11px] text-white/[0.38]">
                    {pct === null ? "- of total" : `${pct}% of total`}
                  </p>
                </div>
              );
            })}
          </div>
        </DashboardHero>

        {/* Panel */}
        <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
            <StageTabs
              tab={tab}
              total={view.total}
              stageCounts={view.stages}
              updating={view.updating}
              flaggedOnly={flaggedOnly}
              flaggedCount={flaggedCount}
              onSelectStage={(stage) => setFilters({ stage })}
              onToggleFlagged={() => setFilters({ flaggedOnly: !flaggedOnly })}
            />

            {/* Full-width on phones so the selects + search stack under the tabs
                instead of forcing the toolbar wider than the viewport.
                `flex-wrap` because this cluster holds three controls now. The
                search box needs a min-width to make that wrap happen: with
                `min-w-0` it was squeezed to 68px between the two selects at a
                360px viewport while Add candidate sat orphaned on a row of its
                own. The floor pushes both onto that row together. */}
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
                onChange={(e) => setFilters({ sort: e.target.value as ApplicantSort })}
                aria-label="Sort applicants"
                className={`${TOOLBAR_SELECT} shrink-0`}
              >
                <option value="best">Best match</option>
                <option value="newest">Newest first</option>
              </select>

              <select
                value={jobFilter}
                onChange={(e) =>
                  setFilters({ jobId: e.target.value === "all" ? null : e.target.value })
                }
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

              <div className="flex min-w-[160px] flex-1 items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple min-[630px]:w-[210px] min-[630px]:flex-none">
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

              {/* In the header, not the empty state: the commonest time to add
                  someone by hand is onto a list that already has people on it.
                  Last in the cluster because it is the only control here that
                  writes — everything to its left only reshapes the view.

                  Dead rather than hidden when there are no jobs, with the
                  reason in the tooltip. A missing button reads as a missing
                  feature; a disabled one that explains itself points at the
                  fix, which is to post a role first. */}
              {canAddApplicant && (
                <button
                  type="button"
                  disabled={assignableJobs.length === 0}
                  onClick={() => {
                    setAddError(null);
                    setAddDuplicate(null);
                    setAddOpen(true);
                  }}
                  title={
                    assignableJobs.length === 0
                      ? "Create a job first - a candidate has to be added to a role."
                      : "Add a candidate whose CV reached you outside the job board."
                  }
                  className="flex shrink-0 items-center gap-[7px] rounded-[10px] bg-remotiv-purple px-[13px] py-[8px] text-[13px] font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Plus className="size-[15px]" strokeWidth={2.4} />
                  Add candidate
                </button>
              )}
            </div>
          </div>

          {paged.length === 0 && (
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
                {/* The denominator is the FILTERED population, which is a
                    server count and so can be unknown — and there is no em
                    dash available mid-sentence. So an unreadable total drops
                    the "of N" clause rather than inventing one; the top ten
                    themselves are still a fact worth stating. */}
                Showing the top {topRows.length} scored applicant
                {topRows.length === 1 ? "" : "s"}
                {pageView.total === null ? "." : ` of ${pageView.total}.`}
              </p>
              <button
                type="button"
                onClick={() => setFilters({ topOnly: false })}
                className="text-[12.5px] font-bold text-remotiv-purple underline-offset-2 hover:underline"
              >
                Show all applicants
              </button>
            </div>
          )}

          {/*
            The rows answer a request the reader may have moved off.
            ──────────────────────────────────────────────────────

            `updating` is not decoration. The rows used to be a pure function
            of state and so could be neither stale nor absent; they are a
            RESPONSE now, and the gap between picking a filter and its page
            arriving is one the reader will otherwise fill by clicking a row
            that belongs to the previous question.

            They are deliberately kept on screen rather than cleared — a table
            that collapses to empty on every keystroke is worse — so the dim
            plus `aria-busy` is the whole of what distinguishes "these are
            yours" from "these were yours a moment ago".

            `topOnly` is excluded: that mode reads from `topScored`, which this
            flag says nothing about.
          */}
          <div
            aria-busy={!topOnly && pageView.updating}
            className={`transition-opacity ${!topOnly && pageView.updating ? "opacity-50" : ""}`}
          >
            {paged.length > 0 && (
              <div data-twin-narrow className="min-[1049px]:hidden">
                {paged.map((r, i) => (
                  <ApplicantCard
                    key={r.id}
                    row={r}
                    rank={pageStart + i}
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
                  const pill = stagePill(stage);
                  const isTop = topMatchIds.has(r.id);
                  const rank = pageStart + i;

                  return (
                    <button
                      key={r.id}
                      type="button"
                      data-applicant-id={r.id}
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
                        {/* `rank` is already 1-based — `rangeStart` is, because
                          the pager's "21–40" reads off the same number. */}
                        {String(rank).padStart(2, "0")}
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

                      {/* min-w-0 on the flex parent and truncate on the title, so
                        a long role name shortens rather than pushing the chip
                        out of the cell. The chip never shrinks — it is two
                        words or it is wrong. */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate rounded-lg border border-[var(--ai-line-soft)] bg-[var(--ai-inset)] px-2.5 py-[5px] text-[12.5px] font-semibold text-[var(--ai-t2)]">
                          {r.job_title}
                        </span>
                        {r.added_manually && <AddedByTeamChip />}
                      </div>

                      <ScoreRing score={r.score} />

                      <span
                        className={`inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${pill.cls}`}
                      >
                        <span className={`size-[5px] shrink-0 rounded-full ${pill.dot}`} />
                        {pipelineStageLabel(stage)}
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
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
            <p className="m-0 text-[12.5px] text-[var(--ai-t3)]">
              {sort === "best"
                ? "Ranked by AI score. Anything without a score sits at the end."
                : "Newest first. Scores don't affect this order."}
            </p>
            <Pagination
              page={safePage}
              pageCount={pageCount}
              total={total}
              grandTotal={view.grandTotal}
              /* `pageStart` is already the 1-based index of the page's first
                 row — `rangeStart` computes it from the page number, where the
                 old local was a 0-based offset into an in-memory array and
                 needed the +1 here. */
              rangeStart={pageStart}
              rangeEnd={pageStart === 0 ? 0 : pageStart + paged.length - 1}
              onPage={(n) => setFilters({ page: n })}
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
          screeningState={screeningState}
          showScoringTip={showScoringTip}
          clock={clock}
          history={history}
          scoreDetail={scoreDetail}
          historyLoading={historyLoading}
          historyFailed={historyFailed}
          messages={messages}
          messagesLoading={messagesLoading}
          messagesFailed={messagesFailed}
          messagesTruncated={messagesTruncated}
          inbound={inbound}
          inboundLoading={inboundLoading}
          inboundFailed={inboundFailed}
          inboundTruncated={inboundTruncated}
          inboundBasis={inboundBasis}
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
          scoring={scoring}
          attaching={attachingId === openRow.id}
          onAttachCv={(file) => {
            void handleAttachCv(openRow.id, file);
          }}
          tab={panelTab}
          onTabChange={selectPanelTab}
          position={stepPosition}
          onStep={stepApplicant}
          stepBusy={!canStep}
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
              jobTitle: openRow.job_title ?? "-",
            },
          ]}
          templates={manualTemplates}
          presetApplicationId={openRow.id}
          onSent={async () => {
            setToast("Email sent");
            setMessagesLoading(true);
            try {
              const read = await fetchApplicationMessages(openRow.id);
              setMessages(read.rows);
              setMessagesFailed(!read.ok);
              setMessagesTruncated(read.truncated);
            } catch {
              /* the send succeeded; a stale trail is not worth an error */
            } finally {
              setMessagesLoading(false);
            }
          }}
        />
      )}

      {addOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
          <div
            ref={addDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-applicant-title"
            className="max-h-full w-full max-w-md overflow-y-auto rounded-[20px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)] outline-none"
          >
            {/* Uncontrolled on purpose. Five fields that are read once, on
                submit, and never compared against each other — five useStates
                would be five rerenders per keystroke to hold what the DOM
                already holds. `required` and `type=email` do the first pass;
                the action re-validates everything regardless. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitAdd(new FormData(e.currentTarget));
              }}
            >
              <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
                <div>
                  <h3
                    id="add-applicant-title"
                    className="font-heading text-lg font-bold text-[var(--ai-t1)]"
                  >
                    Add a candidate
                  </h3>
                  {/* Says what this does to the candidate, because nothing
                      else will: they are not told they were added. */}
                  <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
                    For a CV that reached you outside the job board. They're filed at Applied and
                    scored like any other application - and they aren't emailed.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  aria-label="Close"
                  className="-mr-1 shrink-0 rounded-lg p-1 text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
                >
                  <X className="size-[18px]" strokeWidth={2} />
                </button>
              </div>

              <div className="flex flex-col gap-3.5 px-6">
                <div className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <label className={ADD_LABEL} htmlFor="add-first-name">
                      First name
                    </label>
                    <input
                      id="add-first-name"
                      name="first_name"
                      required
                      maxLength={100}
                      autoComplete="off"
                      className={ADD_FIELD}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <label className={ADD_LABEL} htmlFor="add-last-name">
                      Last name
                    </label>
                    <input
                      id="add-last-name"
                      name="last_name"
                      required
                      maxLength={100}
                      autoComplete="off"
                      className={ADD_FIELD}
                    />
                  </div>
                </div>

                <div>
                  <label className={ADD_LABEL} htmlFor="add-email">
                    Email
                  </label>
                  <input
                    id="add-email"
                    name="email"
                    type="email"
                    required
                    autoComplete="off"
                    className={ADD_FIELD}
                  />
                </div>

                <div>
                  <label className={ADD_LABEL} htmlFor="add-job">
                    Role
                  </label>
                  {/* No "All jobs"-style blank option: the row cannot exist
                      without a job, and an empty default would be a choice the
                      form has to reject a second later. */}
                  <select
                    id="add-job"
                    name="job_id"
                    required
                    className={`${ADD_FIELD} cursor-pointer appearance-none`}
                  >
                    {assignableJobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={ADD_LABEL} htmlFor="add-cv">
                    CV
                  </label>
                  <input
                    id="add-cv"
                    name="cv"
                    type="file"
                    accept="application/pdf"
                    required
                    className={`${ADD_FIELD} file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-[var(--ai-inset)] file:px-2.5 file:py-1 file:text-[12px] file:font-bold file:text-[var(--ai-t2)]`}
                  />
                  <p className="m-0 mt-1.5 text-[11.5px] text-[var(--ai-t4)]">
                    PDF, up to 5 MB. Everything else - phone, location, history - is read from it.
                  </p>
                </div>

                {addError && (
                  <p className="m-0 rounded-[10px] bg-[var(--ai-danger-tint)] px-3 py-2.5 text-[12.5px] font-semibold text-[var(--ai-danger)]">
                    {addError}
                  </p>
                )}

                {/* Not styled as an error, because it isn't one — the person
                    the recruiter wants is already here. So it names them, says
                    when, and offers the action that actually finishes the job:
                    open them and use Add CV. */}
                {addDuplicate && (
                  <div className="rounded-[13px] border border-[var(--ai-amber-dot)] bg-[var(--ai-amber-tint)] px-3.5 py-3">
                    <p className="m-0 flex items-start gap-2 text-[12.5px] font-semibold leading-relaxed text-[var(--ai-amber-ink)]">
                      <AlertTriangle className="mt-px size-[15px] shrink-0" strokeWidth={2.2} />
                      <span>{duplicateLine}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        // Clearing the stage tab first, because prev/next walks
                        // the filtered population: landing in a pane that does
                        // not list this person makes those arrows jump
                        // somewhere unrelated. Both writes land, in order,
                        // because each reads `window.location.search` rather
                        // than a render-time snapshot of it.
                        setFilters({ stage: null });
                        openApplicant(addDuplicate.applicationId);
                        setAddOpen(false);
                      }}
                      className="mt-2 text-[12.5px] font-bold text-[var(--ai-amber-ink)] underline underline-offset-2 hover:opacity-80"
                    >
                      Open their profile to attach this CV
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-5 flex gap-3 border-t border-[var(--ai-line)] px-6 py-4">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  disabled={addBusy}
                  className="flex-1 rounded-xl border border-[var(--ai-line)] py-2.5 text-sm font-medium text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addBusy}
                  aria-busy={addBusy}
                  className="flex-1 rounded-xl bg-remotiv-purple py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {addBusy ? "Adding…" : "Add candidate"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
          <div
            ref={deleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-applicant"
            className="w-full max-w-sm overflow-hidden rounded-[20px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)] outline-none"
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
                removed, along with their CV file, AI scorecard, pipeline history, and their
                interviews with every recording and transcript. This cannot be undone.
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

      <Toast state={toast} />
    </PageContainer>
  );
}
