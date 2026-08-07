/**
 * Shapes shared between the candidate page, the API routes and the dashboard.
 *
 * No runtime imports: the candidate page is a client component and must be
 * able to import these without dragging next/headers into its bundle.
 */

export const SESSION_STATUSES = [
  "invited",
  "started",
  "submitted",
  "expired",
  "cancelled",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TRANSCRIPT_STATUSES = ["pending", "done", "failed", "skipped"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/** Defaults the question builder starts from. */
export const DEFAULT_PREP_SECONDS = 30;
export const DEFAULT_ANSWER_SECONDS = 120;
export const MIN_QUESTIONS = 4;
export const MAX_QUESTIONS = 6;

/** Bounds the builder enforces and the candidate page trusts. */
export const PREP_SECONDS_MIN = 5;
export const PREP_SECONDS_MAX = 120;
export const ANSWER_SECONDS_MIN = 30;
export const ANSWER_SECONDS_MAX = 300;
export const QUESTION_TEXT_MAX = 500;
export const RUBRIC_MAX = 1000;
export const COMPETENCY_MAX = 80;

/** One authored question on a job. */
export type InterviewQuestion = {
  id: string;
  position: number;
  question: string;
  competency: string;
  rubric: string;
  prepSeconds: number;
  answerSeconds: number;
  weight: number;
  required: boolean;
};

/** The wizard's editable form model — strings, coerced server-side. */
export type InterviewQuestionInput = {
  /** Empty for a question that has not been saved yet. */
  id: string;
  question: string;
  competency: string;
  rubric: string;
  prepSeconds: string;
  answerSeconds: string;
  weight: string;
  required: boolean;
};

export const EMPTY_QUESTION_INPUT: InterviewQuestionInput = {
  id: "",
  question: "",
  competency: "",
  rubric: "",
  prepSeconds: String(DEFAULT_PREP_SECONDS),
  answerSeconds: String(DEFAULT_ANSWER_SECONDS),
  weight: "1",
  required: true,
};

/**
 * What the candidate page is given for one question.
 *
 * Deliberately narrower than InterviewQuestion: `rubric`, `competency` and
 * `weight` are how the COMPANY evaluates the answer and must never reach the
 * candidate — showing someone the marking scheme is showing them the answer.
 */
export type CandidateQuestion = {
  id: string;
  position: number;
  question: string;
  /** Short label for the review list. Derived, not authored. */
  shortLabel: string;
  prepSeconds: number;
  answerSeconds: number;
  required: boolean;
  /** True once an answer exists for this position — drives resume. */
  answered: boolean;
  /** Seconds of the recorded answer, for the review list. */
  recordedSeconds: number | null;
};

/** Everything the candidate page renders from. No ids that aren't needed. */
export type CandidateSession = {
  /** Terminal states are resolved server-side before the flow renders. */
  state: "ready" | "submitted" | "expired" | "cancelled";
  companyName: string;
  companyInitial: string;
  jobTitle: string;
  /** ISO. Rendered in the candidate's own locale. */
  expiresAt: string;
  submittedAt: string | null;
  /** The job's allow_rerecord — governs whether Re-record is offered. */
  allowRerecord: boolean;
  consentGiven: boolean;
  questions: CandidateQuestion[];
  /** Total answer seconds, for "About N minutes" on Welcome. */
  estimatedMinutes: number;
};

/**
 * A short label for the review list, derived from the question text.
 *
 * The schema has no label column and asking a recruiter to write one for every
 * question is friction for a line only the candidate sees. First clause, capped.
 */
export function shortLabelFor(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  const firstClause = clean.split(/[.?!]/)[0] ?? clean;
  const trimmed = firstClause.trim();
  if (trimmed.length <= 42) return trimmed || "Question";
  return `${trimmed.slice(0, 41).trimEnd()}…`;
}
