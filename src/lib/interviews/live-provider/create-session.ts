import { sanitizeCvForInterview } from "@/lib/interviews/cv-sanitize";
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

/** A frozen question as the session holds it: it may carry marking fields, which are never copied. */
export type FrozenQuestion = {
  position: number;
  text: string;
  rubric?: unknown;
  competency?: unknown;
  weight?: unknown;
};

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
  questions: readonly FrozenQuestion[];
  candidateFirstName: string | null;
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
  if (input.questions.length === 0) throw new CreateSessionInputError("no questions");

  const positions = new Set<number>();
  const questions = input.questions
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
    cv_text: sanitizeCvForInterview(input.cvText).text,
  };
}
