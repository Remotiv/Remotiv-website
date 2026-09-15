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

/**
 * Which interview option a session is. `interview_sessions.kind`, set at
 * invite and never changed — a trigger refuses the UPDATE (migration 017).
 *
 *   async  the shipped one-way recording: one video per pre-set question
 *   live   AI Video Interview: a real-time conversation with an AI interviewer
 *
 * A job may run both, so this cannot be read off the job. Every writer names
 * the kind explicitly — the column's default exists to backfill the rows that
 * predate it, not to fill in for a writer that forgot, and it is scheduled to
 * be dropped once every writer supplies one (see the 017 migration notes).
 */
export const INTERVIEW_KINDS = ["async", "live"] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];

/** What each kind is called wherever a session is listed or headed. */
export const INTERVIEW_KIND_LABELS: Record<InterviewKind, string> = {
  async: "Async Video Interview",
  live: "AI Video Interview",
};

/**
 * The frozen settings of one live interview — `interview_sessions.live_settings`.
 *
 * Written once at invite by buildLiveSettings (lib/interviews/live-settings.ts)
 * and never updated: a later job edit must not change an interview already in
 * flight. NOT NULL for a live session and NULL for an async one, enforced by a
 * CHECK (migration 018).
 *
 * Field names are snake_case because this snapshot IS the payload sent to the
 * provider, and matching the wire shape means no translation layer that could
 * send something other than what was frozen.
 *
 * The rules TEXT lives in the server-only module, not here. This module is
 * imported by the candidate page, so anything in it ships in the candidate's
 * bundle — and the follow-up rules describe what triggers a follow-up and
 * forbid revealing what a good answer contains. That is mark-scheme-adjacent
 * and must not reach the person being marked. The numbers are here because the
 * consent screen already tells the candidate there may be up to two follow-ups.
 */
export type LiveSettings = {
  /** Snapshot format. Bump when a reader could misread an older row. */
  v: 1;
  interviewer_name: string;
  language: string;
  max_follow_ups_per_base_question: number;
  max_session_seconds: number;
  /** Groups rows by which rules governed them. */
  follow_up_rules_version: string;
  /**
   * The rules VERBATIM, not just the version above.
   *
   * A constant can be edited in place without anyone bumping its version — this
   * codebase has been bitten by exactly that drift more than once. Storing the
   * text means the row says what the provider was actually told, whatever the
   * constant says later.
   */
  follow_up_rules: {
    when: string;
    scope: string;
    never: string[];
  };
};

/** The current snapshot format. A row written under an older `v` is refused. */
export const LIVE_SETTINGS_VERSION = 1;

/** Locked: at most 2 follow-ups per base question, the same for every candidate. */
export const MAX_FOLLOW_UPS_PER_BASE_QUESTION = 2;

/** Ceiling on one live conversation. 30 minutes. */
export const MAX_SESSION_SECONDS = 1800;

/** Sanity ceiling on the stored name. The product cap is enforced on write. */
const LIVE_INTERVIEWER_NAME_CEILING = 200;

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * Narrow a stored live_settings blob, or return null.
 *
 * Postgres can only promise this is a jsonb object (migration 018). Everything
 * about its SHAPE is checked here, because the alternative — Array.isArray and
 * then a cast, which is how questions_snapshot is read — accepts a row missing
 * every field it claims to have.
 *
 * Returns null rather than throwing, and LOGS THE SESSION ID, so a malformed
 * row is a line in the log naming the row to look at, not a page that fails to
 * render for everyone.
 *
 * The interviewer name is checked for sanity only, not against the product's
 * 60-character cap: that cap lives in the dashboard's job types, importing it
 * here would close a cycle, and restating the number is the drift this file
 * warns about elsewhere. buildLiveSettings enforces it on the way in.
 */
export function readLiveSettings(raw: unknown, sessionId: string): LiveSettings | null {
  const bad = (why: string): null => {
    console.error(`[interviews] session ${sessionId} live_settings ${why}`);
    return null;
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("is not an object");
  const o = raw as Record<string, unknown>;

  if (o.v !== LIVE_SETTINGS_VERSION) return bad(`has version ${JSON.stringify(o.v)}`);

  const interviewerName = nonEmptyString(o.interviewer_name, LIVE_INTERVIEWER_NAME_CEILING);
  if (!interviewerName) return bad("has no usable interviewer_name");

  const language = nonEmptyString(o.language, 32);
  if (!language) return bad("has no usable language");

  const followUps = o.max_follow_ups_per_base_question;
  if (
    typeof followUps !== "number" ||
    !Number.isInteger(followUps) ||
    followUps < 0 ||
    followUps > MAX_FOLLOW_UPS_PER_BASE_QUESTION
  ) {
    return bad(`has max_follow_ups_per_base_question ${JSON.stringify(followUps)}`);
  }

  const seconds = o.max_session_seconds;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    return bad(`has max_session_seconds ${JSON.stringify(seconds)}`);
  }

  const rulesVersion = nonEmptyString(o.follow_up_rules_version, 64);
  if (!rulesVersion) return bad("has no follow_up_rules_version");

  const rules = o.follow_up_rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return bad("has no follow_up_rules object");
  }
  const r = rules as Record<string, unknown>;
  const when = nonEmptyString(r.when, 2000);
  const scope = nonEmptyString(r.scope, 2000);
  if (!when || !scope) return bad("has follow_up_rules missing when/scope");
  if (!Array.isArray(r.never)) return bad("has follow_up_rules.never that is not an array");
  const never: string[] = [];
  for (const entry of r.never) {
    const line = nonEmptyString(entry, 2000);
    if (!line) return bad("has an unusable line in follow_up_rules.never");
    never.push(line);
  }

  return {
    v: LIVE_SETTINGS_VERSION,
    interviewer_name: interviewerName,
    language,
    max_follow_ups_per_base_question: followUps,
    max_session_seconds: seconds,
    follow_up_rules_version: rulesVersion,
    follow_up_rules: { when, scope, never },
  };
}

/**
 * Narrow a stored kind for display.
 *
 * The column is NOT NULL with a CHECK on exactly these two values, so anything
 * else is unreachable through the database. It is still handled rather than
 * cast, because a cast is how an impossible value becomes an invisible one:
 * the fallback is logged with the session id, so a bad row is a line in the
 * log and one mislabelled card, not a page that fails to render.
 */
export function readInterviewKind(raw: unknown, sessionId: string): InterviewKind {
  if (raw === "async" || raw === "live") return raw;
  console.error(
    `[interviews] session ${sessionId} has kind ${JSON.stringify(raw)} — shown as async`,
  );
  return "async";
}

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
