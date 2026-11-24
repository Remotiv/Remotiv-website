import type { LiveInterviewMinutes, LiveInterviewMode } from "@/app/ai-dashboard/lib/job-types";
import { MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "@/lib/interviews/question-mix";
import { LIVE_INTERVIEWER_NAME } from "@/lib/interviews/types";

/**
 * The job wizard's words for the AI Video Interview option (#12, approved
 * 23 Nov) and its mode, length and hiring challenges (#45, #46, approved
 * 24 Nov). Every job question is asked, in order; no CV questions.
 *
 * The 4 to 8 range is the one the send refuses outside of
 * (gateLiveInterviewInvite, lib/interviews/live-settings.ts), so this line and
 * the server cannot disagree. This is only a warning: the server decides.
 */

export const AI_VIDEO_OPTION_DESCRIPTION =
  "The AI interviewer asks all approved job questions in order. In AI-Guided mode, Sarah can ask up to 2 relevant follow-up questions per question.";

/** The option's hint, with the length the job has chosen. */
export function aiVideoQuestionsHint(minutes: LiveInterviewMinutes): string {
  return `${MIN_JOB_QUESTIONS} to ${MAX_JOB_QUESTIONS} questions. Estimated duration: ${minutes} minutes. Candidates using the same approved question set receive identical questions in the same order.`;
}

/** Under the Interview questions step's description, while AI Video Interview is on. */
export const AI_VIDEO_STEP_LINE = `With AI Video Interview on, ${LIVE_INTERVIEWER_NAME} asks these questions live, in this order.`;

export const AI_VIDEO_QUESTION_COUNT_WARNING = `AI Video Interview requires ${MIN_JOB_QUESTIONS} to ${MAX_JOB_QUESTIONS} questions. Please update the job's interview questions to continue.`;

/** Whether the job's question count is outside what the send accepts. */
export function aiVideoQuestionCountOutOfRange(questionCount: number): boolean {
  return questionCount < MIN_JOB_QUESTIONS || questionCount > MAX_JOB_QUESTIONS;
}

/* ── Interview questions step: mode, length, hiring challenges ── */

export const AI_VIDEO_MODE_HEADING = "How would you like to conduct the interview?";
export const AI_VIDEO_MODE_SUB =
  "Choose how the AI interviewer will ask questions during the interview.";

export const AI_VIDEO_MODE_CARDS: readonly {
  value: LiveInterviewMode;
  title: string;
  tagline: string;
  detail: string;
}[] = [
  {
    value: "structured",
    title: "Recruiter-Defined",
    tagline: "Your questions, your control.",
    detail: "Up to 8 fixed questions, asked in order. No AI follow-ups.",
  },
  {
    value: "ai_guided",
    title: "AI-Guided",
    tagline: "Smarter, natural conversations.",
    detail: "AI drafts questions for your approval, with up to 2 relevant follow-ups per question.",
  },
];

export const AI_VIDEO_LENGTH_LABEL = "Interview length";

export const AI_VIDEO_LENGTH_OPTIONS: readonly { value: LiveInterviewMinutes; label: string }[] = [
  { value: 30, label: "30 minutes - Standard interview" },
  { value: 60, label: "60 minutes - In-depth interview" },
];

/** The hint under the length, for the length chosen. */
export function aiVideoLengthHint(minutes: LiveInterviewMinutes): string {
  return minutes === 60
    ? "Recommended: 6 to 8 questions. This is a maximum - the interview ends when all questions are done."
    : "Recommended: 4 to 6 questions.";
}

export const AI_VIDEO_CHALLENGES_LABEL = "Hiring challenges";
export const AI_VIDEO_CHALLENGES_HELPER =
  "Describe the main problems this hire must solve, for example 'reduce customer churn'. Used only to draft interview questions. Never shown to candidates or the AI interviewer.";
