import { CV_WEIGHT_DEFAULT, snapWeight } from "@/lib/weights";
import {
  ANSWER_SECONDS_MAX,
  ANSWER_SECONDS_MIN,
  COMPETENCY_MAX,
  type InterviewKind,
  type InterviewQuestionInput,
  MAX_QUESTIONS,
  PREP_SECONDS_MAX,
  PREP_SECONDS_MIN,
  QUESTION_TEXT_MAX,
  RUBRIC_MAX,
} from "./types";

/**
 * One wizard list as the job save stores it (replace_interview_questions,
 * migration 082), and the one place that says what "stored" means.
 *
 * The save writes this, and the wizard's "questions changed since invites
 * went out" line (#20) compares two lists through it, so the line lights for
 * exactly the edits a save would store: text, order, competency, scoring
 * guide, add and remove, timers, Required and the async weight. Whitespace, a
 * blank row and a new id never count, because the save drops or ignores them.
 *
 * Blank rows are dropped (a recruiter who added a question and changed their
 * mind). Live questions all count equally in v1, so they are stored at Normal
 * (2). A blank competency or scoring guide is stored as null. Positions are
 * the list order; the function assigns 1..n.
 *
 * Pure and client-safe.
 */
export type StoredQuestionRow = {
  question: string;
  competency: string | null;
  rubric: string | null;
  prep_seconds: number;
  answer_seconds: number;
  weight: number;
  required: boolean;
};

export function storedQuestionRows(
  inputs: readonly InterviewQuestionInput[],
  kind: InterviewKind,
): StoredQuestionRow[] {
  return inputs
    .map((q) => ({
      question: (q.question ?? "").trim().slice(0, QUESTION_TEXT_MAX),
      competency: (q.competency ?? "").trim().slice(0, COMPETENCY_MAX) || null,
      rubric: (q.rubric ?? "").trim().slice(0, RUBRIC_MAX) || null,
      prep_seconds: clampInt(q.prepSeconds, PREP_SECONDS_MIN, PREP_SECONDS_MAX, 30),
      answer_seconds: clampInt(q.answerSeconds, ANSWER_SECONDS_MIN, ANSWER_SECONDS_MAX, 120),
      // Async: snapped to a stop (snapWeight), never clamped to a range. Live:
      // Normal, every question equal in v1.
      weight: kind === "live" ? CV_WEIGHT_DEFAULT : snapWeight(q.weight),
      required: q.required !== false,
    }))
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_QUESTIONS);
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
