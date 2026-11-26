import { firstFairnessBlock, questionFairnessIssue } from "@/lib/interviews/question-fairness";
import { EMPTY_QUESTION_INPUT, type InterviewQuestionInput } from "@/lib/interviews/types";

/**
 * The AI-Guided draft review panel (job wizard step 5), as a pure reducer.
 *
 * Drafts live HERE, never in the job's question list. Edit, reorder, remove
 * and regenerate change only the drafts. The job's questions change only when
 * the recruiter presses "Use these questions" (and, if the job already has
 * questions, confirms replacing them): then `apply` carries the questions for
 * the wizard to put on the job, once. Saving the job afterwards is the
 * recruiter's approval.
 */

export type Draft = {
  id: string;
  question: string;
  competency: string;
  /** The private scoring guide draft: stays in Remotiv, never sent to Sarah or a candidate. */
  rubric: string;
};

export type DraftsState = {
  drafts: Draft[];
  count: number;
  busy: boolean;
  error: string | null;
  /** "Use these questions" was pressed on a job that already has questions. */
  confirmingReplace: boolean;
  /** Questions for the wizard to put on the job. Null until the recruiter uses the drafts. */
  apply: Draft[] | null;
};

export type DraftsAction =
  | { t: "count"; count: number }
  | { t: "start" }
  | { t: "result"; drafts: Omit<Draft, "id">[] }
  | { t: "failed"; error: string }
  | { t: "edit"; index: number; patch: Partial<Omit<Draft, "id">> }
  | { t: "move"; index: number; delta: number }
  | { t: "remove"; index: number }
  | { t: "use"; existingQuestions: number }
  | { t: "confirm_replace" }
  | { t: "cancel_replace" }
  | { t: "applied" }
  | { t: "discard" };

export const INITIAL_DRAFTS: DraftsState = {
  drafts: [],
  count: 5,
  busy: false,
  error: null,
  confirmingReplace: false,
  apply: null,
};

let seq = 0;
const draftId = () => `draft-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The first fairness block in the drafts, or null: "Use these questions" waits for it. */
export function draftsBlocked(drafts: readonly Draft[]): string | null {
  return firstFairnessBlock(drafts);
}

/** Whether one draft is blocked, for its own inline message. */
export function draftBlocked(d: Draft): boolean {
  return questionFairnessIssue(d.question) !== null || questionFairnessIssue(d.rubric) !== null;
}

export function draftsReducer(s: DraftsState, a: DraftsAction): DraftsState {
  switch (a.t) {
    case "count":
      return { ...s, count: a.count };
    case "start":
      return s.busy ? s : { ...s, busy: true, error: null };
    case "result":
      // Regenerate replaces the DRAFTS only. Nothing reaches the job from here.
      return {
        ...s,
        busy: false,
        error: null,
        confirmingReplace: false,
        drafts: a.drafts.map((d) => ({ ...d, id: draftId() })),
      };
    case "failed":
      return { ...s, busy: false, error: a.error };
    case "edit":
      return {
        ...s,
        confirmingReplace: false,
        drafts: s.drafts.map((d, i) => (i === a.index ? { ...d, ...a.patch } : d)),
      };
    case "move": {
      const to = a.index + a.delta;
      if (to < 0 || to >= s.drafts.length) return s;
      const drafts = [...s.drafts];
      const [item] = drafts.splice(a.index, 1);
      drafts.splice(to, 0, item);
      return { ...s, drafts };
    }
    case "remove":
      return {
        ...s,
        confirmingReplace: false,
        drafts: s.drafts.filter((_, i) => i !== a.index),
      };
    case "use": {
      const usable = s.drafts.filter((d) => d.question.trim());
      if (usable.length === 0 || draftsBlocked(usable)) return s;
      return a.existingQuestions > 0
        ? { ...s, confirmingReplace: true }
        : { ...s, apply: usable, confirmingReplace: false };
    }
    case "confirm_replace": {
      if (!s.confirmingReplace) return s;
      const usable = s.drafts.filter((d) => d.question.trim());
      if (usable.length === 0 || draftsBlocked(usable)) return { ...s, confirmingReplace: false };
      return { ...s, apply: usable, confirmingReplace: false };
    }
    case "cancel_replace":
      return { ...s, confirmingReplace: false };
    case "applied":
      // Used: the panel closes, and the questions are now the job's to edit.
      return { ...INITIAL_DRAFTS, count: s.count };
    case "discard":
      return { ...INITIAL_DRAFTS, count: s.count };
  }
}

/** The drafts as job questions: new rows, with the answer time of the chosen count's preset. */
export function draftsAsJobQuestions(
  drafts: readonly Draft[],
  answerSeconds: number,
): InterviewQuestionInput[] {
  return drafts.map((d) => ({
    ...EMPTY_QUESTION_INPUT,
    id: `new-${d.id}`,
    question: d.question.trim(),
    competency: d.competency,
    rubric: d.rubric.trim(),
    answerSeconds: String(answerSeconds),
  }));
}
