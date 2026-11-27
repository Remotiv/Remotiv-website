import type {
  CompanyJobInput,
  LiveInterviewMinutes,
  LiveInterviewMode,
} from "@/app/ai-dashboard/lib/job-types";
import { MIN_ASYNC_QUESTIONS } from "@/lib/interviews/live-go-live";
import { MIN_JOB_QUESTIONS } from "@/lib/interviews/question-mix";
import type { InterviewKind, InterviewQuestionInput } from "@/lib/interviews/types";
import { AI_VIDEO_MODE_CARDS } from "./ai-video-copy";

/**
 * The job wizard's two interview question lists (migration 082), as pure
 * functions: step 5 edits the async list (interview_questions), step 6 the AI
 * Video Interview's (live_interview_questions). Nothing here can reach the
 * other list: each function takes the kind and touches that field only.
 */

/** The form field each kind's list lives in. */
export const QUESTION_LIST_FIELD = {
  async: "interview_questions",
  live: "live_interview_questions",
} as const;

/** One kind's list from the form state ([] when the field is absent). */
export function questionsOf(state: CompanyJobInput, kind: InterviewKind): InterviewQuestionInput[] {
  return state[QUESTION_LIST_FIELD[kind]] ?? [];
}

/** The form state with one kind's list replaced and the other left exactly as it was. */
export function withQuestions(
  state: CompanyJobInput,
  kind: InterviewKind,
  next: InterviewQuestionInput[],
): CompanyJobInput {
  return { ...state, [QUESTION_LIST_FIELD[kind]]: next };
}

/** Questions with text: what a save keeps and what a count shows. */
export function askedCount(list: readonly InterviewQuestionInput[]): number {
  return list.filter((q) => q.question.trim()).length;
}

/**
 * Rows whose competency is being typed freehand ("Other..."), held per list:
 * the async and live editors never share it, so an edit on one cannot open or
 * close an input on the other.
 */
export type OtherCompetency = Readonly<Record<InterviewKind, ReadonlySet<string>>>;

export const NO_OTHER_COMPETENCY: OtherCompetency = { async: new Set(), live: new Set() };

/** One row of one list switched on or off; the other list's set is the same object. */
export function setOtherCompetency(
  prev: OtherCompetency,
  kind: InterviewKind,
  id: string,
  on: boolean,
): OtherCompetency {
  const next = new Set(prev[kind]);
  if (on) next.add(id);
  else next.delete(id);
  return { ...prev, [kind]: next };
}

const questionsWord = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

/** Step 5's line while the async interview is off. */
export function asyncOffLine(questionCount: number): string {
  return questionCount === 0
    ? "Async video interview is off - turn it on to send recorded interviews."
    : `Async video interview is off - your ${questionsWord(questionCount)} and the re-recording setting are saved but not sent to candidates.`;
}

/** Step 6's line while AI Video Interview is off. */
export function liveOffLine(questionCount: number): string {
  return questionCount === 0
    ? "AI Video Interview is off - turn it on to set up Sarah's questions."
    : `AI Video Interview is off - your ${questionsWord(questionCount)} are saved but Sarah won't ask them until you turn it on.`;
}

/** Step 6, under the editor. */
export const LIVE_EQUAL_WEIGHT_LINE =
  "Each question counts equally and is marked against its own scoring guide.";

/**
 * Under the AI Video Interview Review card while it is on with fewer than 4
 * questions: a draft saves like that, but it cannot be published (#59, #60).
 */
export const LIVE_NEEDS_QUESTIONS_LINE = "Needs 4 to 8 questions before publishing.";

/**
 * On step 5 and the Async Video Interview Review card while it is on with
 * fewer than 3 questions: a draft saves like that, but it cannot be
 * published (#61).
 */
export const ASYNC_NEEDS_QUESTIONS_LINE = "Needs at least 3 questions before publishing.";

/** Whether the async interview is on with too few questions to publish. */
export function asyncNeedsQuestions(state: CompanyJobInput): boolean {
  return (
    state.async_interview_enabled === true &&
    askedCount(questionsOf(state, "async")) < MIN_ASYNC_QUESTIONS
  );
}

/**
 * The two read-only Review cards' lines. "Off" first when an interview is off.
 * The AI Video Interview's mode and length are passed in by the wizard, which
 * owns those fields (the 074 column census keeps them to the wizard's files).
 */
export function interviewReviewLines(
  state: CompanyJobInput,
  live: { mode: LiveInterviewMode; minutes: LiveInterviewMinutes },
): { async: string[]; live: string[]; liveWarning: string | null; asyncWarning: string | null } {
  const liveCount = askedCount(questionsOf(state, "live"));
  return {
    asyncWarning: asyncNeedsQuestions(state) ? ASYNC_NEEDS_QUESTIONS_LINE : null,
    liveWarning:
      state.avatar_interview_enabled && liveCount < MIN_JOB_QUESTIONS
        ? LIVE_NEEDS_QUESTIONS_LINE
        : null,
    async: [
      state.async_interview_enabled ? "On" : "Off",
      state.allow_rerecord ? "Re-recording allowed" : "No re-recording",
      questionsWord(askedCount(questionsOf(state, "async"))),
    ],
    live: [
      state.avatar_interview_enabled ? "On" : "Off",
      AI_VIDEO_MODE_CARDS.find((c) => c.value === live.mode)?.title ?? live.mode,
      `${live.minutes} minutes`,
      questionsWord(liveCount),
    ],
  };
}
