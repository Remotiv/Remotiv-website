import { type FrozenLiveQuestionSet, isFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
import { isLiveConsentProof, type LiveConsentProof } from "@/lib/interviews/live-consent-record";
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
 * ── No CV, ever ──────────────────────────────────────────────
 *
 * Decided 23 Nov (sheet 'AI Interview Pending task' #14): the interview asks
 * the frozen questions in strict order and CV questions are on hold, so the
 * provider gets no CV at all, not even a sanitised one. `cv_text` stays in the
 * input as an EMPTY string only until Arham confirms VoxAgent works without
 * the field; then drop it here, in types.ts and in join.ts's INPUT_KEYS.
 * There is no CV parameter, so no caller can pass one in.
 */

/** What VoxAgent receives for the CV: always nothing (#14). */
const NO_CV = "";

/**
 * ── Only frozen questions, and still only position and text ──
 *
 * `questions` must be a set read from the session by readFrozenQuestionSet
 * (frozen-questions.ts); anything else, a plain array or a copy, is refused.
 * The set also carries each question's source, competency and private scoring
 * guide; none of them is copied.
 *
 * ── The first name only ──────────────────────────────────────
 *
 * The candidate's first name is sent on its own field, for the greeting. No
 * surname, no CV.
 *
 * ── Only after the candidate's consent is saved ──────────────
 *
 * `consent` must be the proof requireLiveConsent (live-consent-record.ts)
 * returns for THIS session after reading consent_at and consent_version
 * 'live-v1' from its row. Without one, no provider session can be built: a
 * declined screen or a consent that failed to save never reaches the
 * provider.
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
  consent: LiveConsentProof;
}): CreateSessionInput {
  const sessionId = input.remotivSessionId.trim();
  if (!sessionId) throw new CreateSessionInputError("no session id");
  if (!isLiveConsentProof(input.consent)) {
    throw new CreateSessionInputError("no saved live consent: the interview cannot start");
  }
  if (input.consent.session_id !== sessionId) {
    throw new CreateSessionInputError("the saved consent belongs to another session");
  }
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
    cv_text: NO_CV,
  };
}
