"use client";

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Lightbulb,
  MapPin,
  Plus,
  Settings2,
  ShieldCheck,
  Trash,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  AUTOSHORTLIST_DEFAULT_THRESHOLD,
  AUTOSHORTLIST_SOURCE_LABELS,
  type AutoshortlistSource,
  type CompanyJobInput,
  CV_WEIGHT_DEFAULT,
  CV_WEIGHT_DIMENSIONS,
  type CvWeightKey,
  EMPTY_JOB_INPUT,
  INTERVIEW_CRITERIA_MAX,
  JOB_CATEGORIES,
  JOB_CONTRACT_TYPES,
  JOB_CURRENCIES,
  JOB_EXPERIENCE_LEVELS,
  JOB_INTERVIEWER_NAME_MAX,
  JOB_TEXT_COUNTER_FROM,
  JOB_TEXT_MAX,
  JOB_WORK_TYPES,
  type JobCurrency,
  MUST_HAVE_MAX,
  MUST_HAVE_MAX_LENGTH,
  stopForStored,
  suggestCriteria,
  WEIGHT_STOPS,
  weightShares,
  weightsAreEqual,
} from "@/app/ai-dashboard/lib/job-types";
import {
  ANSWER_SECONDS_MAX,
  ANSWER_SECONDS_MIN,
  EMPTY_QUESTION_INPUT,
  type InterviewQuestionInput,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  PREP_SECONDS_MAX,
  PREP_SECONDS_MIN,
  QUESTION_TEXT_MAX,
} from "@/lib/interviews/types";
import type { ScreeningQuestion } from "@/lib/jobs";
// Value import MUST come from lib/screening, not lib/jobs: this is a client
// component and lib/jobs pulls in next/headers via getInitialJobs.
import { type NumericMode, resolveNumericMode } from "@/lib/screening";
import { HiringTeamSection } from "../_hiring-team";
import { createCompanyJob, estimateAutoshortlistReach, updateCompanyJob } from "../actions";

// ── Constants ────────────────────────────────────────────────

const STEPS = [
  { n: 1, label: "Basics", title: "Basics", desc: "This is what candidates see first on Remotiv." },
  {
    n: 2,
    label: "Description",
    title: "Description",
    desc: "Tell candidates what the role is and who it's for.",
  },
  {
    n: 3,
    label: "Compensation",
    title: "Compensation",
    desc: "Transparent pay attracts stronger applicants.",
  },
  {
    n: 4,
    label: "Screening",
    title: "Screening",
    desc: "Questions your AI recruiter asks every applicant.",
  },
  {
    n: 5,
    label: "Interview",
    title: "Interview questions",
    desc: "What the candidate answers on camera, in their own time.",
  },
  { n: 6, label: "Review", title: "Review", desc: "One last look before it goes live." },
] as const;

/*
 * Interview questions were step 7 in the locked rail. Unlocking it in place
 * would have left a live step behind a locked one and put Review in the middle
 * of the flow, so it becomes step 5 and Review moves to 6. The three that stay
 * locked keep their order and renumber behind it.
 */
/**
 * Steps 8 and 9, which sit AFTER the locked step 7 in the rail.
 *
 * Separate from STEPS so the rail can render 1–6, then the locked 7, then these
 * — the mock's order. Their panels are numbered 8 and 9 because that is the
 * product's step identity, not their position in the flow.
 */
const LATE_STEPS = [
  {
    n: 7,
    label: "AI scoring",
    title: "AI scoring criteria",
    desc: "Name the things that matter most. The scorer reports on each one.",
  },
  {
    n: 8,
    label: "Answer weighting",
    title: "Answer weighting",
    desc: "Decide what counts most when the AI scores someone.",
  },
  {
    n: 9,
    label: "Auto-shortlist",
    title: "Auto-shortlist",
    desc: "Flag the strongest applicants automatically. You still decide.",
  },
] as const;

/**
 * The order a person moves through. Now 1–9 with nothing skipped.
 *
 * Kept as an explicit list rather than collapsing back to `step + 1`: the
 * sequence and the step number agreeing is a property of today's rail, not a
 * rule, and the last two times a step was unlocked or moved it was this
 * indirection that made it a one-line change. positionOf and stepAt stay, so
 * the footer's "Step N of 9" and the Continue/Back walk keep working whatever
 * order the rail ends up in.
 *
 * Review stays mid-flow at 6 and Publish is on the last position, step 9.
 */
const SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** 1-based position of a step in the working sequence. 0 when not in it. */
function positionOf(step: number): number {
  return SEQUENCE.indexOf(step as (typeof SEQUENCE)[number]) + 1;
}

/** The step the Continue/Back buttons should move to, or null at either end. */
function stepAt(position: number): number | null {
  return SEQUENCE[position - 1] ?? null;
}

/** The step Publish lives on — the last unlocked one. */
const FINAL_STEP = SEQUENCE[SEQUENCE.length - 1];

/** Highest step number in the rail, for the "Step N of 9" badge. */
const HIGHEST_STEP = 9;

/**
 * Competency suggestions for the interview builder.
 *
 * Suggestions, NOT a closed set: the value is stored as plain text on
 * interview_questions.competency exactly as before, and the "Other…" option
 * below reveals a free-text input. A company hiring for something our list has
 * never heard of must not be blocked by it, so nothing validates against this
 * array — it only populates a dropdown.
 *
 * Kept local to the wizard rather than promoted to lib/interviews/types.ts:
 * it is a UI affordance for the person authoring the question, and no server
 * code reads it. If the scorer later needs a canonical vocabulary, that is a
 * different list with different rules and it should not inherit this one by
 * accident.
 */
const COMPETENCY_SUGGESTIONS = [
  "Communication",
  "Problem solving",
  "Technical depth",
  "Domain knowledge",
  "Leadership",
  "Ownership",
  "Collaboration",
  "Customer focus",
  "Adaptability",
  "Handling pressure",
  "Attention to detail",
  "Commercial awareness",
  "Values alignment",
  "Motivation for the role",
] as const;

/** Sentinel for the reveal. Never stored — see the onChange below. */
const COMPETENCY_OTHER = "__other__";

function isSuggestedCompetency(value: string): boolean {
  return (COMPETENCY_SUGGESTIONS as readonly string[]).includes(value);
}

const INPUT_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const INPUT_ERR_CLS = "border-[#E0524B] ring-[3px] ring-[#E0524B]/[0.14] focus:border-[#E0524B]";
const TEXTAREA_CLS = `${INPUT_CLS} min-h-24 resize-y leading-relaxed`;
const LABEL_CLS = "mb-[7px] block text-xs font-semibold text-[var(--ai-t2)]";

/*
 * Step-rail states, transcribed from the designer's v2 `.step` spec. The rail
 * is now a DARK card, so every state is expressed in translucent white rather
 * than the page's ink tokens. Extracted as constants so the four states stay
 * visibly distinct and `done` can never drift into inheriting `active`.
 *
 *   .step        -> STEP_ROW        (+ STEP_ROW_IDLE for the hover-only default)
 *   .step.active -> STEP_ROW_ACTIVE (raised translucent surface + purple numeral)
 *   .step.done   -> STEP_NUM_DONE   (mint circle, KEEPING its number)
 */
const STEP_ROW =
  "mb-0.5 flex w-full items-center gap-[11px] rounded-[11px] border border-transparent px-2.5 py-[9px] text-left transition-colors";
const STEP_ROW_IDLE = "hover:bg-white/[0.06]";
const STEP_ROW_ACTIVE = "border-white/[0.14] bg-white/[0.11]";

const STEP_NUM =
  "flex size-[23px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11.5px] font-bold transition-colors";
const STEP_NUM_IDLE = "border-white/[0.22] text-white/50";
const STEP_NUM_ACTIVE = "border-remotiv-purple bg-remotiv-purple text-white";
const STEP_NUM_DONE = "border-remotiv-green bg-remotiv-green text-[var(--ai-mint-ink)]";

const STEP_LAB = "text-[13px] font-semibold";

/*
 * "More options" honesty markers.
 *
 * The pill states what a toggle DOES today, and it is only worth having while
 * it is kept true. Async video interviews and re-recording are now both read
 * by real code — sending an interview refuses when the first is off, and the
 * candidate's page offers Re-record only when the second is on — so they carry
 * the live pill alongside AI CV scoring and automated rejections.
 *
 * Two remain stored-but-unread: relevancy scoring and the AI avatar. They stay
 * fully editable, because the company IS really saving the setting and a
 * disabled control would be the lie; the pill is what says the setting has no
 * effect yet.
 *
 * The amber label no longer says "When interviews launch" — interviews HAVE
 * launched, which made that wording false for the two rows still wearing it.
 * "Not yet active" pairs with "Active now" and stays true whatever ships next.
 */
const PILL = "shrink-0 rounded-full px-[7px] py-0.5 text-[10.5px] font-bold";
const PILL_SOON = `${PILL} bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]`;
const PILL_LIVE = `${PILL} bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]`;
const SOON_LABEL = "Not yet active";
const LIVE_LABEL = "Active now";

const QUESTION_TYPES: ReadonlyArray<{ value: ScreeningQuestion["type"]; label: string }> = [
  { value: "yesno", label: "Yes / No" },
  { value: "numeric", label: "Numeric" },
  { value: "multiple", label: "Multiple choice" },
];

/*
 * `ideal` means something different per type, and "Ideal answer" said none of
 * it. A numeric question now says which DIRECTION it tests, because a floor is
 * the wrong operator for most of them: "current salary" and "times terminated"
 * want a ceiling, and "years of experience" wants a floor.
 */
const NUMERIC_MODES: ReadonlyArray<{ value: NumericMode; label: string }> = [
  { value: "min", label: "At least (minimum)" },
  { value: "max", label: "At most (maximum)" },
  { value: "none", label: "No threshold — just collect it" },
];

const NUMERIC_MODE_LABEL: Record<NumericMode, string> = {
  min: "Minimum acceptable",
  max: "Maximum acceptable",
  none: "",
};

const NUMERIC_MODE_HINT: Record<NumericMode, string> = {
  min: "Candidates answering below this are flagged. Must be more than 0.",
  max: "Candidates answering above this are flagged. Must be more than 0.",
  none: "The number is shown on the applicant and given to the AI as context. Nobody passes or fails it, and it doesn't affect the screening percentage.",
};

const IDEAL_LABEL: Record<ScreeningQuestion["type"], string> = {
  yesno: "Ideal answer",
  numeric: "Minimum acceptable", // overridden per-mode; see NUMERIC_MODE_LABEL
  multiple: "Answer options (one per line)",
};

const IDEAL_HINT: Record<ScreeningQuestion["type"], string> = {
  yesno: "Candidates answering differently are flagged.",
  numeric: NUMERIC_MODE_HINT.min,
  multiple: "Candidates choosing anything else are flagged.",
};

/** Per-question validation errors share a prefix so they can be cleared as a set. */
const QUESTION_ERR_PREFIX = "question_";

const QUESTION_IDEAL_ERROR: Record<ScreeningQuestion["type"], (n: number) => string> = {
  numeric: (n) =>
    `Question ${n} needs a threshold above 0 — or set it to collect the number without one.`,
  multiple: (n) => `Question ${n} needs its ideal option chosen.`,
  yesno: (n) => `Question ${n} needs an ideal answer chosen.`,
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * The options the SERVER will actually store: it drops blank lines before
 * indexing, so an ideal index picked against the raw textarea rows would point
 * at the wrong option the moment someone leaves a blank line in the middle.
 */
function liveOptions(q: ScreeningQuestion): string[] {
  return q.options.map((o) => o.trim()).filter(Boolean);
}

/** The currently-chosen option's LABEL, or undefined when nothing is chosen. */
function idealOptionLabel(q: ScreeningQuestion): string | undefined {
  const idx = Number.parseInt(q.ideal, 10);
  return Number.isInteger(idx) ? liveOptions(q)[idx] : undefined;
}

/**
 * Is this question ready to publish?
 *
 * A numeric_mode 'none' question is ALWAYS ready — there is no threshold to
 * set, and requiring one is exactly the thing being fixed. Both other modes
 * need a value above 0: a minimum of 0 passes everyone (the answer field can't
 * go below 0), and a maximum of 0 demands exactly 0.
 */
function hasUsableIdeal(q: ScreeningQuestion): boolean {
  if (q.type === "numeric") {
    if (resolveNumericMode(q) === "none") return true;
    const n = Number.parseFloat(q.ideal);
    return Number.isFinite(n) && n > 0;
  }
  if (q.type === "multiple") return idealOptionLabel(q) !== undefined;
  // Yes/No is ALWAYS publishable: it defaults to "Yes", and sanitizeQuestions
  // coerces anything else to "Yes"/"No" server-side, so there is no unset state
  // to gate on. Blocking publish to make a company confirm the obvious answer
  // on every binary question was pure friction.
  return true;
}

/**
 * Review-row label. Numeric questions carry their direction, because "Numeric"
 * alone no longer says what the question DOES — and a company should be able to
 * see at a glance which of their questions actually filter anybody.
 */
function reviewTypeLabel(q: ScreeningQuestion): string {
  const base = QUESTION_TYPES.find((t) => t.value === q.type)?.label ?? q.type;
  if (q.type !== "numeric") return base;
  const mode = resolveNumericMode(q);
  if (mode === "none") return "Numeric · collected only";
  return `Numeric · ${mode === "max" ? "max" : "min"} ${q.ideal || "—"}`;
}

function fmtNumber(value: string): string {
  const n = Number.parseInt(String(value).replace(/[^0-9]/g, ""), 10);
  return Number.isNaN(n) ? "" : n.toLocaleString("en-US");
}

function currencySymbol(currency: string): string {
  return currency === "USD" ? "$" : "PKR";
}

/**
 * Helper line under a long-text field: always states the ceiling, and turns
 * into a live counter once the user gets close to it.
 */
function CharCount({ value, hint }: { value: string; hint?: string }) {
  const near = value.length >= JOB_TEXT_COUNTER_FROM;
  const atLimit = value.length >= JOB_TEXT_MAX;

  return (
    <p className="mt-[7px] flex items-baseline justify-between gap-3 text-xs leading-relaxed text-[var(--ai-t3)]">
      <span>{hint ?? `Max ${JOB_TEXT_MAX.toLocaleString()} characters.`}</span>
      {near ? (
        <span
          className={`shrink-0 font-semibold tabular-nums ${
            atLimit ? "text-[#C4362F]" : "text-[var(--ai-amber-ink)]"
          }`}
        >
          {value.length.toLocaleString()} / {JOB_TEXT_MAX.toLocaleString()}
        </span>
      ) : (
        hint && (
          <span className="shrink-0 text-[var(--ai-t4)]">Max {JOB_TEXT_MAX.toLocaleString()}</span>
        )
      )}
    </p>
  );
}

/** Small explanatory line under a screening-question control. */
function FieldHint({ text }: { text: string }) {
  return <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ai-t3)]">{text}</p>;
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
        on ? "bg-remotiv-green" : "bg-[var(--ai-line-strong)]"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform ${
          on ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

/**
 * One row of the "More options" section: title + honesty pill, a one-line
 * explanation, the shared Toggle, and an optional revealed field underneath
 * (the two interviewer names, which only exist while their toggle is on).
 *
 * The title/pill pair wraps rather than truncating — at 375px the wizard column
 * is ~457 design px wide once .ai-shell's 0.82 zoom is accounted for, and
 * "Measure response relevancy" + the pill do not fit on one line there.
 */
function OptionRow({
  title,
  desc,
  live,
  on,
  onToggle,
  children,
}: {
  title: string;
  desc: string;
  /** true → the mint "Active now" pill; false → the amber "soon" pill. */
  live?: boolean;
  on: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-[13px]">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-semibold text-[var(--ai-t1)]">{title}</span>
            <span className={live ? PILL_LIVE : PILL_SOON}>{live ? LIVE_LABEL : SOON_LABEL}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--ai-t3)]">{desc}</p>
        </div>
        <span className="ml-auto pt-0.5">
          <Toggle on={on} onClick={onToggle} label={title} />
        </span>
      </div>
      {on && children}
    </div>
  );
}

/**
 * The name field revealed by an interview toggle. Rendered only while its
 * toggle is on, and the server writes NULL when it's off — so an abandoned
 * name never lingers in the column waiting to reappear.
 *
 * maxLength only stops typing; buildPatch caps the value again server-side.
 */
function InterviewerNameField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mt-3 border-t border-[var(--ai-line-soft)] pt-3">
      <label className={LABEL_CLS} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={JOB_INTERVIEWER_NAME_MAX}
        className={INPUT_CLS}
      />
      {/* NOT "shown to candidates" — neither name is. Both are saved and read
          back by this form and by nothing else: the invite email, the
          candidate's interview page and the review page all name the company
          and the role instead. Said plainly here because the async toggle
          above it now reads "Active now", and a truthful pill sitting over a
          false hint is worse than neither. */}
      <p className="mt-[7px] text-xs leading-relaxed text-[var(--ai-t3)]">
        Saved with the job. Nothing shows it to candidates yet. Up to {JOB_INTERVIEWER_NAME_MAX}{" "}
        characters.
      </p>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────

/**
 * One wizard, two modes.
 *
 * "create" inserts a new job via createCompanyJob and ends on the success
 * overlay. "edit" prefills from an existing row and saves via
 * updateCompanyJob, returning straight to the jobs list. Every step, the
 * validation rules, the live preview and the locked 6–9 rail are shared —
 * only the copy, the primary action and the post-success path differ.
 */
export function WizardClient({
  companyName,
  mode = "create",
  jobId,
  initialState,
  answeredCounts,
}: {
  companyName: string;
  mode?: "create" | "edit";
  /** Required in edit mode — the row being updated. */
  jobId?: string;
  /** Prefill for edit mode; create starts from EMPTY_JOB_INPUT. */
  initialState?: CompanyJobInput;
  /**
   * question_id → how many applicants already answered it. Edit mode only;
   * a newly created job has none, and a question added in this session cannot
   * have any either.
   */
  answeredCounts?: Record<string, number>;
}) {
  const router = useRouter();
  const isEdit = mode === "edit";

  const [state, setState] = useState<CompanyJobInput>(initialState ?? EMPTY_JOB_INPUT);
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState<{ title: string } | null>(null);

  // Collapsed by default: Review's job is to get to Publish, and five toggles
  // above the publish note would bury it. Every option already has a default.
  const [moreOpen, setMoreOpen] = useState(false);

  /**
   * The answer type each question had WHEN THE PAGE LOADED.
   *
   * Captured once from the prefill, so the type-change warning compares against
   * what applicants actually answered rather than against whatever the select
   * showed a keystroke ago. A ref, not state: it must never be recomputed as
   * the user edits, or changing a type would immediately update the baseline
   * and the warning would vanish the moment it became true.
   */
  /**
   * Whether step 7 has already offered its pre-fill this session.
   *
   * In WizardClient, not in the step: the step unmounts whenever you navigate
   * away, so a ref inside it would reset and re-seed must-haves a recruiter had
   * deliberately cleared. Seeded at most once, ever.
   */
  const mustHavesSeededRef = useRef(false);

  const originalTypesRef = useRef<Record<string, ScreeningQuestion["type"]>>(
    Object.fromEntries((initialState?.screening_questions ?? []).map((q) => [q.id, q.type])),
  );

  /**
   * Non-blocking warning for a question whose type changed after people had
   * already answered it. Null when there is nothing to say.
   *
   * Deliberately advisory: the company owns its job, and the mis-set type this
   * exists to catch is often exactly what they are trying to correct. Blocking
   * would strand them; saying nothing produced a live drawer listing "6 years"
   * and "Yes" under one question, both marked as meeting the threshold.
   */
  function typeChangeWarning(q: ScreeningQuestion): string | null {
    const original = originalTypesRef.current[q.id];
    if (!original || original === q.type) return null;
    const answered = answeredCounts?.[q.id] ?? 0;
    if (answered === 0) return null;
    return `${answered} ${answered === 1 ? "person has" : "people have"} already answered this question. Changing the answer type makes their answers incomparable — consider adding a new question instead.`;
  }

  // Publishing inserts a row; a double-click would create two jobs.
  const inFlightRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  function set<K extends keyof CompanyJobInput>(key: K, value: CompanyJobInput[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      // Touching ANY question clears every per-question error: they're keyed by
      // question id, and the row that was flagged may since have been removed.
      const stale =
        key === "screening_questions"
          ? Object.keys(prev).filter((k) => k.startsWith(QUESTION_ERR_PREFIX))
          : [];
      if (!prev[key as string] && stale.length === 0) return prev;
      const next = { ...prev };
      delete next[key as string];
      for (const k of stale) delete next[k];
      return next;
    });
  }

  // ── Validation ─────────────────────────────────────────────

  function validate(target: number): boolean {
    const next: Record<string, string> = {};

    if (target === 1) {
      if (!state.title.trim()) next.title = "Add a job title to continue.";
      else if (!state.location.trim()) next.location = "Where is this role based?";
    }
    if (target === 2) {
      if (!state.description.trim()) {
        next.description = "Add a short overview so candidates know what they're applying to.";
      }
    }
    if (target === 3 && state.show_salary) {
      const min = Number.parseInt(state.salary_min, 10);
      const max = Number.parseInt(state.salary_max, 10);
      if (!state.salary_min || Number.isNaN(min)) next.salary_min = "Enter a minimum.";
      else if (!state.salary_max || Number.isNaN(max) || max < min) {
        next.salary_max = "Max must be equal to or above the minimum.";
      }
    }

    // Step 4 was previously ungated entirely — publish only ran steps 1–3,
    // which is how numeric questions reached production with no threshold.
    if (target === 4) {
      state.screening_questions.forEach((q, i) => {
        const key = `${QUESTION_ERR_PREFIX}${q.id}`;
        if (next[key]) return;
        if (!q.question.trim()) {
          next[key] = `Question ${i + 1} has no text — write it or remove it.`;
        } else if (q.type === "multiple" && liveOptions(q).length < 2) {
          next[key] = `Question ${i + 1} needs at least two answer options.`;
        } else if (!hasUsableIdeal(q)) {
          next[key] = QUESTION_IDEAL_ERROR[q.type](i + 1);
        }
      });
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      showToast(Object.values(next)[0]);
      return false;
    }
    return true;
  }

  /** Rail navigation: going forward re-validates every intervening step. */
  function goTo(target: number) {
    if (target <= step) {
      setStep(target);
      return;
    }
    /*
     * Walk the SEQUENCE, not the raw numbers: step 7 is locked, so counting
     * upward would validate a step the user can never reach or fix.
     */
    const from = positionOf(step);
    const to = positionOf(target);
    for (let pos = from; pos < to; pos++) {
      const k = stepAt(pos);
      if (k !== null && !validate(k)) {
        setStep(k);
        return;
      }
    }
    setStep(target);
  }

  // ── Screening builder ──────────────────────────────────────

  const questions = state.screening_questions;

  function addQuestion() {
    if (questions.length >= 10) return;
    set("screening_questions", [
      ...questions,
      {
        id: crypto.randomUUID(),
        question: "",
        type: "yesno",
        // "Yes" by default. A binary whose good answer is Yes ~95% of the time
        // does not need confirming on every question — see hasUsableIdeal.
        // Numeric and multiple choice still start UNSET.
        ideal: "Yes",
        options: [],
        essential: false,
      },
    ]);
  }

  function patchQuestion(index: number, patch: Partial<ScreeningQuestion>) {
    set(
      "screening_questions",
      questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    );
  }

  function changeType(index: number, type: ScreeningQuestion["type"]) {
    // Reset `ideal`/`options` to that type's shape so a half-migrated question
    // can never reach the server. `ideal` resets to UNSET whatever the type —
    // an ideal carried over from another answer type is meaningless, and a
    // fresh default would be the very thing that shipped 0-thresholds.
    patchQuestion(index, {
      type,
      // Yes/No lands on its default; the other two reset to unset, because an
      // ideal carried over from another answer type is meaningless.
      ideal: type === "yesno" ? "Yes" : "",
      options: type === "multiple" ? ["", ""] : [],
      // Switching TO numeric starts on "minimum", the mode most people mean
      // when they add one. Switching AWAY clears it so a stale mode can't ride
      // along on a question that is no longer numeric.
      numeric_mode: type === "numeric" ? "min" : undefined,
    });
  }

  /**
   * Changing the mode clears the threshold rather than carrying it across.
   *
   * A 3 typed as a minimum means "at least 3"; the same 3 read as a maximum
   * means "at most 3" — the opposite test on the same candidates. Silently
   * reinterpreting it would flip who passes without the company touching the
   * number, so the field empties and has to be entered again for the new
   * direction. Moving to "none" clears it because there is nothing to keep.
   */
  function changeNumericMode(index: number, mode: NumericMode) {
    patchQuestion(index, { numeric_mode: mode, ideal: "" });
  }

  /**
   * Re-splitting the options textarea can invalidate an index already chosen,
   * so the selection is remapped BY LABEL: rename or delete the ideal option
   * and it clears, reorder the list and the same option stays ideal. Without
   * this, adding a line above the chosen one would silently move the ideal.
   */
  function changeOptions(index: number, raw: string) {
    const q = questions[index];
    const previous = idealOptionLabel(q);
    const options = raw.split("\n");
    const nextIdx = previous
      ? options
          .map((o) => o.trim())
          .filter(Boolean)
          .indexOf(previous)
      : -1;
    patchQuestion(index, {
      options,
      ideal: nextIdx >= 0 ? String(nextIdx) : "",
    });
  }

  /** Red ring on an ideal field the publish gate flagged. */
  function idealCls(q: ScreeningQuestion): string {
    return errors[`${QUESTION_ERR_PREFIX}${q.id}`] ? `${INPUT_CLS} ${INPUT_ERR_CLS}` : INPUT_CLS;
  }

  function removeQuestion(index: number) {
    set(
      "screening_questions",
      questions.filter((_, i) => i !== index),
    );
  }

  // ── Interview builder ──────────────────────────────────────
  //
  // Same shape as the screening builder above deliberately: add / patch /
  // remove / move on an array in form state, persisted by the action. These
  // rows land in their own table rather than a JSONB column, but that is the
  // action's problem, not the form's.

  const interviewQs = state.interview_questions;

  /*
   * Rows whose competency is being typed freehand.
   *
   * Only needed for the gap between picking "Other…" and typing anything: at
   * that moment the stored value is "" and would otherwise derive straight
   * back to the select. Everything else is DERIVED — a saved value that is not
   * in the suggestion list opens in free-text mode on its own, so a company's
   * existing wording survives the list changing under it.
   */
  const [otherCompetency, setOtherCompetencyIds] = useState<Set<string>>(new Set());

  function setOtherCompetency(id: string, on: boolean) {
    setOtherCompetencyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function usesOtherCompetency(q: InterviewQuestionInput): boolean {
    if (otherCompetency.has(q.id)) return true;
    return q.competency !== "" && !isSuggestedCompetency(q.competency);
  }

  function addInterviewQ() {
    if (interviewQs.length >= MAX_QUESTIONS) return;
    set("interview_questions", [
      ...interviewQs,
      { ...EMPTY_QUESTION_INPUT, id: `new-${crypto.randomUUID()}` },
    ]);
  }

  function patchInterviewQ(index: number, patch: Partial<InterviewQuestionInput>) {
    set(
      "interview_questions",
      interviewQs.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    );
  }

  function removeInterviewQ(index: number) {
    set(
      "interview_questions",
      interviewQs.filter((_, i) => i !== index),
    );
  }

  /** Move one question up or down. Order IS the candidate's running order. */
  function moveInterviewQ(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= interviewQs.length) return;
    const copy = [...interviewQs];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    set("interview_questions", copy);
  }

  // ── Submit ─────────────────────────────────────────────────

  async function submit(status: CompanyJobInput["status"]) {
    if (inFlightRef.current) return;

    // Drafts skip validation beyond a title — the point of a draft is that it
    // isn't finished yet. Publishing runs every gate.
    if (status === "open") {
      // 4, not 3: screening is now a publish gate. A draft still saves with
      // half-built questions — buildPatch only enforces this for status 'open'.
      for (let k = 1; k <= 4; k++) {
        if (!validate(k)) {
          setStep(k);
          return;
        }
      }
    } else if (!state.title.trim()) {
      setErrors({ title: "Add a job title to save a draft." });
      setStep(1);
      showToast("Add a job title to save a draft");
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const payload = { ...state, status };
      const result =
        isEdit && jobId ? await updateCompanyJob(jobId, payload) : await createCompanyJob(payload);

      if (!result.success) {
        showToast(result.error);
        return;
      }

      /*
       * The role saved but its interview questions did not.
       *
       * Navigating away on a fleeting toast would lose the one message that
       * says the job is incomplete, so the destination changes instead:
       *   - editing STAYS on this page, where Save can simply be pressed
       *     again (updates are idempotent);
       *   - creating goes to the new job's EDIT page rather than the list or
       *     the "published" overlay, because re-submitting THIS form would
       *     create a second job — the edit page is the one place a retry is
       *     both obvious and safe.
       */
      if (result.warning) {
        showToast(result.warning);
        if (!isEdit && result.data?.id) {
          router.push(`/ai-dashboard/jobs/${result.data.id}/edit`);
          router.refresh();
        }
        return;
      }

      // Editing returns straight to the list — the "Post another" overlay only
      // makes sense right after creating something.
      if (isEdit) {
        router.push("/ai-dashboard/jobs");
        router.refresh();
        return;
      }
      if (status === "open") {
        setPublished({ title: state.title.trim() || "Your role" });
      } else {
        router.push("/ai-dashboard/jobs");
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  // ── Preview ────────────────────────────────────────────────

  const compensation = useMemo(() => {
    if (!state.show_salary) return null;
    const min = fmtNumber(state.salary_min);
    const max = fmtNumber(state.salary_max);
    if (!min && !max) return null;
    return `${currencySymbol(state.salary_currency)} ${min || "—"} – ${max || "—"}`;
  }, [state.show_salary, state.salary_min, state.salary_max, state.salary_currency]);

  // Steps 8 and 9 live in LATE_STEPS, so the lookup spans both tables rather
  // than indexing STEPS by position — which would silently return Basics.
  const meta = STEPS.find((x) => x.n === step) ?? LATE_STEPS.find((x) => x.n === step) ?? STEPS[0];

  return (
    <div className="flex min-h-full flex-col">
      {/* Wizard topbar */}
      <div className="sticky top-[64px] z-20 flex h-[60px] shrink-0 items-center gap-3.5 border-b border-[var(--ai-line)] bg-[var(--ai-inset)]/85 px-4 backdrop-blur-xl min-[840px]:px-8">
        <Link
          href="/ai-dashboard/jobs"
          className="inline-flex items-center gap-[7px] rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-2 text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
        >
          <ChevronLeft className="size-[15px]" strokeWidth={2} />
          Jobs
        </Link>
        <span className="text-sm font-semibold text-[var(--ai-t1)]">
          {isEdit ? "Edit job" : "New job"}
        </span>

        <div className="ml-auto flex gap-2.5">
          <button
            type="button"
            onClick={() => submit("on_hold")}
            disabled={submitting}
            className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[9px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:opacity-50"
          >
            {isEdit ? "Save as draft" : "Save draft"}
          </button>
          <button
            type="button"
            onClick={() => submit(isEdit ? state.status : "open")}
            disabled={submitting}
            aria-busy={submitting}
            className="inline-flex items-center gap-2 rounded-[11px] bg-remotiv-purple px-[18px] py-[9px] text-[13.5px] font-semibold text-white shadow-[0_4px_16px_rgba(126,71,255,0.28)] transition-colors hover:bg-[var(--ai-purple-hover)] disabled:opacity-60"
          >
            <ArrowRight className="size-[15px]" strokeWidth={2} />
            {submitting
              ? isEdit
                ? "Saving…"
                : "Publishing…"
              : isEdit
                ? "Save changes"
                : "Publish"}
          </button>
        </div>
      </div>

      <PageContainer>
        {/*
          Track sizing from the mock's `.wiz` rule: fixed rail / flexible form /
          fixed preview. minmax(0,1fr) on the middle track is load-bearing — a
          bare 1fr keeps an auto minimum, refuses to shrink, and inflates the
          two side tracks instead.

          The mock's own fallbacks are 1240px and 860px; this segment's
          breakpoints are scaled by the 0.82 zoom, so those become 1017 and 705.
          Deliberately NOT the scaled lg/xl (840/1049) used elsewhere — these
          two widths are the wizard's own, set by where its columns stop fitting.

          Track widths are the mock's v2 values and are NOT scaled: they sit
          inside the zoomed subtree, so they are already design px. Only the
          media-query thresholds scale, because those evaluate against the
          unzoomed viewport.
        */}
        <div className="grid grid-cols-1 items-start gap-[22px] min-[705px]:grid-cols-[220px_minmax(0,1fr)] min-[1017px]:grid-cols-[236px_minmax(0,1fr)_300px]">
          {/* Step rail — the segment's dark panel treatment.
              Every <p> inside sets its own colour: the design system's global
              `p { color:#444 }` beats an inherited white and would render these
              near-invisible on #141020. */}
          <div className="min-[705px]:sticky min-[705px]:top-[150px]">
            <div className="rounded-[20px] bg-[var(--ai-sidebar)] px-[18px] py-5 shadow-[0_18px_46px_rgba(20,16,32,0.24)]">
              <h1 className="mb-1 font-heading text-xl font-extrabold tracking-[-0.03em] text-white">
                {isEdit ? "Edit job" : "Post a job"}
              </h1>
              <p className="mb-3.5 text-xs text-white/50">
                {isEdit ? "5 steps · edit any section" : "5 steps · ~4 min"}
              </p>

              {/* Lime progress bar — how far through the five steps the user is. */}
              <div className="mb-[18px] h-1 overflow-hidden rounded-[3px] bg-white/[0.12]">
                <div
                  className="h-full rounded-[3px] bg-remotiv-lime transition-[width] duration-300 ease-out"
                  style={{
                    width: `${(positionOf(step) / SEQUENCE.length) * 100}%`,
                  }}
                />
              </div>

              <div>
                {STEPS.map((s) => {
                  const active = s.n === step;
                  const done = positionOf(s.n) < positionOf(step);
                  return (
                    <button
                      key={s.n}
                      type="button"
                      onClick={() => goTo(s.n)}
                      /* `.step` + `.step.active` only. A completed step gets NO
                       row treatment — no background, border or shadow — which
                       is what stops it looking like a second active card. */
                      className={`${STEP_ROW} ${active ? STEP_ROW_ACTIVE : STEP_ROW_IDLE}`}
                    >
                      <span
                        /* `.step.done` styles the CIRCLE ONLY. */
                        className={`${STEP_NUM} ${
                          active ? STEP_NUM_ACTIVE : done ? STEP_NUM_DONE : STEP_NUM_IDLE
                        }`}
                      >
                        {/* Completing a step recolours the badge — the digit stays. */}
                        {s.n}
                      </span>
                      <span
                        /* `.step.active .lab` and `.step.done .lab` are the only
                         label overrides; an untouched label stays at 62%. */
                        className={`${STEP_LAB} ${
                          active ? "text-white" : done ? "text-white/70" : "text-white/[0.62]"
                        }`}
                      >
                        {s.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div>
                {LATE_STEPS.map((s) => {
                  const active = s.n === step;
                  const done = positionOf(s.n) < positionOf(step);
                  return (
                    <button
                      key={s.n}
                      type="button"
                      onClick={() => goTo(s.n)}
                      className={`${STEP_ROW} ${active ? STEP_ROW_ACTIVE : STEP_ROW_IDLE}`}
                    >
                      <span
                        className={`${STEP_NUM} ${
                          active ? STEP_NUM_ACTIVE : done ? STEP_NUM_DONE : STEP_NUM_IDLE
                        }`}
                      >
                        {s.n}
                      </span>
                      <span
                        className={`${STEP_LAB} ${
                          active ? "text-white" : done ? "text-white/70" : "text-white/[0.62]"
                        }`}
                      >
                        {s.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Form card */}
          <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
            <div className="flex items-start justify-between gap-4 px-[26px] pb-1.5 pt-[22px]">
              <div className="min-w-0">
                <h2 className="mb-[5px] font-heading text-[21px] font-extrabold tracking-[-0.025em]">
                  {meta.title}
                </h2>
                <p className="text-[13px] leading-relaxed text-[var(--ai-t3)]">{meta.desc}</p>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-purple-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-[var(--ai-purple-ink)]">
                Step {step} of {HIGHEST_STEP}
              </span>
            </div>

            <div className="px-[26px] pb-6 pt-5">
              {step === 1 && (
                <>
                  <div className="mb-4">
                    <label htmlFor="w-title" className={LABEL_CLS}>
                      Job title <span className="text-remotiv-purple">*</span>
                    </label>
                    <input
                      id="w-title"
                      value={state.title}
                      onChange={(e) => set("title", e.target.value)}
                      placeholder="e.g. Senior Frontend Engineer"
                      className={`${INPUT_CLS} ${errors.title ? INPUT_ERR_CLS : ""}`}
                    />
                    {errors.title && (
                      <p className="mt-1.5 text-xs text-[#C4362F]">{errors.title}</p>
                    )}
                  </div>

                  <div className="mb-4 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2">
                    <div>
                      <label htmlFor="w-category" className={LABEL_CLS}>
                        Category <span className="text-remotiv-purple">*</span>
                      </label>
                      <select
                        id="w-category"
                        value={state.category}
                        onChange={(e) => set("category", e.target.value)}
                        className={INPUT_CLS}
                      >
                        {JOB_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="w-experience" className={LABEL_CLS}>
                        Experience <span className="text-remotiv-purple">*</span>
                      </label>
                      <select
                        id="w-experience"
                        value={state.experience_level}
                        onChange={(e) => set("experience_level", e.target.value)}
                        className={INPUT_CLS}
                      >
                        {JOB_EXPERIENCE_LEVELS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mb-4 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2">
                    <div>
                      <label htmlFor="w-worktype" className={LABEL_CLS}>
                        Work type <span className="text-remotiv-purple">*</span>
                      </label>
                      <select
                        id="w-worktype"
                        value={state.work_type}
                        onChange={(e) => set("work_type", e.target.value)}
                        className={INPUT_CLS}
                      >
                        {JOB_WORK_TYPES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="w-contract" className={LABEL_CLS}>
                        Contract <span className="text-remotiv-purple">*</span>
                      </label>
                      <select
                        id="w-contract"
                        value={state.contract_type}
                        onChange={(e) => set("contract_type", e.target.value)}
                        className={INPUT_CLS}
                      >
                        {JOB_CONTRACT_TYPES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-[1fr_108px]">
                    <div>
                      <label htmlFor="w-location" className={LABEL_CLS}>
                        Location <span className="text-remotiv-purple">*</span>
                      </label>
                      <input
                        id="w-location"
                        value={state.location}
                        onChange={(e) => set("location", e.target.value)}
                        placeholder="e.g. Remote — Pakistan"
                        className={`${INPUT_CLS} ${errors.location ? INPUT_ERR_CLS : ""}`}
                      />
                      {errors.location && (
                        <p className="mt-1.5 text-xs text-[#C4362F]">{errors.location}</p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="w-openings" className={LABEL_CLS}>
                        Openings
                      </label>
                      <input
                        id="w-openings"
                        type="number"
                        min={1}
                        value={state.positions}
                        onChange={(e) => set("positions", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </div>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <div className="mb-4">
                    <label htmlFor="w-about" className={LABEL_CLS}>
                      About the role <span className="text-remotiv-purple">*</span>
                    </label>
                    <textarea
                      id="w-about"
                      value={state.description}
                      onChange={(e) => set("description", e.target.value)}
                      maxLength={JOB_TEXT_MAX}
                      placeholder="A short overview of the role, the team, and why it matters."
                      className={`${TEXTAREA_CLS} ${errors.description ? INPUT_ERR_CLS : ""}`}
                    />
                    {errors.description && (
                      <p className="mt-1.5 text-xs text-[#C4362F]">{errors.description}</p>
                    )}
                    <CharCount
                      value={state.description}
                      hint="Markdown isn't supported — plain text only."
                    />
                  </div>
                  <div className="mb-4">
                    <label htmlFor="w-resp" className={LABEL_CLS}>
                      Responsibilities
                    </label>
                    <textarea
                      id="w-resp"
                      value={state.responsibilities}
                      onChange={(e) => set("responsibilities", e.target.value)}
                      maxLength={JOB_TEXT_MAX}
                      placeholder="One responsibility per line…"
                      className={TEXTAREA_CLS}
                    />
                    <CharCount
                      value={state.responsibilities}
                      hint="One per line — these render as bullets on the public post."
                    />
                  </div>
                  <div>
                    <label htmlFor="w-reqs" className={LABEL_CLS}>
                      Requirements
                    </label>
                    <textarea
                      id="w-reqs"
                      value={state.requirements}
                      onChange={(e) => set("requirements", e.target.value)}
                      maxLength={JOB_TEXT_MAX}
                      placeholder="Must-have skills and experience, one per line…"
                      className={TEXTAREA_CLS}
                    />
                    <CharCount value={state.requirements} />
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <div className="mb-4">
                    <span className={LABEL_CLS}>Currency</span>
                    <div className="flex gap-0.5 rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
                      {JOB_CURRENCIES.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => set("salary_currency", c as JobCurrency)}
                          className={`flex-1 rounded-lg py-[9px] text-[13px] font-semibold transition-colors ${
                            state.salary_currency === c
                              ? "bg-[var(--ai-surface)] text-[var(--ai-t1)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                              : "text-[var(--ai-t3)]"
                          }`}
                        >
                          {c === "USD" ? "USD ($)" : "PKR"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-4 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2">
                    <div>
                      <label htmlFor="w-min" className={LABEL_CLS}>
                        Minimum <span className="text-remotiv-purple">*</span>
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-[13px] top-1/2 -translate-y-1/2 text-sm text-[var(--ai-t3)]">
                          {currencySymbol(state.salary_currency)}
                        </span>
                        <input
                          id="w-min"
                          type="number"
                          min={0}
                          value={state.salary_min}
                          onChange={(e) => set("salary_min", e.target.value)}
                          placeholder="400000"
                          className={`${INPUT_CLS} pl-11 ${errors.salary_min ? INPUT_ERR_CLS : ""}`}
                        />
                      </div>
                      {errors.salary_min && (
                        <p className="mt-1.5 text-xs text-[#C4362F]">{errors.salary_min}</p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="w-max" className={LABEL_CLS}>
                        Maximum <span className="text-remotiv-purple">*</span>
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-[13px] top-1/2 -translate-y-1/2 text-sm text-[var(--ai-t3)]">
                          {currencySymbol(state.salary_currency)}
                        </span>
                        <input
                          id="w-max"
                          type="number"
                          min={0}
                          value={state.salary_max}
                          onChange={(e) => set("salary_max", e.target.value)}
                          placeholder="600000"
                          className={`${INPUT_CLS} pl-11 ${errors.salary_max ? INPUT_ERR_CLS : ""}`}
                        />
                      </div>
                      {errors.salary_max && (
                        <p className="mt-1.5 text-xs text-[#C4362F]">{errors.salary_max}</p>
                      )}
                    </div>
                  </div>

                  <p className="mb-4 text-xs leading-relaxed text-[var(--ai-t3)]">
                    Salary displays as a monthly range (<b>/mo</b>) on the public post.
                  </p>

                  <div className="flex items-center gap-3 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-[13px]">
                    <div>
                      <div className="text-[13.5px] font-semibold text-[var(--ai-t1)]">
                        Show salary publicly
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--ai-t3)]">
                        Posts with visible pay get up to 2× more qualified applicants.
                      </div>
                    </div>
                    <span className="ml-auto">
                      <Toggle
                        on={state.show_salary}
                        onClick={() => set("show_salary", !state.show_salary)}
                        label="Show salary publicly"
                      />
                    </span>
                  </div>
                </>
              )}

              {step === 4 && (
                <>
                  {questions.map((q, i) => (
                    <div
                      key={q.id}
                      className="mb-3 rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3.5 transition-shadow hover:shadow-[0_4px_16px_rgba(20,16,32,0.06)]"
                    >
                      <div className="mb-[11px] flex items-center gap-2.5">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-purple-tint)] text-xs font-bold text-[var(--ai-purple-ink)]">
                          {i + 1}
                        </span>
                        <input
                          value={q.question}
                          onChange={(e) => patchQuestion(i, { question: e.target.value })}
                          placeholder="Ask a screening question…"
                          aria-label={`Question ${i + 1}`}
                          className={`${INPUT_CLS} flex-1`}
                        />
                        <button
                          type="button"
                          onClick={() => removeQuestion(i)}
                          aria-label={`Remove question ${i + 1}`}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-danger-tint)] hover:text-[var(--ai-danger)]"
                        >
                          <Trash className="size-[17px]" strokeWidth={1.8} />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 items-start gap-2.5 min-[525px]:grid-cols-[150px_1fr]">
                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Answer type
                          </span>
                          <select
                            value={q.type}
                            onChange={(e) =>
                              changeType(i, e.target.value as ScreeningQuestion["type"])
                            }
                            aria-label={`Answer type for question ${i + 1}`}
                            className={INPUT_CLS}
                          >
                            {QUESTION_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            {q.type === "numeric"
                              ? "How is this number judged?"
                              : IDEAL_LABEL[q.type]}
                          </span>
                          {q.type === "numeric" && (
                            <select
                              value={resolveNumericMode(q)}
                              onChange={(e) => changeNumericMode(i, e.target.value as NumericMode)}
                              aria-label={`How question ${i + 1} is judged`}
                              className={INPUT_CLS}
                            >
                              {NUMERIC_MODES.map((m) => (
                                <option key={m.value} value={m.value}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          )}
                          {q.type === "yesno" && (
                            <select
                              value={q.ideal}
                              onChange={(e) => patchQuestion(i, { ideal: e.target.value })}
                              aria-label={`Ideal answer for question ${i + 1}`}
                              className={idealCls(q)}
                            >
                              <option value="Yes">Yes</option>
                              <option value="No">No</option>
                            </select>
                          )}
                          {q.type === "multiple" && (
                            <textarea
                              value={q.options.join("\n")}
                              onChange={(e) => changeOptions(i, e.target.value)}
                              placeholder={"Best match\nAcceptable\nNot a fit"}
                              aria-label={`Options for question ${i + 1}`}
                              className={`${INPUT_CLS} min-h-20 resize-y`}
                            />
                          )}
                          {q.type === "yesno" && <FieldHint text={IDEAL_HINT.yesno} />}
                        </div>
                      </div>

                      {/* Fires the instant the type select changes, directly
                          under the control that caused it — the company can see
                          the consequence while deciding, rather than at publish
                          when the change already feels settled. Advisory only:
                          no error styling, nothing disabled, publish unaffected. */}
                      {typeChangeWarning(q) && (
                        <p className="mt-2.5 flex gap-2 rounded-[10px] bg-[var(--ai-amber-tint)] px-3 py-2.5 text-xs leading-relaxed text-[var(--ai-amber-ink)]">
                          <TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                          <span>{typeChangeWarning(q)}</span>
                        </p>
                      )}

                      {/* The threshold field follows the mode: it carries the
                          direction in its own label, and 'none' hides it
                          entirely rather than showing a disabled box — there is
                          genuinely nothing to fill in, and a greyed field would
                          imply otherwise. */}
                      {q.type === "numeric" && resolveNumericMode(q) !== "none" && (
                        <div className="mt-2.5">
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            {NUMERIC_MODE_LABEL[resolveNumericMode(q)]}
                          </span>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={q.ideal}
                            onChange={(e) => patchQuestion(i, { ideal: e.target.value })}
                            placeholder="e.g. 3"
                            aria-label={`${NUMERIC_MODE_LABEL[resolveNumericMode(q)]} for question ${i + 1}`}
                            className={idealCls(q)}
                          />
                          <FieldHint text={NUMERIC_MODE_HINT[resolveNumericMode(q)]} />
                        </div>
                      )}
                      {q.type === "numeric" && resolveNumericMode(q) === "none" && (
                        <div className="mt-2.5">
                          <FieldHint text={NUMERIC_MODE_HINT.none} />
                        </div>
                      )}

                      {/* Multiple choice stores `ideal` as an option INDEX, and
                          nothing ever asked which one — it was hardcoded to 0
                          on every keystroke, so "the first option" looked like
                          a choice the company had made. Now it's explicit. */}
                      {q.type === "multiple" && (
                        <div className="mt-2.5">
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Ideal option
                          </span>
                          <select
                            value={q.ideal}
                            onChange={(e) => patchQuestion(i, { ideal: e.target.value })}
                            disabled={liveOptions(q).length < 2}
                            aria-label={`Ideal option for question ${i + 1}`}
                            className={`${idealCls(q)} disabled:cursor-not-allowed disabled:opacity-50`}
                          >
                            <option value="">
                              {liveOptions(q).length < 2
                                ? "Add at least two options first…"
                                : "Choose the ideal option…"}
                            </option>
                            {liveOptions(q).map((opt, idx) => (
                              <option key={`${idx}-${opt}`} value={String(idx)}>
                                {opt}
                              </option>
                            ))}
                          </select>
                          <FieldHint text={IDEAL_HINT.multiple} />
                        </div>
                      )}

                      {errors[`${QUESTION_ERR_PREFIX}${q.id}`] && (
                        <p className="mt-2 text-xs text-[#C4362F]">
                          {errors[`${QUESTION_ERR_PREFIX}${q.id}`]}
                        </p>
                      )}

                      <div className="mt-[11px] flex items-center gap-2.5 border-t border-[var(--ai-line-soft)] pt-[11px]">
                        <span className="ml-auto flex items-center gap-2.5 text-[12.5px] font-semibold text-[var(--ai-t2)]">
                          Essential
                          <Toggle
                            on={q.essential}
                            onClick={() => patchQuestion(i, { essential: !q.essential })}
                            label={`Question ${i + 1} is essential`}
                          />
                        </span>
                      </div>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addQuestion}
                    disabled={questions.length >= 10}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-[var(--ai-line-strong)] px-3 py-3 text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-remotiv-purple hover:bg-[var(--ai-purple-tint)] hover:text-remotiv-purple disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="size-4" strokeWidth={2} />
                    Add question
                  </button>
                  <p className="mx-0.5 mt-2.5 text-right text-xs text-[var(--ai-t3)]">
                    {questions.length} of 10 questions
                  </p>
                </>
              )}

              {step === 5 && (
                <>
                  {interviewQs.length === 0 && (
                    <div className="mb-3 rounded-[14px] border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] px-4 py-5 text-center">
                      <p className="m-0 text-[13.5px] font-semibold text-[var(--ai-t2)]">
                        No interview questions yet
                      </p>
                      <p className="m-0 mt-1.5 text-xs leading-relaxed text-[var(--ai-t3)]">
                        Add {MIN_QUESTIONS}–{MAX_QUESTIONS}. Candidates answer each one on camera in
                        their own time — there&apos;s no call to schedule. Leave this empty to skip
                        the video round for this job.
                      </p>
                    </div>
                  )}

                  {interviewQs.map((q, i) => (
                    <div
                      key={q.id}
                      className="mb-3 rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3.5 transition-shadow hover:shadow-[0_4px_16px_rgba(20,16,32,0.06)]"
                    >
                      <div className="mb-[11px] flex items-center gap-2.5">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-purple-tint)] text-xs font-bold text-[var(--ai-purple-ink)]">
                          {i + 1}
                        </span>
                        <span className="flex-1 text-[11px] font-semibold text-[var(--ai-t3)]">
                          Question {i + 1} of {interviewQs.length}
                        </span>
                        {/* Order is the candidate's running order, so it is
                            editable here rather than fixed at creation. */}
                        <button
                          type="button"
                          onClick={() => moveInterviewQ(i, -1)}
                          disabled={i === 0}
                          aria-label={`Move question ${i + 1} up`}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <ArrowUp className="size-4" strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveInterviewQ(i, 1)}
                          disabled={i === interviewQs.length - 1}
                          aria-label={`Move question ${i + 1} down`}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <ArrowDown className="size-4" strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeInterviewQ(i)}
                          aria-label={`Remove question ${i + 1}`}
                          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-danger-tint)] hover:text-[var(--ai-danger)]"
                        >
                          <Trash className="size-[17px]" strokeWidth={1.8} />
                        </button>
                      </div>

                      <textarea
                        value={q.question}
                        maxLength={QUESTION_TEXT_MAX}
                        onChange={(e) => patchInterviewQ(i, { question: e.target.value })}
                        placeholder="e.g. Tell us about a time you improved the performance of a web application."
                        aria-label={`Interview question ${i + 1}`}
                        className={`${INPUT_CLS} min-h-[62px] resize-y leading-relaxed`}
                      />

                      <div className="mt-2.5 grid grid-cols-1 gap-2.5 min-[525px]:grid-cols-2">
                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Competency
                          </span>
                          {/* A native select with an "Other…" reveal rather
                              than a combobox: every other choice in this
                              wizard is a native select, and there is no
                              combobox primitive in the codebase to reuse. One
                              would mean new keyboard, filtering and ARIA
                              listbox behaviour for a single optional field —
                              and native selects are what phones render as a
                              full-screen picker, which is the better control
                              at 375px anyway. */}
                          <select
                            value={usesOtherCompetency(q) ? COMPETENCY_OTHER : q.competency}
                            onChange={(e) => {
                              const value = e.target.value;
                              if (value === COMPETENCY_OTHER) {
                                // Remember the choice for THIS row so the
                                // input stays open while it is still empty.
                                setOtherCompetency(q.id, true);
                                patchInterviewQ(i, { competency: "" });
                                return;
                              }
                              setOtherCompetency(q.id, false);
                              patchInterviewQ(i, { competency: value });
                            }}
                            aria-label={`Competency for question ${i + 1}`}
                            className={`${INPUT_CLS} cursor-pointer appearance-none`}
                          >
                            <option value="">No competency</option>
                            {COMPETENCY_SUGGESTIONS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            <option value={COMPETENCY_OTHER}>Other…</option>
                          </select>

                          {usesOtherCompetency(q) && (
                            <input
                              value={q.competency}
                              onChange={(e) => patchInterviewQ(i, { competency: e.target.value })}
                              placeholder="Name the competency"
                              aria-label={`Custom competency for question ${i + 1}`}
                              className={`${INPUT_CLS} mt-2`}
                            />
                          )}
                        </div>
                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Weight
                          </span>
                          <select
                            value={q.weight}
                            onChange={(e) => patchInterviewQ(i, { weight: e.target.value })}
                            aria-label={`Weight for question ${i + 1}`}
                            className={`${INPUT_CLS} cursor-pointer appearance-none`}
                          >
                            {["1", "2", "3", "4", "5"].map((w) => (
                              <option key={w} value={w}>
                                {w === "1" ? "1 — normal" : w === "5" ? "5 — critical" : w}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="mt-2.5">
                        <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                          What a good answer looks like
                        </span>
                        <textarea
                          value={q.rubric}
                          onChange={(e) => patchInterviewQ(i, { rubric: e.target.value })}
                          placeholder="Names a specific problem, explains the trade-off, says what they measured."
                          aria-label={`Rubric for question ${i + 1}`}
                          className={`${INPUT_CLS} min-h-[54px] resize-y leading-relaxed`}
                        />
                        {/* The rubric is for the reviewer and, later, the
                            scorer. It is never sent to the candidate — see
                            CandidateQuestion, which has no rubric field. */}
                        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ai-t3)]">
                          Only your team sees this. Candidates never do.
                        </p>
                      </div>

                      <div className="mt-2.5 grid grid-cols-1 gap-2.5 min-[400px]:grid-cols-2">
                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Thinking time
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={PREP_SECONDS_MIN}
                              max={PREP_SECONDS_MAX}
                              value={q.prepSeconds}
                              onChange={(e) => patchInterviewQ(i, { prepSeconds: e.target.value })}
                              aria-label={`Thinking time for question ${i + 1}, seconds`}
                              className={`${INPUT_CLS} flex-1`}
                            />
                            <span className="shrink-0 text-xs text-[var(--ai-t3)]">sec</span>
                          </div>
                        </div>
                        <div>
                          <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                            Answer limit
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={ANSWER_SECONDS_MIN}
                              max={ANSWER_SECONDS_MAX}
                              value={q.answerSeconds}
                              onChange={(e) =>
                                patchInterviewQ(i, { answerSeconds: e.target.value })
                              }
                              aria-label={`Answer limit for question ${i + 1}, seconds`}
                              className={`${INPUT_CLS} flex-1`}
                            />
                            <span className="shrink-0 text-xs text-[var(--ai-t3)]">sec</span>
                          </div>
                        </div>
                      </div>

                      <label className="mt-3 flex cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={q.required}
                          onChange={(e) => patchInterviewQ(i, { required: e.target.checked })}
                          className="size-4 shrink-0 accent-[var(--remotiv-purple,#7E47FF)]"
                        />
                        <span className="text-[12.5px] text-[var(--ai-t2)]">
                          Required — the candidate can&apos;t submit without it
                        </span>
                      </label>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addInterviewQ}
                    disabled={interviewQs.length >= MAX_QUESTIONS}
                    className="flex w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-transparent px-4 py-3 text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-solid hover:border-remotiv-purple hover:bg-[var(--ai-purple-tint)] hover:text-remotiv-purple disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="size-4" strokeWidth={2.4} />
                    {interviewQs.length >= MAX_QUESTIONS
                      ? `That's the maximum of ${MAX_QUESTIONS}`
                      : "Add a question"}
                  </button>

                  <p className="mt-3 text-xs leading-relaxed text-[var(--ai-t3)]">
                    {MIN_QUESTIONS}–{MAX_QUESTIONS} questions works best — long enough to judge,
                    short enough that people finish. Candidates get a practice round first, which is
                    never recorded or shared.
                  </p>
                </>
              )}

              {step === 6 && (
                <>
                  <div className="mb-3 grid grid-cols-1 gap-3 min-[525px]:grid-cols-2">
                    <ReviewCard label="Role" onEdit={() => setStep(1)}>
                      {state.title || "—"}{" "}
                      <span className="text-[var(--ai-t4)]">
                        · {state.category} · {state.experience_level}
                      </span>
                    </ReviewCard>
                    <ReviewCard label="Location & type" onEdit={() => setStep(1)}>
                      {state.location || "—"}{" "}
                      <span className="text-[var(--ai-t4)]">
                        · {state.work_type} · {state.contract_type} · {state.positions} opening
                        {state.positions === "1" ? "" : "s"}
                      </span>
                    </ReviewCard>
                  </div>

                  <div className="mb-3">
                    <ReviewCard label="Compensation" onEdit={() => setStep(3)}>
                      {compensation ? (
                        <>
                          {compensation} <small className="text-[var(--ai-t3)]">/mo</small>
                        </>
                      ) : (
                        <span className="text-[var(--ai-t4)]">Not shown publicly</span>
                      )}
                    </ReviewCard>
                  </div>

                  <div className="mb-3">
                    <ReviewCard label="Description" onEdit={() => setStep(2)}>
                      {state.description.trim() || (
                        <span className="text-[var(--ai-t4)]">No description added yet.</span>
                      )}
                    </ReviewCard>
                  </div>

                  <ReviewCard label="Screening questions" onEdit={() => setStep(4)}>
                    {questions.length === 0 ? (
                      <span className="text-[var(--ai-t4)]">No screening questions.</span>
                    ) : (
                      <div>
                        {questions.map((q, i) => (
                          <div
                            key={q.id}
                            className="flex items-baseline gap-2 border-b border-[var(--ai-line-soft)] py-[7px] text-[13px] text-[var(--ai-t2)] last:border-b-0"
                          >
                            <span className="shrink-0 font-bold text-remotiv-purple">{i + 1}</span>
                            <span>
                              {q.question || (
                                <span className="text-[var(--ai-t4)]">Untitled question</span>
                              )}
                              {q.essential && (
                                <span className="font-bold text-remotiv-purple"> · essential</span>
                              )}
                            </span>
                            {/* Surfaced here too — Review is the last place a
                                company looks before publishing, and the gate
                                should be visible rather than only firing on
                                the button. */}
                            {/* "Needs a threshold", not "No threshold" — the
                                latter is now a legitimate numeric mode, and the
                                error pill must not read like a valid setting. */}
                            {!hasUsableIdeal(q) && (
                              <span className={`${PILL} ml-auto bg-[#FBE3E1] text-[#B02A24]`}>
                                Needs a threshold
                              </span>
                            )}
                            <span
                              className={`shrink-0 text-[11px] font-semibold text-[var(--ai-t4)] ${
                                hasUsableIdeal(q) ? "ml-auto" : ""
                              }`}
                            >
                              {reviewTypeLabel(q)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </ReviewCard>

                  {/* Hiring team.
                      Editing an existing job manages the real team; a job that
                      does not exist yet has no rows to manage, so the create
                      flow states what will happen instead of rendering an
                      empty list nobody can act on. */}
                  <div className="mt-3 rounded-[13px] border border-[var(--ai-line)] p-4">
                    <p className="m-0 mb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]">
                      Hiring team
                    </p>
                    {isEdit && jobId ? (
                      <HiringTeamSection jobId={jobId} onToast={setToast} />
                    ) : (
                      <p className="m-0 text-xs leading-relaxed text-[var(--ai-t3)]">
                        You&apos;ll be added to this job&apos;s hiring team when you publish it.
                        Owners and admins see every job; recruiters and hiring managers see only the
                        ones they&apos;re on. Add them from the job&apos;s drawer once it exists.
                      </p>
                    )}
                  </div>

                  <div className="mt-3 overflow-hidden rounded-[13px] border border-[var(--ai-line)]">
                    <button
                      type="button"
                      onClick={() => setMoreOpen((prev) => !prev)}
                      aria-expanded={moreOpen}
                      className="flex w-full items-center gap-2.5 bg-[var(--ai-inset)] px-4 py-3.5 text-left transition-colors hover:bg-[var(--ai-line-soft)]"
                    >
                      <Settings2
                        className="size-[17px] shrink-0 text-[var(--ai-t3)]"
                        strokeWidth={1.9}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-semibold text-[var(--ai-t1)]">
                          More options
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-[var(--ai-t3)]">
                          Interview and scoring behaviour for this job.
                        </span>
                      </span>
                      <ChevronDown
                        className={`ml-auto size-[18px] shrink-0 text-[var(--ai-t3)] transition-transform ${
                          moreOpen ? "rotate-180" : ""
                        }`}
                        strokeWidth={2}
                      />
                    </button>

                    {moreOpen && (
                      <div className="border-t border-[var(--ai-line)] bg-[var(--ai-surface)] p-4">
                        <p className="mb-3 text-xs leading-relaxed text-[var(--ai-t3)]">
                          Saved with the job and editable at any time. Anything marked{" "}
                          <b className="font-bold text-[var(--ai-amber-ink)]">{SOON_LABEL}</b> is
                          stored now and changes nothing about this job yet;{" "}
                          <b className="font-bold text-[var(--ai-mint-ink)]">{LIVE_LABEL}</b> takes
                          effect as soon as you save.
                        </p>

                        <div className="grid gap-2.5">
                          {/* Read at send time and frozen onto the session,
                              so the candidate's page offers Re-record under
                              exactly the rule that was in force when they were
                              invited — a later edit cannot change an interview
                              already in flight. */}
                          <OptionRow
                            title="Allow re-recording"
                            desc="Candidates can re-record their interview before submitting."
                            live
                            on={state.allow_rerecord}
                            onToggle={() => set("allow_rerecord", !state.allow_rerecord)}
                          />

                          <OptionRow
                            title="AI CV scoring"
                            desc="Score each CV against this job when someone applies."
                            live
                            on={state.ai_cv_scoring_enabled}
                            onToggle={() =>
                              set("ai_cv_scoring_enabled", !state.ai_cv_scoring_enabled)
                            }
                          />

                          <OptionRow
                            title="Measure response relevancy"
                            desc="Score how closely interview answers address the question."
                            on={state.measure_relevancy}
                            onToggle={() => set("measure_relevancy", !state.measure_relevancy)}
                          />

                          <OptionRow
                            title="AI avatar video interview"
                            desc="An AI avatar runs the first interview and records the answers."
                            on={state.avatar_interview_enabled}
                            onToggle={() =>
                              set("avatar_interview_enabled", !state.avatar_interview_enabled)
                            }
                          >
                            <InterviewerNameField
                              id="avatar-interviewer-name"
                              label="Avatar interviewer name"
                              placeholder="e.g. Aisha"
                              value={state.avatar_interviewer_name}
                              onChange={(v) => set("avatar_interviewer_name", v)}
                            />
                          </OptionRow>

                          {/* LIVE today, unlike the four interview options —
                              it gets the same "Active now" treatment as AI CV
                              scoring rather than the "when interviews launch"
                              pill, because switching it on changes what
                              candidates receive immediately. */}
                          <OptionRow
                            title="Automated rejection email"
                            desc="Two days after you move someone to Rejected, email them on your behalf. Moving them back out before then cancels it."
                            live
                            on={state.send_rejection_email}
                            onToggle={() =>
                              set("send_rejection_email", !state.send_rejection_email)
                            }
                          />

                          {/* The gate on sending. With this off,
                              sendInterviewInvite refuses and the applicant
                              drawer disables its button — so the toggle is now
                              the thing that decides whether this job uses
                              interviews at all. */}
                          <OptionRow
                            title="Async video interview"
                            desc="Candidates record answers in their own time, with no live call."
                            live
                            on={state.async_interview_enabled}
                            onToggle={() =>
                              set("async_interview_enabled", !state.async_interview_enabled)
                            }
                          >
                            <InterviewerNameField
                              id="async-interview-name"
                              label="Async interview name"
                              placeholder="e.g. First-round questions"
                              value={state.async_interview_name}
                              onChange={(v) => set("async_interview_name", v)}
                            />
                          </OptionRow>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* v2 `.publishnote` — the dark card, not the purple tint.
                      The <p> below carries an explicit colour: a dark surface
                      loses to the DS's global `p { color:#444 }` otherwise. */}
                  <div className="mt-[18px] flex items-start gap-3 rounded-[15px] bg-[var(--ai-sidebar)] px-[18px] py-4">
                    <Zap
                      className="mt-px size-[18px] shrink-0 text-remotiv-lime"
                      strokeWidth={1.9}
                    />
                    <p className="text-[13px] leading-relaxed text-white/[0.72]">
                      {isEdit ? (
                        state.status === "open" ? (
                          <>
                            <b className="font-bold text-white">
                              Changes go live on remotiv.work/jobs immediately.
                            </b>{" "}
                            Anyone viewing the post sees the updated version, and new applicants are
                            screened against these questions.
                          </>
                        ) : (
                          <>
                            <b className="font-bold text-white">
                              This job is a draft — it isn&apos;t public yet.
                            </b>{" "}
                            Saving keeps it private. Set the status to Published to put it live on
                            remotiv.work/jobs.
                          </>
                        )
                      ) : (
                        <>
                          <b className="font-bold text-white">
                            This publishes to remotiv.work/jobs immediately.
                          </b>{" "}
                          Applicants can apply right away and your AI recruiter starts screening
                          them against these questions.
                        </>
                      )}
                    </p>
                  </div>
                </>
              )}

              {step === 7 && (
                <ScoringCriteriaStep
                  state={state}
                  onChange={(next) => set("scoring_must_haves", next)}
                  onChangeCriteria={(next) => set("interview_criteria", next)}
                  /*
                   * Create only. An existing job reopens with exactly what was
                   * saved — including a deliberately empty list, which is a
                   * choice and not an absence to be helpfully filled in.
                   */
                  canPrefill={!isEdit}
                  seededRef={mustHavesSeededRef}
                />
              )}

              {step === 8 && (
                <WeightingStep
                  state={state}
                  onCvWeight={(key, stored) => setState((prev) => ({ ...prev, [key]: stored }))}
                  onQuestionWeight={(id, stored) =>
                    set(
                      "interview_questions",
                      state.interview_questions.map((q) =>
                        q.id === id ? { ...q, weight: String(stored) } : q,
                      ),
                    )
                  }
                  onResetCv={() =>
                    setState((prev) => ({
                      ...prev,
                      cv_weight_requirements: CV_WEIGHT_DEFAULT,
                      cv_weight_experience: CV_WEIGHT_DEFAULT,
                      cv_weight_domain: CV_WEIGHT_DEFAULT,
                      cv_weight_responsibilities: CV_WEIGHT_DEFAULT,
                    }))
                  }
                  onResetQuestions={() =>
                    set(
                      "interview_questions",
                      state.interview_questions.map((q) => ({
                        ...q,
                        weight: String(CV_WEIGHT_DEFAULT),
                      })),
                    )
                  }
                />
              )}

              {step === 9 && <AutoshortlistStep state={state} set={set} />}
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-4">
              <span className="text-[12.5px] font-semibold text-[var(--ai-t3)]">
                Step <b className="text-[var(--ai-t1)]">{positionOf(step)}</b> of {SEQUENCE.length}
              </span>
              <div className="flex gap-2.5">
                {positionOf(step) > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const prev = stepAt(positionOf(step) - 1);
                      if (prev !== null) setStep(prev);
                    }}
                    className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[9px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (step === FINAL_STEP) {
                      // Edit keeps whatever status the job already has; only
                      // create implies "publish now".
                      submit(isEdit ? state.status : "open");
                      return;
                    }
                    const next = stepAt(positionOf(step) + 1);
                    if (next !== null && validate(step)) setStep(next);
                  }}
                  className={`inline-flex items-center gap-2 rounded-[11px] px-5 py-2.5 text-[13.5px] font-semibold text-white transition-colors disabled:opacity-60 ${
                    step === FINAL_STEP
                      ? "bg-remotiv-purple shadow-[0_4px_16px_rgba(126,71,255,0.28)] hover:bg-[var(--ai-purple-hover)]"
                      : "bg-[var(--ai-sidebar)] hover:bg-[#241d38]"
                  }`}
                >
                  {step === FINAL_STEP ? (
                    <>
                      <ArrowRight className="size-[15px]" strokeWidth={2} />
                      {submitting
                        ? isEdit
                          ? "Saving…"
                          : "Publishing…"
                        : isEdit
                          ? "Save changes"
                          : "Publish job"}
                    </>
                  ) : (
                    <>
                      Continue
                      <ArrowRight className="size-[15px]" strokeWidth={2} />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Live public preview */}
          {/* Appears exactly when the third grid track does — same 1017px. */}
          <div className="hidden min-[1017px]:sticky min-[1017px]:top-[150px] min-[1017px]:block">
            <p className="mb-[9px] pl-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]">
              Public preview
            </p>
            <div className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] p-[18px] shadow-[0_8px_30px_rgba(20,16,32,0.07)]">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex size-[38px] items-center justify-center rounded-[11px] bg-gradient-to-br from-remotiv-purple to-remotiv-purple-light text-[15px] font-bold text-white">
                  {companyName.trim()[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="rounded-full bg-[var(--ai-inset)] px-2.5 py-1 text-[11px] text-[var(--ai-t4)]">
                  Posted just now
                </span>
              </div>
              <h3 className="mb-[5px] font-heading text-[17px] font-extrabold leading-tight tracking-[-0.02em]">
                {state.title || "Untitled role"}
              </h3>
              {/* Company + rating are workspace facts, never wizard fields. */}
              <p className="mb-0.5 flex items-center gap-1.5 text-[12.5px] text-[var(--ai-t2)]">
                {/* No rating is shown. There is no ratings system anywhere in
                    the product, and the mock's star figure was a fabricated
                    number rendered on the employer's own listing preview. */}
                {companyName}
              </p>
              <p className="mb-3 flex items-center gap-1.5 text-[12.5px] text-[var(--ai-t3)]">
                <MapPin className="size-[13px]" strokeWidth={1.8} />
                {state.location || "Location TBD"}
              </p>
              <p className="mb-[13px] font-heading text-base font-extrabold tracking-[-0.01em]">
                {compensation ? (
                  <>
                    {compensation}
                    <small className="font-sans text-[11.5px] font-medium tracking-normal text-[var(--ai-t3)]">
                      /mo
                    </small>
                  </>
                ) : (
                  <small className="font-sans text-[13px] font-medium text-[var(--ai-t3)]">
                    Compensation not shown
                  </small>
                )}
              </p>
              <div className="mb-3.5 flex flex-wrap gap-1.5">
                {[state.contract_type, state.work_type, state.experience_level].map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-[var(--ai-line-strong)] px-[11px] py-1 text-[11.5px] text-[var(--ai-t2)]"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <button
                type="button"
                disabled
                className="w-full cursor-default rounded-[10px] bg-remotiv-green py-2.5 text-[13px] font-bold text-[var(--ai-mint-ink)]"
              >
                Apply now
              </button>
              {state.description.trim() && (
                <p className="mt-3 line-clamp-4 border-t border-[var(--ai-line-soft)] pt-3 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
                  {state.description}
                </p>
              )}
            </div>
            <p className="mx-0.5 mt-[11px] text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
              Publishing makes this live on remotiv.work/jobs immediately.
            </p>

            <div className="mt-4 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] p-3.5">
              <p className="mb-1 flex items-center gap-[7px] text-[12.5px] font-semibold">
                <Lightbulb className="size-[15px] text-remotiv-green" strokeWidth={2} />
                Write once, screen forever
              </p>
              <small className="block text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
                Your screening questions power the AI recruiter on every applicant automatically.
              </small>
            </div>
          </div>
        </div>
      </PageContainer>

      {published && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.45)] p-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="published-title"
            className="w-full max-w-[420px] rounded-[22px] bg-white px-[30px] py-[34px] text-center shadow-[0_40px_100px_rgba(0,0,0,0.35)]"
          >
            <div className="mx-auto mb-4 flex size-[62px] items-center justify-center rounded-full bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]">
              <Check className="size-[30px]" strokeWidth={2.4} />
            </div>
            <h2 id="published-title" className="mb-[7px] font-heading text-[22px] font-extrabold">
              Your job is live
            </h2>
            <p className="mb-[22px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              “{published.title}” is now on remotiv.work/jobs. We&apos;ll notify you as applicants
              come in.
            </p>
            <div className="flex justify-center gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setPublished(null);
                  setState(EMPTY_JOB_INPUT);
                  setStep(1);
                  setErrors({});
                  showToast("Started a new draft");
                }}
                className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[9px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
              >
                Post another
              </button>
              <Link
                href="/ai-dashboard/jobs"
                className="inline-flex items-center gap-2 rounded-[11px] bg-remotiv-purple px-[18px] py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--ai-purple-hover)]"
              >
                View in Jobs
              </Link>
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
    </div>
  );
}

function ReviewCard({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-3.5">
      {/* A <div>, not a <p>: a <button> can't be a descendant of <p>, and the
          browser's parser silently closes the paragraph early — which is what
          the dev overlay was reporting. Classes unchanged. */}
      <div className="mb-[7px] flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--ai-t3)]">
        {label}
        <button
          type="button"
          onClick={onEdit}
          className="text-[11px] font-semibold text-remotiv-purple hover:underline"
        >
          Edit
        </button>
      </div>
      <div className="text-sm leading-relaxed text-[var(--ai-t1)]">{children}</div>
    </div>
  );
}

// ── Step 8 — Answer weighting ────────────────────────────────

/**
 * Four named stops, not a slider.
 *
 * The whole point of Less/Normal/More/Most is that a company which does not
 * care never has to make a fine-grained decision — a slider would demand one.
 * Active is solid ink, matching every other segmented control in the app.
 */
function WeightSegment({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (stored: number) => void;
  label: string;
}) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex shrink-0 overflow-hidden rounded-[9px] border border-[var(--ai-line-strong)] p-0"
    >
      {WEIGHT_STOPS.map((stop) => {
        const active = stopForStored(value).stored === stop.stored;
        return (
          <button
            key={stop.stored}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(stop.stored)}
            className={`px-[11px] py-[6px] text-[11.5px] font-semibold transition-colors ${
              active
                ? "bg-[var(--ai-sidebar)] text-white"
                : "bg-[var(--ai-surface)] text-[var(--ai-t3)] hover:bg-[var(--ai-inset)]"
            }`}
          >
            {stop.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** The colour each CV dimension carries in the share bar and its row dot. */
const SHARE_COLOURS = ["#7E47FF", "#49D7A7", "#5BA8E8", "#F5C842"];

/**
 * The stacked share bar — the step's explanation, not decoration.
 *
 * Prose about what a weight "does" is far less legible than showing the score
 * being divided up. The bar animates on change so moving one segment visibly
 * takes share from the others, which is the fact that matters and the one a
 * number alone does not convey.
 */
function ShareBar({ shares, labels }: { shares: number[]; labels: string[] }) {
  return (
    <>
      <div className="flex h-[9px] w-full overflow-hidden rounded-full bg-[var(--ai-inset)]">
        {shares.map((share, i) => (
          <div
            key={labels[i]}
            className="h-full transition-[width] duration-300 ease-out"
            style={{
              width: `${share}%`,
              background: SHARE_COLOURS[i % SHARE_COLOURS.length],
            }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {labels.map((label, i) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--ai-t3)]"
          >
            <span
              className="size-[7px] shrink-0 rounded-full"
              style={{ background: SHARE_COLOURS[i % SHARE_COLOURS.length] }}
            />
            {label}
            <b className="font-semibold text-[var(--ai-t1)]">{shares[i]}%</b>
          </span>
        ))}
      </div>
    </>
  );
}

function WeightingStep({
  state,
  onCvWeight,
  onQuestionWeight,
  onResetCv,
  onResetQuestions,
}: {
  state: CompanyJobInput;
  onCvWeight: (key: CvWeightKey, stored: number) => void;
  onQuestionWeight: (id: string, stored: number) => void;
  onResetCv: () => void;
  onResetQuestions: () => void;
}) {
  const cvStored = CV_WEIGHT_DIMENSIONS.map((d) => state[d.key]);
  const cvShares = weightShares(cvStored);
  const cvEqual = weightsAreEqual(cvStored);

  const questions = state.interview_questions;
  const questionStored = questions.map((q) => Number(q.weight));
  const questionsEqual = weightsAreEqual(questionStored);

  /** "X carries the most weight, at N% of the score." */
  const leadIndex = cvShares.reduce((best, share, i) => (share > cvShares[best] ? i : best), 0);

  return (
    <>
      <section className="mb-7">
        <h3 className="mb-1 font-heading text-[15px] font-extrabold tracking-[-0.02em]">
          CV score
        </h3>
        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          A dimension set to <b>Most</b> counts three times as much as a <b>Normal</b> one;{" "}
          <b>Less</b> counts half.
        </p>

        <div className="mb-5 flex flex-col gap-2.5">
          {CV_WEIGHT_DIMENSIONS.map((d, i) => (
            <div
              key={d.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3.5 py-3"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className="size-[9px] shrink-0 rounded-full"
                  style={{ background: SHARE_COLOURS[i] }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-[var(--ai-t1)]">
                    {d.label}
                  </span>
                  <span className="block text-[11.5px] text-[var(--ai-t3)]">{d.hint}</span>
                </span>
              </span>
              <WeightSegment
                label={d.label}
                value={Number(state[d.key] ?? CV_WEIGHT_DEFAULT)}
                onChange={(stored) => onCvWeight(d.key, stored)}
              />
            </div>
          ))}
        </div>

        <div className="rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3.5">
          <ShareBar shares={cvShares} labels={CV_WEIGHT_DIMENSIONS.map((d) => d.label)} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-[var(--ai-t2)]">
              {cvEqual
                ? "All four count equally."
                : `${CV_WEIGHT_DIMENSIONS[leadIndex].label} carries the most weight, at ${cvShares[leadIndex]}% of the score.`}
            </p>
            <button
              type="button"
              onClick={onResetCv}
              disabled={cvEqual}
              className="rounded-[9px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[6px] text-[11.5px] font-semibold text-[var(--ai-t2)] transition-colors enabled:hover:bg-[var(--ai-surface)] enabled:hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-heading text-[15px] font-extrabold tracking-[-0.02em]">
          Interview questions
        </h3>
        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          A question set to <b>Most</b> counts three times as much as a <b>Normal</b> one;{" "}
          <b>Less</b> counts half. Questions are edited in step 5 — this only changes what they are
          worth.
        </p>

        {questions.length === 0 ? (
          <p className="rounded-[13px] border border-dashed border-[var(--ai-line-strong)] px-3.5 py-5 text-center text-[12.5px] text-[var(--ai-t3)]">
            No interview questions yet. Add them in step 5 and they will appear here to weight.
          </p>
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-2">
              {questions.map((q, i) => (
                <div
                  key={q.id || `new-${i}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3.5 py-2.5"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-[var(--ai-inset)] text-[11px] font-bold text-[var(--ai-t2)]">
                      {i + 1}
                    </span>
                    <span className="min-w-0 truncate text-[12.5px] text-[var(--ai-t1)]">
                      {q.question.trim() || "Untitled question"}
                    </span>
                  </span>
                  <WeightSegment
                    label={`Question ${i + 1} weight`}
                    value={Number(q.weight) || CV_WEIGHT_DEFAULT}
                    onChange={(stored) => onQuestionWeight(q.id, stored)}
                  />
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-[var(--ai-t2)]">
                {questionsEqual
                  ? "Every question counts equally."
                  : "Some questions count more than others."}
              </p>
              <button
                type="button"
                onClick={onResetQuestions}
                disabled={questionsEqual}
                className="rounded-[9px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[6px] text-[11.5px] font-semibold text-[var(--ai-t2)] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reset
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ── Step 9 — Auto-shortlist ──────────────────────────────────

/**
 * The promise box leads the step at full size.
 *
 * Not a hint under the toggle and not a tooltip: the entire feature rests on
 * "this never acts on its own", and a claim that carries that much weight has
 * to be the first thing read, before the switch that turns it on. Flat ink
 * card, no purple glow — the glow reads as marketing and this is a guarantee.
 */
function PromiseBox() {
  return (
    <div className="mb-6 rounded-[16px] bg-[var(--ai-sidebar)] px-[18px] py-[17px]">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-px size-[19px] shrink-0 text-remotiv-lime" strokeWidth={1.9} />
        <div className="min-w-0">
          <p className="mb-1 font-heading text-[14.5px] font-extrabold tracking-[-0.02em] text-white">
            Flagging only. Nothing moves on its own.
          </p>
          <p className="mb-3 text-[12.5px] leading-relaxed text-white/[0.72]">
            Auto-shortlist marks strong applicants so they are easy to find. It never changes
            anyone&apos;s stage, never messages a candidate and never rejects.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {["Flags only", "Never moves a stage", "Never rejects"].map((c) => (
              <span
                key={c}
                className="rounded-full border border-remotiv-green/50 px-2.5 py-[3px] text-[11px] font-semibold text-remotiv-green"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Hint under "Flag based on", rewritten per choice. */
const SOURCE_HINTS: Record<AutoshortlistSource, string> = {
  both: "Either score reaching its mark flags the candidate, so a strong CV shows up before they have interviewed.",
  cv: "Only the CV score flags. Interview scores are ignored for this job.",
  interview:
    "Only the interview score flags. Candidates who have not recorded one yet are never flagged.",
};

function ThresholdField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLS}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={0}
          max={100}
          value={value ?? ""}
          placeholder={String(AUTOSHORTLIST_DEFAULT_THRESHOLD)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (!raw) {
              onChange(null);
              return;
            }
            const n = Number.parseInt(raw, 10);
            onChange(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null);
          }}
          className={`${INPUT_CLS} max-w-[120px]`}
        />
        <span className="text-[12px] text-[var(--ai-t3)]">out of 100</span>
      </div>
    </div>
  );
}

function AutoshortlistStep({
  state,
  set,
}: {
  state: CompanyJobInput;
  set: <K extends keyof CompanyJobInput>(key: K, value: CompanyJobInput[K]) => void;
}) {
  const enabled = state.autoshortlist_source !== null;
  const source: AutoshortlistSource = state.autoshortlist_source ?? "both";
  const showCv = source === "cv" || source === "both";
  const showInterview = source === "interview" || source === "both";

  const [estimate, setEstimate] = useState<{
    matched: number;
    total: number;
  } | null>(null);
  const [estimating, setEstimating] = useState(false);

  const cvMark = state.autoshortlist_cv_threshold;
  const interviewMark = state.autoshortlist_interview_threshold;

  /*
   * ── Debounced, and the LAST answer wins ──
   *
   * One round trip per settled edit rather than one per keystroke. `cancelled`
   * matters as much as the timer: a slow earlier request must not overwrite the
   * result of a later one, which is exactly how a dragged mark ends up showing
   * a count from two values ago.
   */
  useEffect(() => {
    if (!enabled) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setEstimating(true);
    const timer = setTimeout(() => {
      estimateAutoshortlistReach({
        source,
        cvThreshold: showCv ? cvMark : null,
        interviewThreshold: showInterview ? interviewMark : null,
      })
        .then((r) => {
          if (!cancelled) setEstimate(r);
        })
        .catch(() => {
          if (!cancelled) setEstimate(null);
        })
        .finally(() => {
          if (!cancelled) setEstimating(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, source, showCv, showInterview, cvMark, interviewMark]);

  return (
    <>
      <PromiseBox />

      <div className="mb-5 flex items-start justify-between gap-4 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--ai-t1)]">
            Flag strong applicants automatically
          </p>
          <p className="text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            Off by default. Nothing is flagged until you turn this on.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Flag strong applicants automatically"
          onClick={() => {
            if (enabled) {
              // Switching off clears the marks too — a stored threshold with no
              // source is invisible in the UI and would reappear months later.
              set("autoshortlist_source", null);
              set("autoshortlist_cv_threshold", null);
              set("autoshortlist_interview_threshold", null);
              return;
            }
            set("autoshortlist_source", "both");
            set("autoshortlist_cv_threshold", AUTOSHORTLIST_DEFAULT_THRESHOLD);
            set("autoshortlist_interview_threshold", AUTOSHORTLIST_DEFAULT_THRESHOLD);
          }}
          className={`relative h-[24px] w-[42px] shrink-0 rounded-full transition-colors ${
            enabled ? "bg-remotiv-purple" : "bg-[var(--ai-line-strong)]"
          }`}
        >
          <span
            className={`absolute top-[3px] size-[18px] rounded-full bg-white transition-[left] ${
              enabled ? "left-[21px]" : "left-[3px]"
            }`}
          />
        </button>
      </div>

      {/* Everything below dims and stops responding until the toggle is on. */}
      <div
        className={
          enabled ? "" : "pointer-events-none select-none opacity-40 [&_*]:cursor-not-allowed"
        }
        aria-hidden={!enabled}
      >
        <div className="mb-5">
          <label htmlFor="as-source" className={LABEL_CLS}>
            Flag based on
          </label>
          <select
            id="as-source"
            value={source}
            disabled={!enabled}
            onChange={(e) => {
              const next = e.target.value as AutoshortlistSource;
              set("autoshortlist_source", next);
              // A hidden input's mark is cleared rather than left behind, so the
              // stored row can never imply a bar that is never consulted.
              if (next === "cv") set("autoshortlist_interview_threshold", null);
              if (next === "interview") set("autoshortlist_cv_threshold", null);
              if (next !== "interview" && cvMark === null) {
                set("autoshortlist_cv_threshold", AUTOSHORTLIST_DEFAULT_THRESHOLD);
              }
              if (next !== "cv" && interviewMark === null) {
                set("autoshortlist_interview_threshold", AUTOSHORTLIST_DEFAULT_THRESHOLD);
              }
            }}
            className={INPUT_CLS}
          >
            <option value="both">{AUTOSHORTLIST_SOURCE_LABELS.both} — CV or interview</option>
            <option value="cv">{AUTOSHORTLIST_SOURCE_LABELS.cv}</option>
            <option value="interview">{AUTOSHORTLIST_SOURCE_LABELS.interview}</option>
          </select>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            {SOURCE_HINTS[source]}
          </p>
        </div>

        {/* One column when a single source is selected — an empty second
            column would imply a mark that is not being used. */}
        <div
          className={`mb-5 grid gap-4 ${
            showCv && showInterview ? "grid-cols-1 min-[560px]:grid-cols-2" : "grid-cols-1"
          }`}
        >
          {showCv && (
            <ThresholdField
              id="as-cv-mark"
              label="CV score mark"
              value={cvMark}
              onChange={(v) => set("autoshortlist_cv_threshold", v)}
            />
          )}
          {showInterview && (
            <ThresholdField
              id="as-interview-mark"
              label="Interview score mark"
              value={interviewMark}
              onChange={(v) => set("autoshortlist_interview_threshold", v)}
            />
          )}
        </div>

        <div className="mb-5 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
            {estimateCopy(estimate, estimating)}
          </p>
        </div>

        <div>
          <p className={LABEL_CLS}>How they will look</p>
          <div className="flex flex-col gap-2">
            <PreviewRow kind="top" name="Ayesha Khan" sub="Scored 94 — the AI's own ranking" />
            <PreviewRow
              kind="look"
              name="Bilal Ahmed"
              sub={
                showInterview && typeof interviewMark === "number"
                  ? `Interview scored ${Math.min(100, interviewMark + 9)} — above your mark of ${interviewMark}`
                  : typeof cvMark === "number"
                    ? `CV scored ${Math.min(100, cvMark + 9)} — above your mark of ${cvMark}`
                    : "Set a mark to see this"
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The estimate's copy, including the state that matters most.
 *
 * A workspace with no applicants must NOT read "0 of 0 would be flagged" — that
 * says the marks are wrong when the truth is there is nothing to measure yet.
 * It also says "in this workspace" explicitly, because the count is workspace-
 * wide rather than scoped to the job being edited, and a reader would otherwise
 * reasonably assume it was about this job.
 */
function estimateCopy(
  estimate: { matched: number; total: number } | null,
  estimating: boolean,
): React.ReactNode {
  if (estimating && !estimate) return "Counting…";
  if (!estimate) return "Set a mark to see how many applicants it would flag.";
  if (estimate.total === 0) {
    return "No applicants yet to estimate against — this will fill in once people apply.";
  }
  return (
    <>
      At these marks,{" "}
      <b className="text-[var(--ai-t1)]">
        {estimate.matched} of {estimate.total}
      </b>{" "}
      applicants in this workspace would carry the flag today.
    </>
  );
}

/**
 * A row showing what each flag looks like.
 *
 * The two must never be mistakable: Top match is the AI's own ranking, a filled
 * lime sticker; Worth a look is the company's rule, a purple OUTLINE chip on a
 * faint purple row with a left accent. Same shape, different voice.
 */
function PreviewRow({ kind, name, sub }: { kind: "top" | "look"; name: string; sub: string }) {
  const isLook = kind === "look";
  return (
    <div
      className={`flex items-center gap-3 rounded-[11px] border px-3 py-2.5 ${
        isLook
          ? "border-remotiv-purple/25 bg-remotiv-purple/[0.035] border-l-[3px] border-l-remotiv-purple"
          : "border-[var(--ai-line)] bg-[var(--ai-surface)]"
      }`}
    >
      <span
        className={`flex size-[30px] shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold ${
          isLook
            ? "bg-[var(--ai-inset)] text-[var(--ai-t2)]"
            : "bg-[var(--ai-inset)] text-[var(--ai-t2)] ring-2 ring-remotiv-green"
        }`}
      >
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-[var(--ai-t1)]">
          {name}
        </span>
        <span className="block truncate text-[11.5px] text-[var(--ai-t3)]">{sub}</span>
      </span>
      {isLook ? (
        <span className="shrink-0 rounded-full border border-remotiv-purple/45 bg-remotiv-purple/[0.06] px-2.5 py-[3px] text-[10.5px] font-bold text-remotiv-purple">
          Worth a look
        </span>
      ) : (
        <span className="shrink-0 rounded-[6px] bg-remotiv-lime px-2.5 py-[3px] text-[10.5px] font-extrabold text-[var(--ai-t1)]">
          Top match
        </span>
      )}
    </div>
  );
}

// ── Step 7 — AI scoring criteria ─────────────────────────────

/**
 * Named must-haves, and deliberately NOT a free-text box.
 *
 * A textarea here would be handed to the scoring prompt, and free-form guidance
 * is exactly how "reject anyone under five years" gets back in. Nine prompt
 * versions went into removing hard rules, auto-rejection and keyword gates; a
 * list of named items gives a company the control they actually want — "tell me
 * whether this person has done X" — without a channel for rewriting the rubric.
 *
 * Empty stays valid and is the default. A job with no must-haves produces a
 * prompt with no must-have block at all, so it scores exactly as it did before
 * this step existed.
 */
function ScoringCriteriaStep({
  state,
  onChange,
  onChangeCriteria,
  canPrefill,
  seededRef,
}: {
  state: CompanyJobInput;
  onChange: (next: string[]) => void;
  onChangeCriteria: (next: string[]) => void;
  /** False in edit mode — a saved job opens on what was saved, full stop. */
  canPrefill: boolean;
  /** Owned by WizardClient so it survives leaving the step and coming back. */
  seededRef: React.RefObject<boolean>;
}) {
  const items = state.scoring_must_haves;
  const criteria = state.interview_criteria;
  const [draft, setDraft] = useState("");
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const full = items.length >= MUST_HAVE_MAX;
  const criteriaFull = criteria.length >= INTERVIEW_CRITERIA_MAX;
  const hasInterview = state.interview_questions.length > 0;

  /*
   * ONE split feeds BOTH lists.
   *
   * The same lines from step 2 are classified once — trait-shaped to the
   * interview list, everything else to the CV list — so a line can never be
   * offered twice, and neither list falls back to the other. `existing` spans
   * both for the same reason.
   */
  const suggestions = useMemo(
    () =>
      suggestCriteria({
        requirements: state.requirements,
        responsibilities: state.responsibilities,
        existing: [...items, ...criteria],
      }),
    [state.requirements, state.responsibilities, items, criteria],
  );

  /*
   * ── Open with the work already done ──
   *
   * The step used to open empty, which made it read as a task rather than a
   * setting: a recruiter with nothing to add still had to decide what to type.
   * It now opens with the top MUST_HAVE_MAX suggestions from step 2 already
   * ADDED, so the job is to edit or delete — and Continue without touching
   * anything is a complete, sensible answer.
   *
   * Three guards, and all three matter:
   *   · `canPrefill` is false in edit mode, so a saved list — including a
   *     deliberately empty one — is never re-derived over.
   *   · `items.length === 0` means a partially-filled list is left alone.
   *   · `seededRef` fires once per session, so clearing all three and stepping
   *     away does not bring them back on return.
   */
  useEffect(() => {
    if (seededRef.current) return;
    if (!canPrefill || items.length > 0 || criteria.length > 0) return;
    seededRef.current = true;
    const seedCv = suggestions.cv.slice(0, MUST_HAVE_MAX);
    if (seedCv.length > 0) onChange(seedCv);
    // Behavioural criteria only pre-fill when there is an interview to check
    // them against — otherwise the job carries a list nothing will ever read.
    if (hasInterview) {
      const seedCriteria = suggestions.interview.slice(0, INTERVIEW_CRITERIA_MAX);
      if (seedCriteria.length > 0) onChangeCriteria(seedCriteria);
    }
  }, [
    canPrefill,
    items.length,
    criteria.length,
    hasInterview,
    suggestions,
    onChange,
    onChangeCriteria,
    seededRef,
  ]);

  function addCriterion(value: string) {
    const item = value.replace(/\s+/g, " ").trim().slice(0, MUST_HAVE_MAX_LENGTH);
    if (!item || criteriaFull) return;
    if (criteria.some((v) => v.toLowerCase() === item.toLowerCase())) return;
    onChangeCriteria([...criteria, item]);
    setCriteriaDraft("");
  }

  function add(value: string) {
    const item = value.replace(/\s+/g, " ").trim().slice(0, MUST_HAVE_MAX_LENGTH);
    if (!item || full) return;
    // Case-insensitive, so "React" cannot sit beside "react".
    if (items.some((v) => v.toLowerCase() === item.toLowerCase())) return;
    onChange([...items, item]);
    setDraft("");
  }

  return (
    <>
      {/* Shows rather than tells. The abstract version of this sentence tested
          as "work": a recruiter could not picture what a must-have produced, so
          the step read as another form to fill in. Two sample lines answer it
          in the shape they will actually see on a scorecard. */}
      <div className="mb-5 rounded-[13px] border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3.5 py-3.5">
        <p className="m-0 mb-2.5 text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
          Every scorecard for this role will say whether the CV evidences each of these, and quote
          the line that proves it.
        </p>

        <div className="rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5">
          <p className="m-0 mb-2 text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--ai-t4)]">
            On the scorecard
          </p>
          <div className="flex items-start gap-2">
            <Check className="mt-px size-[13px] shrink-0 text-remotiv-green" strokeWidth={2.6} />
            <p className="m-0 min-w-0 text-[12px] leading-relaxed text-[var(--ai-t2)]">
              Has shipped a production React app
              <span className="mt-0.5 block border-l-2 border-[var(--ai-line-strong)] pl-2 text-[11.5px] italic text-[var(--ai-t3)]">
                “Led the rebuild of the customer dashboard in React and TypeScript”
              </span>
            </p>
          </div>
          <div className="mt-2 flex items-start gap-2">
            <X className="mt-px size-[13px] shrink-0 text-[var(--ai-t4)]" strokeWidth={2.6} />
            <p className="m-0 min-w-0 text-[12px] leading-relaxed text-[var(--ai-t2)]">
              Has managed a team
              <span className="mt-0.5 block text-[11.5px] text-[var(--ai-t3)]">
                Not found in this CV
              </span>
            </p>
          </div>
        </div>

        <p className="m-0 mt-2.5 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
          A missing one is reported, never punished — it does not reject anyone, filter anyone out,
          or lower a score.
        </p>
      </div>

      <label htmlFor="must-have-input" className={LABEL_CLS}>
        Must-haves{" "}
        <span className="font-normal text-[var(--ai-t3)]">
          — {items.length} of {MUST_HAVE_MAX}. Edit or remove any you don&apos;t want.
        </span>
      </label>
      <div className="flex gap-2">
        <input
          id="must-have-input"
          value={draft}
          disabled={full}
          maxLength={MUST_HAVE_MAX_LENGTH}
          placeholder={
            full
              ? `That's ${MUST_HAVE_MAX} — remove one to add another`
              : "A skill, tool or experience a strong candidate shows"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // The wizard's footer button is not a submit, but a stray Enter
            // inside a form still triggers navigation on some browsers.
            e.preventDefault();
            add(draft);
          }}
          className={INPUT_CLS}
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={full || !draft.trim()}
          className="shrink-0 rounded-[11px] bg-[var(--ai-sidebar)] px-4 py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-[#241d38] disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {items.length > 0 && (
        <ul className="mt-3 flex list-none flex-col gap-2 p-0">
          {items.map((item, i) => (
            <li
              key={item}
              className="flex items-center justify-between gap-3 rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-[var(--ai-inset)] text-[11px] font-bold text-[var(--ai-t2)]">
                  {i + 1}
                </span>
                <span className="min-w-0 break-words text-[13px] text-[var(--ai-t1)]">{item}</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onChange(items.filter((v) => v !== item))}
                className="shrink-0 rounded-lg p-1.5 text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-danger)]"
              >
                <Trash className="size-[15px]" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <p className={LABEL_CLS}>From what you wrote in step 2</p>
        {suggestions.cv.length === 0 ? (
          <p className="m-0 text-[12px] leading-relaxed text-[var(--ai-t3)]">
            {state.requirements.trim() || state.responsibilities.trim()
              ? "Nothing here reads as a separate requirement — add must-haves above in your own words."
              : "Add requirements or responsibilities in step 2 and they'll show up here as suggestions."}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {suggestions.cv.map((sug: string) => (
              <button
                key={sug}
                type="button"
                disabled={full}
                onClick={() => add(sug)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[6px] text-[12px] text-[var(--ai-t2)] transition-colors hover:border-remotiv-purple/50 hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="size-[13px] shrink-0" strokeWidth={2.2} />
                <span className="min-w-0 truncate">{sug}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {items.length === 0 && (
        <p className="mt-6 rounded-[13px] border border-dashed border-[var(--ai-line-strong)] px-3.5 py-4 text-center text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
          No must-haves is a perfectly good answer — this job will score exactly as it does today.
        </p>
      )}

      {/* ── Second list, same step ──
          Same step rather than a tenth, because both come from ONE split of the
          same step-2 text and separating them would hide that. Step 8 already
          reads "CV score" then "Interview questions", so this is the shape the
          wizard already uses for exactly this pair of sources. */}
      <div className="mt-8 border-t border-[var(--ai-line)] pt-6">
        <p className={LABEL_CLS}>
          Behavioural criteria — checked against the interview{" "}
          <span className="font-normal text-[var(--ai-t3)]">
            — {criteria.length} of {INTERVIEW_CRITERIA_MAX}
          </span>
        </p>
        <p className="m-0 mb-3 text-[12px] leading-relaxed text-[var(--ai-t3)]">
          Things a conversation shows and a CV cannot — how someone follows up, handles pressure,
          explains their thinking. Checked against what they actually said, and reported the same
          way: quoted, or not found.
        </p>

        {!hasInterview && (
          <p className="mb-3 rounded-[13px] border border-dashed border-[var(--ai-line-strong)] px-3.5 py-4 text-[12.5px] leading-relaxed text-[var(--ai-t3)]">
            This job has no interview questions yet, so there is no transcript to check these
            against. Add questions in step 5 and this section becomes live — anything saved here is
            kept either way.
          </p>
        )}

        {criteria.length > 0 && (
          <ul className="mb-3 flex list-none flex-col gap-2 p-0">
            {criteria.map((item, i) => (
              <li
                key={item}
                className="flex items-center justify-between gap-3 rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-[var(--ai-inset)] text-[11px] font-bold text-[var(--ai-t2)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 break-words text-[13px] text-[var(--ai-t1)]">
                    {item}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  onClick={() => onChangeCriteria(criteria.filter((v) => v !== item))}
                  className="shrink-0 rounded-lg p-1.5 text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-danger)]"
                >
                  <Trash className="size-[15px]" strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <input
            id="criterion-input"
            aria-label="Add a behavioural criterion"
            value={criteriaDraft}
            disabled={!hasInterview || criteriaFull}
            maxLength={MUST_HAVE_MAX_LENGTH}
            placeholder={
              criteriaFull
                ? `That's ${INTERVIEW_CRITERIA_MAX} — remove one to add another`
                : "A behaviour an interview would reveal"
            }
            onChange={(e) => setCriteriaDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addCriterion(criteriaDraft);
            }}
            className={INPUT_CLS}
          />
          <button
            type="button"
            onClick={() => addCriterion(criteriaDraft)}
            disabled={!hasInterview || criteriaFull || !criteriaDraft.trim()}
            className="shrink-0 rounded-[11px] bg-[var(--ai-sidebar)] px-4 py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-[#241d38] disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {hasInterview && suggestions.interview.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.interview.map((sug: string) => (
              <button
                key={sug}
                type="button"
                disabled={criteriaFull}
                onClick={() => addCriterion(sug)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-3 py-[6px] text-[12px] text-[var(--ai-t2)] transition-colors hover:border-remotiv-purple/50 hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="size-[13px] shrink-0" strokeWidth={2.2} />
                <span className="min-w-0 truncate">{sug}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
