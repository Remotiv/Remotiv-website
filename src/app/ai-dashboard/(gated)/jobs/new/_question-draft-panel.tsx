import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useId } from "react";
import { questionFairnessIssue } from "@/lib/interviews/question-fairness";
import { DRAFT_QUESTION_COUNTS } from "@/lib/interviews/types";
import {
  type DraftsAction,
  type DraftsState,
  draftBlocked,
  draftsBlocked,
} from "./question-drafts";

/**
 * "Draft questions with AI" and its review panel, under the hiring challenges
 * box (AI Video Interview, AI-Guided mode only: LiveInterviewSettings renders
 * it there and nowhere else).
 *
 * Drafts are shown HERE, apart from the job's question list. Editing,
 * reordering, removing and regenerating touch only the drafts; "Use these
 * questions" is the one way into the job, and it asks before replacing
 * questions the job already has. Each scoring guide is private.
 */

const FIELD_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[13px] py-[11px] text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]";
const LABEL_CLS = "mb-[7px] block text-xs font-semibold text-[var(--ai-t2)]";
const HINT_CLS = "mt-[7px] text-xs leading-relaxed text-[var(--ai-t3)]";
const PRIMARY_CLS =
  "rounded-[11px] bg-remotiv-purple px-4 py-2.5 text-[13px] font-bold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45";
const SECONDARY_CLS =
  "rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 py-2.5 text-[13px] font-semibold text-[var(--ai-t1)] transition-colors hover:bg-[var(--ai-inset)] disabled:cursor-not-allowed disabled:opacity-45";
const ICON_CLS =
  "flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:cursor-not-allowed disabled:opacity-35";
const BLOCK_CLS = "mt-2 text-xs leading-relaxed text-[#C4362F]";

export const DRAFT_BUTTON = "Draft questions with AI";
export const USE_DRAFTS = "Use these questions";
export const DRAFT_INPUTS_NOTE =
  "Drafted from the job title, description, required skills, seniority and hiring challenges only - never from a CV or candidate details. Nothing is added to the job until you choose Use these questions.";
export const GUIDE_PRIVATE_NOTE =
  "Private scoring guide - stays in Remotiv, never shown to Sarah or candidates.";

export function replaceConfirmText(existing: number): string {
  return `This job already has ${existing} interview question${existing === 1 ? "" : "s"}. Replace ${existing === 1 ? "it" : "them"} with these drafts?`;
}

export function QuestionDraftPanel({
  state,
  dispatch,
  ready,
  existingQuestions,
  onDraft,
}: {
  state: DraftsState;
  dispatch: (a: DraftsAction) => void;
  /** The job has a description or required skills to draft from. */
  ready: boolean;
  existingQuestions: number;
  onDraft: () => void;
}) {
  const id = useId();
  const countId = `${id}-count`;
  const hasDrafts = state.drafts.length > 0;
  const blocked = draftsBlocked(state.drafts);
  const usable = state.drafts.some((d) => d.question.trim());

  return (
    <div className="mt-4" data-question-drafts>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={countId} className={LABEL_CLS}>
            How many questions?
          </label>
          <select
            id={countId}
            value={state.count}
            disabled={state.busy}
            onChange={(e) => dispatch({ t: "count", count: Number(e.target.value) })}
            className={`${FIELD_CLS} w-28`}
          >
            {DRAFT_QUESTION_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onDraft}
          disabled={!ready || state.busy}
          className={hasDrafts ? SECONDARY_CLS : PRIMARY_CLS}
          data-draft-button
        >
          {state.busy ? "Drafting questions..." : hasDrafts ? "Regenerate" : DRAFT_BUTTON}
        </button>
      </div>
      <p className={HINT_CLS}>
        {ready ? DRAFT_INPUTS_NOTE : "Add a job description on the Description step first."}
      </p>
      {state.error && (
        <p role="alert" className={BLOCK_CLS}>
          {state.error}
        </p>
      )}

      {hasDrafts && (
        <section
          aria-label="Draft questions"
          className="mt-4 rounded-[14px] border border-dashed border-remotiv-purple/40 bg-[var(--ai-purple-tint)] p-3.5"
        >
          <p className="m-0 mb-3 text-[13px] font-bold text-[var(--ai-t1)]">
            Draft questions - review before using
          </p>
          {state.shortfall && (
            <p className="m-0 mb-3 text-xs text-[var(--ai-t2)]" data-draft-shortfall>
              {state.shortfall}
            </p>
          )}
          {state.drafts.map((d, i) => (
            <div
              key={d.id}
              className="mb-3 rounded-[12px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex-1 text-[11px] font-semibold text-[var(--ai-t3)]">
                  Draft {i + 1} of {state.drafts.length}
                </span>
                <button
                  type="button"
                  onClick={() => dispatch({ t: "move", index: i, delta: -1 })}
                  disabled={i === 0}
                  aria-label={`Move draft ${i + 1} up`}
                  className={ICON_CLS}
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ t: "move", index: i, delta: 1 })}
                  disabled={i === state.drafts.length - 1}
                  aria-label={`Move draft ${i + 1} down`}
                  className={ICON_CLS}
                >
                  <ArrowDown className="size-4" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ t: "remove", index: i })}
                  aria-label={`Remove draft ${i + 1}`}
                  className={ICON_CLS}
                >
                  <X className="size-4" strokeWidth={2} />
                </button>
              </div>
              <label htmlFor={`${id}-q-${d.id}`} className={LABEL_CLS}>
                Question
              </label>
              <textarea
                id={`${id}-q-${d.id}`}
                value={d.question}
                onChange={(e) =>
                  dispatch({ t: "edit", index: i, patch: { question: e.target.value } })
                }
                className={`${FIELD_CLS} min-h-16 resize-y leading-relaxed`}
              />
              <label htmlFor={`${id}-c-${d.id}`} className={`${LABEL_CLS} mt-2.5`}>
                Competency
              </label>
              <input
                id={`${id}-c-${d.id}`}
                value={d.competency}
                onChange={(e) =>
                  dispatch({ t: "edit", index: i, patch: { competency: e.target.value } })
                }
                className={FIELD_CLS}
              />
              <label htmlFor={`${id}-g-${d.id}`} className={`${LABEL_CLS} mt-2.5`}>
                Scoring guide
              </label>
              <textarea
                id={`${id}-g-${d.id}`}
                value={d.rubric}
                onChange={(e) =>
                  dispatch({ t: "edit", index: i, patch: { rubric: e.target.value } })
                }
                className={`${FIELD_CLS} min-h-16 resize-y leading-relaxed`}
              />
              <p className={HINT_CLS}>{GUIDE_PRIVATE_NOTE}</p>
              {draftBlocked(d) && (
                <p className={BLOCK_CLS} data-draft-blocked>
                  {blockFor(i, d)}
                </p>
              )}
            </div>
          ))}

          {blocked && (
            <p role="alert" className={BLOCK_CLS}>
              {blocked}
            </p>
          )}

          {state.confirmingReplace ? (
            <div className="mt-2 rounded-[12px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-3">
              <p className="m-0 mb-3 text-[13px] text-[var(--ai-t1)]" role="alert">
                {replaceConfirmText(existingQuestions)}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ t: "confirm_replace" })}
                  className={PRIMARY_CLS}
                >
                  Replace questions
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ t: "cancel_replace" })}
                  className={SECONDARY_CLS}
                >
                  Keep current questions
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => dispatch({ t: "use", existingQuestions })}
                disabled={!usable || blocked !== null || state.busy}
                className={PRIMARY_CLS}
              >
                {USE_DRAFTS}
              </button>
              <button
                type="button"
                onClick={() => dispatch({ t: "discard" })}
                disabled={state.busy}
                className={SECONDARY_CLS}
              >
                Discard drafts
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** One draft's own block line: names the part that matched. */
function blockFor(index: number, d: { question: string; rubric: string }): string {
  const inQuestion = questionFairnessIssue(d.question);
  const topic = inQuestion ?? questionFairnessIssue(d.rubric);
  const where = inQuestion ? "This question" : "This scoring guide";
  return `${where} touches on ${topic}, which can't be used to judge a candidate. Please reword draft ${index + 1} to focus on the job.`;
}
