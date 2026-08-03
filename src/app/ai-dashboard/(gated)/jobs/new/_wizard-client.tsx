"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Lightbulb,
  Lock,
  MapPin,
  Plus,
  Settings2,
  Trash2,
  Zap,
} from "lucide-react";
import type { ScreeningQuestion } from "@/lib/jobs";
// Value import MUST come from lib/screening, not lib/jobs: this is a client
// component and lib/jobs pulls in next/headers via getInitialJobs.
import { resolveNumericMode, type NumericMode } from "@/lib/screening";
import {
  EMPTY_JOB_INPUT,
  JOB_CATEGORIES,
  JOB_CONTRACT_TYPES,
  JOB_CURRENCIES,
  JOB_EXPERIENCE_LEVELS,
  JOB_INTERVIEWER_NAME_MAX,
  JOB_TEXT_COUNTER_FROM,
  JOB_TEXT_MAX,
  JOB_WORK_TYPES,
  type CompanyJobInput,
  type JobCurrency,
} from "@/app/ai-dashboard/lib/job-types";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { createCompanyJob, updateCompanyJob } from "../actions";

// ── Constants ────────────────────────────────────────────────

const STEPS = [
  { n: 1, label: "Basics", title: "Basics", desc: "This is what candidates see first on Remotiv." },
  { n: 2, label: "Description", title: "Description", desc: "Tell candidates what the role is and who it's for." },
  { n: 3, label: "Compensation", title: "Compensation", desc: "Transparent pay attracts stronger applicants." },
  { n: 4, label: "Screening", title: "Screening", desc: "Questions your AI recruiter asks every applicant." },
  { n: 5, label: "Review", title: "Review", desc: "One last look before it goes live." },
] as const;

const LOCKED_STEPS = [
  { n: 6, label: "AI scoring" },
  { n: 7, label: "Interview questions" },
  { n: 8, label: "Answer weighting" },
  { n: 9, label: "Auto-shortlist" },
] as const;

const LAST_STEP = 5;

const INPUT_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const INPUT_ERR_CLS =
  "border-[#E0524B] ring-[3px] ring-[#E0524B]/[0.14] focus:border-[#E0524B]";
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
 *   .step.locked -> STEP_ROW_LOCKED (dimmed, no hover surface)
 */
const STEP_ROW =
  "mb-0.5 flex w-full items-center gap-[11px] rounded-[11px] border border-transparent px-2.5 py-[9px] text-left transition-colors";
const STEP_ROW_IDLE = "hover:bg-white/[0.06]";
const STEP_ROW_ACTIVE = "border-white/[0.14] bg-white/[0.11]";
const STEP_ROW_LOCKED = "cursor-not-allowed opacity-40";

const STEP_NUM =
  "flex size-[23px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11.5px] font-bold transition-colors";
const STEP_NUM_IDLE = "border-white/[0.22] text-white/50";
const STEP_NUM_ACTIVE = "border-remotiv-purple bg-remotiv-purple text-white";
const STEP_NUM_DONE = "border-remotiv-green bg-remotiv-green text-[var(--ai-mint-ink)]";

const STEP_LAB = "text-[13px] font-semibold";

/*
 * "More options" honesty markers.
 *
 * Four of the five options are stored today but read by nothing until video
 * interviews ship. They stay fully editable — the company IS really saving the
 * setting — so a disabled control would be the lie. Instead every one of them
 * carries the SAME amber pill, and AI CV scoring carries a mint one, so the
 * two states read as a deliberate pair rather than one row missing a label.
 */
const PILL = "shrink-0 rounded-full px-[7px] py-0.5 text-[10.5px] font-bold";
const PILL_SOON = `${PILL} bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]`;
const PILL_LIVE = `${PILL} bg-[var(--ai-mint-tint)] text-[var(--ai-mint-ink)]`;
const SOON_LABEL = "When interviews launch";
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

const QUESTION_IDEAL_ERROR: Record<
  ScreeningQuestion["type"],
  (n: number) => string
> = {
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
          <span className="shrink-0 text-[var(--ai-t4)]">
            Max {JOB_TEXT_MAX.toLocaleString()}
          </span>
        )
      )}
    </p>
  );
}

/** Small explanatory line under a screening-question control. */
function FieldHint({ text }: { text: string }) {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--ai-t3)]">{text}</p>
  );
}

function Toggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
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
            <span className="text-[13.5px] font-semibold text-[var(--ai-t1)]">
              {title}
            </span>
            <span className={live ? PILL_LIVE : PILL_SOON}>
              {live ? LIVE_LABEL : SOON_LABEL}
            </span>
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
      <p className="mt-[7px] text-xs leading-relaxed text-[var(--ai-t3)]">
        Shown to candidates. Up to {JOB_INTERVIEWER_NAME_MAX} characters.
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

  const [state, setState] = useState<CompanyJobInput>(
    initialState ?? EMPTY_JOB_INPUT,
  );
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
  const originalTypesRef = useRef<Record<string, ScreeningQuestion["type"]>>(
    Object.fromEntries(
      (initialState?.screening_questions ?? []).map((q) => [q.id, q.type]),
    ),
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
    for (let k = step; k < target; k++) {
      if (!validate(k)) {
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
      ? options.map((o) => o.trim()).filter(Boolean).indexOf(previous)
      : -1;
    patchQuestion(index, {
      options,
      ideal: nextIdx >= 0 ? String(nextIdx) : "",
    });
  }

  /** Red ring on an ideal field the publish gate flagged. */
  function idealCls(q: ScreeningQuestion): string {
    return errors[`${QUESTION_ERR_PREFIX}${q.id}`]
      ? `${INPUT_CLS} ${INPUT_ERR_CLS}`
      : INPUT_CLS;
  }

  function removeQuestion(index: number) {
    set(
      "screening_questions",
      questions.filter((_, i) => i !== index),
    );
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
        isEdit && jobId
          ? await updateCompanyJob(jobId, payload)
          : await createCompanyJob(payload);

      if (!result.success) {
        showToast(result.error);
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

  const meta = STEPS[step - 1];

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
            <div className="relative overflow-hidden rounded-[20px] bg-[var(--ai-sidebar)] px-[18px] py-5 shadow-[0_18px_46px_rgba(20,16,32,0.24)]">
              <span
                aria-hidden
                className="pointer-events-none absolute -right-20 -top-[100px] size-[280px] rounded-full"
                style={{
                  background:
                    "radial-gradient(circle, rgba(126,71,255,0.5), transparent 68%)",
                }}
              />

              <h1 className="relative z-[1] mb-1 font-heading text-xl font-extrabold tracking-[-0.03em] text-white">
                {isEdit ? "Edit job" : "Post a job"}
              </h1>
              <p className="relative z-[1] mb-3.5 text-xs text-white/50">
                {isEdit ? "5 steps · edit any section" : "5 steps · ~4 min"}
              </p>

              {/* Lime progress bar — how far through the five steps the user is. */}
              <div className="relative z-[1] mb-[18px] h-1 overflow-hidden rounded-[3px] bg-white/[0.12]">
                <div
                  className="h-full rounded-[3px] bg-remotiv-lime transition-[width] duration-300 ease-out"
                  style={{ width: `${(step / LAST_STEP) * 100}%` }}
                />
              </div>

              <div className="relative z-[1]">
              {STEPS.map((s) => {
                const active = s.n === step;
                const done = s.n < step;
                return (
                  <button
                    key={s.n}
                    type="button"
                    onClick={() => goTo(s.n)}
                    /* `.step` + `.step.active` only. A completed step gets NO
                       row treatment — no background, border or shadow — which
                       is what stops it looking like a second active card. */
                    className={`${STEP_ROW} ${
                      active ? STEP_ROW_ACTIVE : STEP_ROW_IDLE
                    }`}
                  >
                    <span
                      /* `.step.done` styles the CIRCLE ONLY. */
                      className={`${STEP_NUM} ${
                        active
                          ? STEP_NUM_ACTIVE
                          : done
                            ? STEP_NUM_DONE
                            : STEP_NUM_IDLE
                      }`}
                    >
                      {/* Completing a step recolours the badge — the digit stays. */}
                      {s.n}
                    </span>
                    <span
                      /* `.step.active .lab` and `.step.done .lab` are the only
                         label overrides; an untouched label stays at 62%. */
                      className={`${STEP_LAB} ${
                        active
                          ? "text-white"
                          : done
                            ? "text-white/70"
                            : "text-white/[0.62]"
                      }`}
                    >
                      {s.label}
                    </span>
                  </button>
                );
              })}
              </div>

              <div className="relative z-[1] mx-1 my-2.5 h-px bg-white/10" />

              <div className="relative z-[1]">
                {LOCKED_STEPS.map((s) => (
                  <button
                    key={s.n}
                    type="button"
                    onClick={() => showToast(`${s.label} unlocks in a later release`)}
                    /* `.step.locked` — dimmed, no hover surface. */
                    className={`${STEP_ROW} ${STEP_ROW_LOCKED}`}
                  >
                    <span className={`${STEP_NUM} ${STEP_NUM_IDLE}`}>{s.n}</span>
                    <span className={`${STEP_LAB} text-white/[0.62]`}>
                      {s.label}
                    </span>
                  </button>
                ))}
              </div>

              <p className="relative z-[1] mx-2.5 mt-3 text-[11px] leading-relaxed text-white/40">
                Steps 6–9 (AI scoring, interview questions &amp; weighting) unlock
                in a later release.
              </p>
            </div>
          </div>

          {/* Form card */}
          <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
            <div className="flex items-start justify-between gap-4 px-[26px] pb-1.5 pt-[22px]">
              <div className="min-w-0">
                <h2 className="mb-[5px] font-heading text-[21px] font-extrabold tracking-[-0.025em]">
                  {meta.title}
                </h2>
                <p className="text-[13px] leading-relaxed text-[var(--ai-t3)]">
                  {meta.desc}
                </p>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-[var(--ai-purple-tint)] px-[11px] py-[5px] text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-[var(--ai-purple-ink)]">
                Step {step} of {LAST_STEP}
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
                          <option key={c} value={c}>{c}</option>
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
                          <option key={c} value={c}>{c}</option>
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
                          <option key={c} value={c}>{c}</option>
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
                          <option key={c} value={c}>{c}</option>
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
                    <CharCount value={state.description} hint="Markdown isn't supported — plain text only." />
                  </div>
                  <div className="mb-4">
                    <label htmlFor="w-resp" className={LABEL_CLS}>Responsibilities</label>
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
                    <label htmlFor="w-reqs" className={LABEL_CLS}>Requirements</label>
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
                          <Trash2 className="size-[17px]" strokeWidth={1.8} />
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
                              <option key={t.value} value={t.value}>{t.label}</option>
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
                                <option key={m.value} value={m.value}>{m.label}</option>
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
                          <AlertTriangle
                            className="mt-px size-3.5 shrink-0"
                            strokeWidth={2}
                          />
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
                        · {state.work_type} · {state.contract_type} · {state.positions}{" "}
                        opening{state.positions === "1" ? "" : "s"}
                      </span>
                    </ReviewCard>
                  </div>

                  <div className="mb-3">
                    <ReviewCard label="Compensation" onEdit={() => setStep(3)}>
                      {compensation ? (
                        <>
                          {compensation}{" "}
                          <small className="text-[var(--ai-t3)]">/mo</small>
                        </>
                      ) : (
                        <span className="text-[var(--ai-t4)]">Not shown publicly</span>
                      )}
                    </ReviewCard>
                  </div>

                  <div className="mb-3">
                    <ReviewCard label="Description" onEdit={() => setStep(2)}>
                      {state.description.trim() || (
                        <span className="text-[var(--ai-t4)]">
                          No description added yet.
                        </span>
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
                            <span className="shrink-0 font-bold text-remotiv-purple">
                              {i + 1}
                            </span>
                            <span>
                              {q.question || (
                                <span className="text-[var(--ai-t4)]">
                                  Untitled question
                                </span>
                              )}
                              {q.essential && (
                                <span className="font-bold text-remotiv-purple">
                                  {" "}· essential
                                </span>
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
                          Saved with the job and editable at any time. Anything
                          marked{" "}
                          <b className="font-bold text-[var(--ai-amber-ink)]">
                            {SOON_LABEL}
                          </b>{" "}
                          is stored now and starts working when video interviews
                          ship — it changes nothing about this job today.
                        </p>

                        <div className="grid gap-2.5">
                          <OptionRow
                            title="Allow re-recording"
                            desc="Candidates can re-record their interview before submitting."
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
                            onToggle={() =>
                              set("measure_relevancy", !state.measure_relevancy)
                            }
                          />

                          <OptionRow
                            title="AI avatar video interview"
                            desc="An AI avatar runs the first interview and records the answers."
                            on={state.avatar_interview_enabled}
                            onToggle={() =>
                              set(
                                "avatar_interview_enabled",
                                !state.avatar_interview_enabled,
                              )
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

                          <OptionRow
                            title="Async video interview"
                            desc="Candidates record answers in their own time, with no live call."
                            on={state.async_interview_enabled}
                            onToggle={() =>
                              set(
                                "async_interview_enabled",
                                !state.async_interview_enabled,
                              )
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
                  <div className="relative mt-[18px] flex items-start gap-3 overflow-hidden rounded-[15px] bg-[var(--ai-sidebar)] px-[18px] py-4">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -right-[60px] -top-[70px] size-[200px] rounded-full"
                      style={{
                        background:
                          "radial-gradient(circle, rgba(126,71,255,0.5), transparent 68%)",
                      }}
                    />
                    <Zap
                      className="relative z-[1] mt-px size-[18px] shrink-0 text-remotiv-lime"
                      strokeWidth={1.9}
                    />
                    <p className="relative z-[1] text-[13px] leading-relaxed text-white/[0.72]">
                      {isEdit ? (
                        state.status === "open" ? (
                          <>
                            <b className="font-bold text-white">
                              Changes go live on remotiv.work/jobs immediately.
                            </b>{" "}
                            Anyone viewing the post sees the updated version, and new
                            applicants are screened against these questions.
                          </>
                        ) : (
                          <>
                            <b className="font-bold text-white">
                              This job is a draft — it isn&apos;t public yet.
                            </b>{" "}
                            Saving keeps it private. Set the status to Published to put
                            it live on remotiv.work/jobs.
                          </>
                        )
                      ) : (
                        <>
                          <b className="font-bold text-white">
                            This publishes to remotiv.work/jobs immediately.
                          </b>{" "}
                          Applicants can apply right away and your AI recruiter starts
                          screening them against these questions.
                        </>
                      )}
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-4">
              <span className="text-[12.5px] font-semibold text-[var(--ai-t3)]">
                Step <b className="text-[var(--ai-t1)]">{step}</b> of {LAST_STEP}
              </span>
              <div className="flex gap-2.5">
                {step > 1 && (
                  <button
                    type="button"
                    onClick={() => setStep(step - 1)}
                    className="rounded-[11px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[9px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    if (step === LAST_STEP) {
                      // Edit keeps whatever status the job already has; only
                      // create implies "publish now".
                      submit(isEdit ? state.status : "open");
                      return;
                    }
                    if (validate(step)) setStep(step + 1);
                  }}
                  className={`inline-flex items-center gap-2 rounded-[11px] px-5 py-2.5 text-[13.5px] font-semibold text-white transition-colors disabled:opacity-60 ${
                    step === LAST_STEP
                      ? "bg-remotiv-purple shadow-[0_4px_16px_rgba(126,71,255,0.28)] hover:bg-[var(--ai-purple-hover)]"
                      : "bg-[var(--ai-sidebar)] hover:bg-[#241d38]"
                  }`}
                >
                  {step === LAST_STEP ? (
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
                Your screening questions power the AI recruiter on every applicant
                automatically.
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
            <h2
              id="published-title"
              className="mb-[7px] font-heading text-[22px] font-extrabold"
            >
              Your job is live
            </h2>
            <p className="mb-[22px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              “{published.title}” is now on remotiv.work/jobs. We&apos;ll notify you as
              applicants come in.
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
