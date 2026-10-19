import { ADDRESS_TAG, EMAIL_TAG, LINK_TAG, PHONE_TAG } from "./cv-sanitize";

/**
 * How many job questions and how many CV-based questions an AI Video
 * Interview has. One table, the same rule for every candidate: no company or
 * job overrides it. Writing the CV questions is not done here.
 *
 * ── Keyed by the live session's length ───────────────────────
 *
 * A live interview's length is the frozen live_settings.max_session_seconds,
 * which is MAX_SESSION_SECONDS (30 minutes) for everyone today. It is NOT
 * jobs.interview_duration_minutes: that column is the Team Call's length, for
 * human final interviews booked through the calendar.
 *
 * ── The numbers: every candidate must be able to reach every question ──
 *
 * "The same mix for everyone" only holds if nobody runs out of time. A
 * candidate whose answers draw two follow-ups each takes longest, so each row
 * is sized for that candidate. On the provider's sample (16 Oct 2026) a base
 * question with both follow-ups took 2.5 to 4.0 minutes, 3.05 on average, and
 * the greeting and close took about a minute. Each row keeps its questions
 * inside 90% of the session after 2 minutes of greeting and close:
 *
 *   total = floor((0.9 x minutes - 2) / 3.05)
 *
 *   30 min -> 8 questions -> 4 job + 4 CV   (24.4 min of questions)
 *   20 min -> 5 questions -> 3 job + 2 CV   (15.3 min)
 *   15 min -> 3 questions -> 2 job + 1 CV   ( 9.2 min)
 *
 * Half and half, with an odd question going to the job: job questions are the
 * ones every candidate on the job shares. question-mix.test.ts checks each row
 * against the formula, so a row edited past the budget fails.
 *
 * ── A CV with nothing to ask about ───────────────────────────
 *
 * When the CV is empty or too short once contact details are removed, every
 * question is a job question and the total stays the same, so the candidate
 * is not given a shorter interview for an unreadable CV. "Too short" is
 * MIN_CV_TEXT_CHARS in lib/ai/cv-scoring.ts, the length below which a CV is not
 * scored; restated here because the wizard imports this module and must not
 * pull in the scorer, and pinned equal to it by a test.
 *
 * ── Versioned, and frozen per session ────────────────────────
 *
 * The mix is copied onto each live session at invite (live_settings v2). A
 * later change to this table must bump QUESTION_MIX_POLICY_VERSION, and never
 * changes a session already sent: readers use the frozen copy.
 */

export const QUESTION_MIX_POLICY_VERSION = "question-mix-v1";

/** Measured on the provider's sample: a base question with two follow-ups, on average. */
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

/** Below this many characters, without contact tags, a CV gets no CV questions. */
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
 * The policy's mix for a session of this many minutes: the nearest row at or
 * below it, or the shortest row when it is below every row or not a number.
 * Never throws.
 */
export function questionMixFor(sessionMinutes: number): QuestionMix {
  const rows = [...QUESTION_MIX_TABLE].sort((a, b) => a.minutes - b.minutes);
  let row: (typeof QUESTION_MIX_TABLE)[number] = rows[0];
  if (Number.isFinite(sessionMinutes)) {
    for (const r of rows) if (r.minutes <= sessionMinutes) row = r;
  }
  return {
    policy_version: QUESTION_MIX_POLICY_VERSION,
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

/**
 * A frozen mix applied to one candidate's sanitised CV: unchanged when the CV
 * can carry questions, otherwise every question a job question, same total.
 */
export function resolveQuestionMix(
  mix: QuestionMix,
  sanitizedCvText: string | null | undefined,
): QuestionMix {
  if (mix.cv_questions === 0 || cvSupportsQuestions(sanitizedCvText)) return { ...mix };
  return { ...mix, job_questions: mix.total, cv_questions: 0 };
}

/** The wizard's read-only line, e.g. "30 min interview: 4 job questions + 4 CV-based questions, same for every candidate." */
export function describeQuestionMix(mix: QuestionMix): string {
  const job = `${mix.job_questions} job question${mix.job_questions === 1 ? "" : "s"}`;
  const cv = `${mix.cv_questions} CV-based question${mix.cv_questions === 1 ? "" : "s"}`;
  return `${mix.session_minutes} min interview: ${job} + ${cv}, same for every candidate.`;
}
