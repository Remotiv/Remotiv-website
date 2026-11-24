import { ADDRESS_TAG, EMAIL_TAG, LINK_TAG, PHONE_TAG } from "./cv-sanitize";

/**
 * How many job questions and how many CV-based questions an AI Video
 * Interview has. The same rule for every candidate: no company or job
 * overrides it. Writing the CV questions is not done here.
 *
 * ── Today: every job question, no CV questions (23 Nov, #13) ─
 *
 * Decided 23 Nov 2026 (Waleed): an interview asks ALL of the job's own
 * interview questions, word for word, in the recruiter's order, the same for
 * every candidate of the job; at least MIN_JOB_QUESTIONS and at most
 * MAX_JOB_QUESTIONS of them; up to 2 follow-ups each (unchanged, types.ts).
 * CV questions are ON HOLD: CV_QUESTIONS_PER_INTERVIEW is 0.
 *
 * jobQuestionMix is that rule, copied into live_settings v3 at invite with the
 * job's own count (live-settings.ts). The questions themselves are frozen by
 * lib/interviews/live-question-freeze.ts, which refuses a count outside
 * MIN..MAX rather than cutting or padding.
 *
 * ── Before: the table below (question-mix-v1) ────────────────
 *
 * Sessions invited before 23 Nov carry the table's split (live_settings v2,
 * 4 job + 4 CV for 30 minutes) and keep it when read: readers use the frozen
 * copy. The freeze no longer runs that split and refuses those sessions.
 *
 * No invite and no screen uses the table any more: the wizard's words are
 * jobs/new/ai-video-copy.ts (#12). questionMixFor stays only as the record of
 * the time budget behind MAX_JOB_QUESTIONS (question-mix.test.ts) and of what
 * a v2 session's frozen split means.
 *
 * ── The table: sized on the AVERAGE question, provisional ────
 *
 * PROVISIONAL (decision D3). These rows rely on the time rule: when the
 * session is short of time, follow-ups are dropped so every base question is
 * still asked. Without that rule the 30-minute row does not fit everyone.
 *
 * On the provider's sample (16 Oct 2026) a base question with both follow-ups
 * took 2.5 to 4.0 minutes, 3.05 on AVERAGE; the greeting and close took about a
 * minute. Each row keeps its questions inside 90% of the session after 2
 * minutes of greeting and close, at the average:
 *
 *   total = floor((0.9 x minutes - 2) / 3.05)
 *
 *   30 min -> 8 questions -> 4 job + 4 CV   (24.4 min at the average)
 *   20 min -> 5 questions -> 3 job + 2 CV   (15.3 min)
 *   15 min -> 3 questions -> 2 job + 1 CV   ( 9.2 min)
 *
 * At the observed worst (4.0 minutes a question) 8 questions take about 34
 * minutes with the greeting: over the 30. That is the case the time rule
 * covers. The same 8 is MAX_JOB_QUESTIONS today.
 *
 * Half and half, with an odd question going to the job. question-mix.test.ts
 * checks each row against the formula, so a row edited past the budget fails.
 *
 * ── CV slots, when they come back ────────────────────────────
 *
 * A CV slot is filled with a CV question, or, when the CV is too thin to
 * support one, a general experience question of similar difficulty and the
 * same kind of scoring guide (lib/interviews/live-questions.ts). It never
 * turns into another job question. "Too thin" starts at MIN_CV_TEXT_CHARS in
 * lib/ai/cv-scoring.ts, the length below which a CV is not scored; restated
 * here because the wizard imports this module and must not pull in the
 * scorer, and pinned equal to it by a test.
 *
 * ── Versioned, and frozen per session ────────────────────────
 *
 * The mix is copied onto each live session at invite. A later change to the
 * rule must bump QUESTION_MIX_POLICY_VERSION, and never changes a session
 * already sent: readers use the frozen copy.
 */

/** The current rule: every job question, no CV questions (23 Nov). */
export const QUESTION_MIX_POLICY_VERSION = "question-mix-v2";
/** The table's rule, 4 job + 4 CV for 30 minutes: sessions invited before 23 Nov. */
export const TABLE_POLICY_VERSION = "question-mix-v1";

/** A live interview asks at least this many of the job's own questions. */
export const MIN_JOB_QUESTIONS = 4;
/** And at most this many: the 30-minute row's total. */
export const MAX_JOB_QUESTIONS = 8;
/** ON HOLD (23 Nov): no CV questions. live-question-freeze.ts writes none while this is 0. */
export const CV_QUESTIONS_PER_INTERVIEW = 0;
/** Measured on the provider's sample: a base question with two follow-ups, on AVERAGE (worst seen: 4.0). */
export const MINUTES_PER_FOLLOWED_UP_QUESTION = 3.05;
/** Greeting and close. */
export const SESSION_OVERHEAD_MINUTES = 2;
/** Share of the session the questions may fill; the rest absorbs a slow question. */
export const SESSION_FILL = 0.9;

export const QUESTION_MIX_TABLE = [
  { minutes: 15, job: 2, cv: 1 },
  { minutes: 20, job: 3, cv: 2 },
  { minutes: 30, job: 4, cv: 4 },
] as const;

/** Below this many characters, without contact tags, every CV slot is a general experience question. */
export const MIN_CV_CHARS_FOR_CV_QUESTIONS = 200;

/** The mix for one session, as frozen in live_settings.question_mix. */
export type QuestionMix = {
  policy_version: string;
  /** The table row used: the session's length, or the nearest lower row. */
  session_minutes: number;
  job_questions: number;
  cv_questions: number;
  total: number;
};

/**
 * The mix frozen at invite (live_settings v3): all of the job's questions, as
 * many as the job has, and CV_QUESTIONS_PER_INTERVIEW CV questions. The count
 * is stored as it is, never cut or padded: a count outside
 * MIN_JOB_QUESTIONS..MAX_JOB_QUESTIONS is refused where the questions are
 * frozen. Never throws.
 */
export function jobQuestionMix(jobQuestionCount: number, sessionMinutes: number): QuestionMix {
  return {
    policy_version: QUESTION_MIX_POLICY_VERSION,
    session_minutes: sessionMinutes,
    job_questions: jobQuestionCount,
    cv_questions: CV_QUESTIONS_PER_INTERVIEW,
    total: jobQuestionCount + CV_QUESTIONS_PER_INTERVIEW,
  };
}

/**
 * The TABLE's mix (question-mix-v1) for a session of this many minutes: the
 * nearest row at or below it, or the shortest row when it is below every row
 * or not a number. Never throws. No invite or screen uses it: see the top of
 * this file.
 */
export function questionMixFor(sessionMinutes: number): QuestionMix {
  const rows = [...QUESTION_MIX_TABLE].sort((a, b) => a.minutes - b.minutes);
  let row: (typeof QUESTION_MIX_TABLE)[number] = rows[0];
  if (Number.isFinite(sessionMinutes)) {
    for (const r of rows) if (r.minutes <= sessionMinutes) row = r;
  }
  return {
    policy_version: TABLE_POLICY_VERSION,
    session_minutes: row.minutes,
    job_questions: row.job,
    cv_questions: row.cv,
    total: row.job + row.cv,
  };
}

const CONTACT_TAGS_RE = new RegExp(
  [EMAIL_TAG, PHONE_TAG, LINK_TAG, ADDRESS_TAG].map((t) => t.replace(/[[\]]/g, "\\$&")).join("|"),
  "g",
);

/** Whether a sanitised CV has enough left, without its contact tags, to ask about. */
export function cvSupportsQuestions(sanitizedCvText: string | null | undefined): boolean {
  const text = String(sanitizedCvText ?? "")
    .replace(CONTACT_TAGS_RE, "")
    .trim();
  return text.length >= MIN_CV_CHARS_FOR_CV_QUESTIONS;
}
