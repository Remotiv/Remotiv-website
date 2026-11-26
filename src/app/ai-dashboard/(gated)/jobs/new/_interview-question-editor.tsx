import { ArrowDown, ArrowUp, Plus, Trash } from "lucide-react";
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
import { snapWeight, WEIGHT_STOPS } from "@/lib/weights";

/**
 * The job wizard's interview question editor: the empty state, one card per
 * question (text, competency, weight, scoring guide, thinking time, answer
 * limit, required), reorder and remove, "Add a question" and the length hint.
 *
 * Moved out of _wizard-client.tsx unchanged (#58 commit 2) so the AI Video
 * Interview step can reuse it for its own list. It edits whichever list it is
 * given and hands every change back through `onChange`; it stores nothing.
 *
 * The "Other..." competency reveal is held by the wizard, not here, so a row
 * left on "Other..." with nothing typed yet keeps its input open when the
 * recruiter leaves the step and comes back, as it always did.
 */

export const INPUT_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";

/**
 * Competency suggestions for the interview builder.
 *
 * Suggestions, NOT a closed set: the value is stored as plain text on
 * interview_questions.competency exactly as before, and the "Other..." option
 * below reveals a free-text input. A company hiring for something our list has
 * never heard of must not be blocked by it, so nothing validates against this
 * array - it only populates a dropdown.
 *
 * Kept with the editor rather than promoted to lib/interviews/types.ts: it is
 * a UI affordance for the person authoring the question, and no server code
 * reads it.
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

/** Sentinel for the reveal. Never stored - see the onChange below. */
const COMPETENCY_OTHER = "__other__";

function isSuggestedCompetency(value: string): boolean {
  return (COMPETENCY_SUGGESTIONS as readonly string[]).includes(value);
}

export function InterviewQuestionEditor({
  questions,
  onChange,
  otherCompetencyIds,
  onOtherCompetency,
  showWeightAndTiming = true,
  maxQuestions = MAX_QUESTIONS,
}: {
  /** The list this editor edits. */
  questions: InterviewQuestionInput[];
  /** Every change to that list, whole. */
  onChange: (next: InterviewQuestionInput[]) => void;
  /** Rows whose competency is being typed freehand (held by the wizard). */
  otherCompetencyIds: ReadonlySet<string>;
  onOtherCompetency: (id: string, on: boolean) => void;
  /** Weight, thinking time and answer limit. Shown by default, as on step 5. */
  showWeightAndTiming?: boolean;
  maxQuestions?: number;
}) {
  function usesOtherCompetency(q: InterviewQuestionInput): boolean {
    if (otherCompetencyIds.has(q.id)) return true;
    return q.competency !== "" && !isSuggestedCompetency(q.competency);
  }
  const setOtherCompetency = onOtherCompetency;

  function addInterviewQ() {
    if (questions.length >= maxQuestions) return;
    onChange([...questions, { ...EMPTY_QUESTION_INPUT, id: `new-${crypto.randomUUID()}` }]);
  }

  function patchInterviewQ(index: number, patch: Partial<InterviewQuestionInput>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  function removeInterviewQ(index: number) {
    onChange(questions.filter((_, i) => i !== index));
  }

  /** Move one question up or down. Order IS the candidate's running order. */
  function moveInterviewQ(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= questions.length) return;
    const copy = [...questions];
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onChange(copy);
  }

  return (
    <>
      {questions.length === 0 && (
        <div className="mb-3 rounded-[14px] border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] px-4 py-5 text-center">
          <p className="m-0 text-[13.5px] font-semibold text-[var(--ai-t2)]">
            No interview questions yet
          </p>
          <p className="m-0 mt-1.5 text-xs leading-relaxed text-[var(--ai-t3)]">
            Add {MIN_QUESTIONS}-{maxQuestions}. Candidates answer each one on camera in their own
            time - there&apos;s no call to schedule. Leave this empty to skip the video round for
            this job.
          </p>
        </div>
      )}

      {questions.map((q, i) => (
        <div
          key={q.id}
          className="mb-3 rounded-[14px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3.5 transition-shadow hover:shadow-[0_4px_16px_rgba(20,16,32,0.06)]"
        >
          <div className="mb-[11px] flex items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-purple-tint)] text-xs font-bold text-[var(--ai-purple-ink)]">
              {i + 1}
            </span>
            <span className="flex-1 text-[11px] font-semibold text-[var(--ai-t3)]">
              Question {i + 1} of {questions.length}
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
              disabled={i === questions.length - 1}
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
            {showWeightAndTiming && (
              <div>
                <span className="mb-1.5 block text-[11px] font-semibold text-[var(--ai-t3)]">
                  Weight
                </span>
                {/* The four stops step 8 uses (weights.ts), with its labels.
                    Shown rounded the way the save rounds (snapWeight), so a
                    question at Most reads Most here, and a value that is not
                    a stop reads Normal, which is what it would save as. */}
                <select
                  value={String(snapWeight(q.weight))}
                  onChange={(e) => patchInterviewQ(i, { weight: e.target.value })}
                  aria-label={`Weight for question ${i + 1}`}
                  className={`${INPUT_CLS} cursor-pointer appearance-none`}
                >
                  {WEIGHT_STOPS.map((stop) => (
                    <option key={stop.stored} value={String(stop.stored)}>
                      {stop.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

          {showWeightAndTiming && (
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
                    onChange={(e) => patchInterviewQ(i, { answerSeconds: e.target.value })}
                    aria-label={`Answer limit for question ${i + 1}, seconds`}
                    className={`${INPUT_CLS} flex-1`}
                  />
                  <span className="shrink-0 text-xs text-[var(--ai-t3)]">sec</span>
                </div>
              </div>
            </div>
          )}

          <label className="mt-3 flex cursor-pointer items-center gap-2.5">
            <input
              type="checkbox"
              checked={q.required}
              onChange={(e) => patchInterviewQ(i, { required: e.target.checked })}
              className="size-4 shrink-0 accent-[var(--remotiv-purple,#7E47FF)]"
            />
            <span className="text-[12.5px] text-[var(--ai-t2)]">
              Required - the candidate can&apos;t submit without it
            </span>
          </label>
        </div>
      ))}

      <button
        type="button"
        onClick={addInterviewQ}
        disabled={questions.length >= maxQuestions}
        className="flex w-full items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-transparent px-4 py-3 text-[13px] font-bold text-[var(--ai-t2)] transition-colors hover:border-solid hover:border-remotiv-purple hover:bg-[var(--ai-purple-tint)] hover:text-remotiv-purple disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus className="size-4" strokeWidth={2.4} />
        {questions.length >= maxQuestions
          ? `That's the maximum of ${maxQuestions}`
          : "Add a question"}
      </button>

      <p className="mt-3 text-xs leading-relaxed text-[var(--ai-t3)]">
        {MIN_QUESTIONS}-{maxQuestions} questions works best - long enough to judge, short enough
        that people finish. Candidates get a practice round first, which is never recorded or
        shared.
      </p>
    </>
  );
}
