import { removeCandidateName } from "@/lib/interviews/candidate-name";
import { sanitizeCvForInterview } from "@/lib/interviews/cv-sanitize";
import { type FrozenLiveQuestionSet, isFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
import type { CreateSessionInput } from "./types";

/**
 * The provider's create-session input, built from a session's frozen
 * questions. The only way to make one.
 *
 * ── Position and text, copied one by one ─────────────────────
 *
 * A frozen question carries its rubric, competency and weight for Remotiv's
 * scorer. None of them may reach the provider (the blocking question in
 * AI-VIDEO-INTERVIEW-PHASE-1.md: an interviewer holding the mark scheme asks
 * for exactly what scores well). Each question is rebuilt from `position` and
 * `text` alone, so a field added to the snapshot later is left behind too.
 *
 * ── The CV is sanitised here, every time ─────────────────────
 *
 * Decision D1: Remotiv writes and freezes every question, job and CV; the
 * interviewer gets the CV only for follow-ups, and only with emails, phones,
 * links and addresses removed (cv-sanitize.ts). Sanitising is idempotent, so
 * a caller that already did it loses nothing.
 */

/**
 * ── Only frozen questions, and still only position and text ──
 *
 * `questions` must be a set read from the session by readFrozenQuestionSet
 * (frozen-questions.ts); anything else, a plain array or a copy, is refused.
 * The set also carries each question's source, competency and private scoring
 * guide; none of them is copied.
 *
 * ── The name goes too ────────────────────────────────────────
 *
 * The CV is sanitised, then the candidate's full name and surname are
 * removed (candidate-name.ts). The first name is sent on its own field.
 */

export class CreateSessionInputError extends Error {
  constructor(detail: string) {
    super(`create-session input: ${detail}`);
    this.name = "CreateSessionInputError";
  }
}

export function buildCreateSessionInput(input: {
  remotivSessionId: string;
  interviewerName: string;
  interviewMinutes: number;
  questions: FrozenLiveQuestionSet;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  cvText: string | null;
}): CreateSessionInput {
  const sessionId = input.remotivSessionId.trim();
  if (!sessionId) throw new CreateSessionInputError("no session id");
  const interviewerName = input.interviewerName.trim();
  if (!interviewerName) throw new CreateSessionInputError("no interviewer name");
  if (!Number.isInteger(input.interviewMinutes) || input.interviewMinutes <= 0) {
    throw new CreateSessionInputError(
      "interview length must be a positive whole number of minutes",
    );
  }
  if (!isFrozenQuestionSet(input.questions)) {
    throw new CreateSessionInputError("questions must be the frozen set read from the session");
  }
  if (input.questions.session_id !== sessionId) {
    throw new CreateSessionInputError("the frozen questions belong to another session");
  }
  if (input.questions.questions.length === 0) throw new CreateSessionInputError("no questions");

  const positions = new Set<number>();
  const questions = input.questions.questions
    .map((q) => {
      if (!Number.isInteger(q.position) || q.position < 1 || positions.has(q.position)) {
        throw new CreateSessionInputError("question positions must be unique whole numbers from 1");
      }
      positions.add(q.position);
      const text = q.text.trim();
      if (!text) throw new CreateSessionInputError(`question ${q.position} has no text`);
      return { position: q.position, text };
    })
    .sort((a, b) => a.position - b.position);

  const firstName = input.candidateFirstName?.trim() || null;
  return {
    remotiv_session_id: sessionId,
    interviewer_name: interviewerName,
    interview_minutes: input.interviewMinutes,
    questions,
    candidate_first_name: firstName,
    cv_text: removeCandidateName(sanitizeCvForInterview(input.cvText).text, {
      firstName: input.candidateFirstName,
      lastName: input.candidateLastName,
    }).text,
  };
}
