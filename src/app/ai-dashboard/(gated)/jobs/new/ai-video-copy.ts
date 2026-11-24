import { MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "@/lib/interviews/question-mix";
import { MAX_SESSION_SECONDS } from "@/lib/interviews/types";

/**
 * The job wizard's words for the AI Video Interview option (#12, approved
 * 23 Nov). Every job question is asked, in order; no CV questions.
 *
 * The 4 to 8 range is the one the send refuses outside of
 * (gateLiveInterviewInvite, lib/interviews/live-settings.ts), so this line and
 * the server cannot disagree. This is only a warning: the server decides.
 */

export const AI_VIDEO_OPTION_DESCRIPTION =
  "The AI interviewer asks all approved job questions in order. In AI-Guided mode, Sarah can ask up to 2 relevant follow-up questions per question.";

export const AI_VIDEO_QUESTIONS_HINT = `${MIN_JOB_QUESTIONS} to ${MAX_JOB_QUESTIONS} questions. Estimated duration: ${MAX_SESSION_SECONDS / 60} minutes. Candidates using the same approved question set receive identical questions in the same order.`;

export const AI_VIDEO_QUESTION_COUNT_WARNING = `AI Video Interview requires ${MIN_JOB_QUESTIONS} to ${MAX_JOB_QUESTIONS} questions. Please update the job's interview questions to continue.`;

/** Whether the job's question count is outside what the send accepts. */
export function aiVideoQuestionCountOutOfRange(questionCount: number): boolean {
  return questionCount < MIN_JOB_QUESTIONS || questionCount > MAX_JOB_QUESTIONS;
}
