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

/**
 * Normal. What a question is worth until someone moves it.
 *
 * Re-exported from src/lib/weights.ts, which owns the four stops and every
 * rule for reading them. It is NOT restated here — a restated copy of this
 * number, four times over, is what produced the default-of-Less bug.
 *
 * `EMPTY_QUESTION_INPUT` used to start every question at 1, which on the stops
 * {1,2,4,6} is LESS, a half weight, while step 7 tells the recruiter Normal is
 * the baseline. Uniform weights hid it — every consumer divides by the total,
 * so a constant factor cancels — and it surfaced only for recruiters who moved
 * one, where a promotion to More landed at four times its neighbours instead of
 * twice.
 *
 * Importing weights.ts does not violate this module's no-runtime-imports rule.
 * The rule exists so the candidate page can import these shapes without pulling
 * next/headers into its bundle, and weights.ts imports nothing at all.
 */
export { CV_WEIGHT_DEFAULT as DEFAULT_QUESTION_WEIGHT } from "@/lib/weights";

import { CV_WEIGHT_DEFAULT } from "@/lib/weights";

/**
 * How long the interview should take, and what that means in questions.
 *
 * ── Why duration and not a count ─────────────────────────────
 *
 * A recruiter has an opinion about "ten minutes". Nobody has an opinion about
 * "five questions" — it is an implementation of a duration they were never
 * asked for. So the panel asks for the duration and shows the count it derives,
 * which keeps the derivation honest rather than hidden.
 *
 * ── Why these numbers are not live-interview numbers ─────────
 *
 * A candidate recording alone has no interviewer to react to, no follow-ups,
 * and no way to recover a fumbled start except by spending their one take. That
 * pulls in two directions at once: each ANSWER needs more room than the same
 * question would need live, because there is no back-and-forth to draw the
 * answer out — and the TOTAL has to be shorter, because unpaid asynchronous
 * effort is a drop-off curve.
 *
 * 120s is the existing default and stays the middle. 60s is enough for a
 * factual answer; 150s is where a structured "tell me about a time" answer
 * lands without becoming a monologue. Six at 150s is fifteen minutes of
 * recording plus retakes and setup — realistically half an evening — and
 * MAX_QUESTIONS already stops anything longer being offered.
 */
export const INTERVIEW_LENGTHS = [
  { id: "short", label: "About 5 minutes", questions: 4, answerSeconds: 60 },
  { id: "standard", label: "About 10 minutes", questions: 5, answerSeconds: 120 },
  { id: "depth", label: "About 15 minutes", questions: 6, answerSeconds: 150 },
] as const;

export type InterviewLengthId = (typeof INTERVIEW_LENGTHS)[number]["id"];

export const DEFAULT_INTERVIEW_LENGTH: InterviewLengthId = "standard";

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
  weight: String(CV_WEIGHT_DEFAULT),
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
