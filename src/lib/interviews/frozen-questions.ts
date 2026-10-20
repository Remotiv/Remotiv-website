/**
 * An AI Video Interview's questions, frozen on its session before it starts.
 *
 * ── Where the frozen set lives, with no migration ────────────
 *
 *   questions_snapshot   what the candidate is SENT: id, position, the
 *                        question text. Nothing about marking or source.
 *   scoring_snapshot     the marking scheme (migration 028), which no
 *                        candidate-facing read may select: position, question
 *                        id, competency, the private scoring guide (as
 *                        `rubric`, the scorer's field), who wrote that guide
 *                        (`guide_source`), weight, and `source`.
 *
 * ── Job questions are the job's own ──────────────────────────
 *
 * The job slots hold the job's authored interview questions, word for word,
 * from the snapshot the live invite froze: the same text, order, competency,
 * rubric and weight for every candidate of the job. A job question may have no
 * competency or rubric (the recruiter left them empty); a CV or general
 * experience question always has both, because Remotiv wrote them.
 *   live_settings.questions_frozen
 *                        the marker: when, by which prompt and policy, at what
 *                        cost. Its absence is what the freeze's conditional
 *                        update tests, so only one set is ever written.
 *
 * ── Only a set read from a session counts as frozen ──────────
 *
 * readFrozenQuestionSet is the only way to obtain a FrozenLiveQuestionSet: it
 * records each set it returns in a private registry, and isFrozenQuestionSet
 * checks that registry. buildCreateSessionInput (live-provider/create-session.ts)
 * refuses anything else, so questions that were never frozen, or a copy edited
 * after reading, cannot reach the provider.
 *
 * Pure: no I/O. Logs a session id, never question text, on a malformed row.
 */

export const LIVE_QUESTION_SOURCES = ["job", "cv", "general_experience"] as const;
export type LiveQuestionSource = (typeof LIVE_QUESTION_SOURCES)[number];
export type GuideSource = "recruiter" | "ai";

export type FrozenLiveQuestion = {
  readonly question_id: string;
  readonly position: number;
  readonly text: string;
  readonly source: LiveQuestionSource;
  /** Null only on a job question whose recruiter left it empty. */
  readonly competency: string | null;
  /**
   * Private: what a strong and a weak answer look like. Never sent to the
   * candidate or the provider. Null only on a job question with no rubric.
   */
  readonly scoring_guide: string | null;
  /**
   * Who wrote the guide: the recruiter (a job question's own rubric) or Remotiv's
   * AI (a CV or general question, or a job question's job-level guide from
   * lib/interviews/live-guides.ts). Absent on sets frozen before it was recorded.
   */
  readonly guide_source?: GuideSource | null;
  /** The job's weight for a job question; null (Normal) for the rest. */
  readonly weight: number | null;
};

export type QuestionsFrozenMarker = {
  at: string;
  prompt_version: string;
  policy_version: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** CV-slot questions that failed a safety or quality check and were rewritten once. */
  rewritten: number;
  /** CV-slot questions that still failed after the rewrite and were replaced from the general bank. */
  replaced: number;
};

export type FrozenLiveQuestionSet = {
  readonly session_id: string;
  readonly frozen: Readonly<QuestionsFrozenMarker>;
  readonly questions: readonly FrozenLiveQuestion[];
};

export const QUESTIONS_FROZEN_KEY = "questions_frozen";

const registry = new WeakSet<object>();

/** True only for a set returned by readFrozenQuestionSet, untouched since. */
export function isFrozenQuestionSet(value: unknown): value is FrozenLiveQuestionSet {
  return typeof value === "object" && value !== null && registry.has(value);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const whole = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

function readMarker(raw: unknown): QuestionsFrozenMarker | null {
  if (!isObj(raw)) return null;
  const at = str(raw.at);
  const prompt = str(raw.prompt_version);
  const policy = str(raw.policy_version);
  const model = str(raw.model);
  const calls = whole(raw.calls);
  const input = whole(raw.input_tokens);
  const output = whole(raw.output_tokens);
  const rewritten = whole(raw.rewritten);
  const replaced = whole(raw.replaced);
  if (!at || !Number.isFinite(Date.parse(at)) || !prompt || !policy || !model) return null;
  if (calls === null || input === null || output === null) return null;
  if (rewritten === null || replaced === null) return null;
  return {
    at,
    prompt_version: prompt,
    policy_version: policy,
    model,
    calls,
    input_tokens: input,
    output_tokens: output,
    rewritten,
    replaced,
  };
}

/** Whether a stored live_settings carries the frozen marker at all, readable or not. */
export function hasFrozenMarker(liveSettings: unknown): boolean {
  return isObj(liveSettings) && liveSettings[QUESTIONS_FROZEN_KEY] != null;
}

/**
 * The session's frozen questions, or null when it has none or they cannot be
 * read whole. Joined by position: text from questions_snapshot, everything
 * private from scoring_snapshot. Positions must run 1..n with no gap.
 */
export function readFrozenQuestionSet(row: {
  id: string;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
}): FrozenLiveQuestionSet | null {
  if (!hasFrozenMarker(row.live_settings)) return null;
  const bad = (why: string): null => {
    console.error(`[live-questions] session ${row.id} frozen questions ${why}`);
    return null;
  };
  const marker = readMarker((row.live_settings as Obj)[QUESTIONS_FROZEN_KEY]);
  if (!marker) return bad("have an unreadable marker");
  if (!Array.isArray(row.questions_snapshot) || !Array.isArray(row.scoring_snapshot)) {
    return bad("are missing a snapshot");
  }
  const scoring = new Map<number, Obj>();
  for (const s of row.scoring_snapshot) {
    if (isObj(s) && typeof s.position === "number") scoring.set(s.position, s);
  }
  const questions: FrozenLiveQuestion[] = [];
  const asked = [...row.questions_snapshot].sort(
    (a, b) => Number((a as Obj)?.position) - Number((b as Obj)?.position),
  );
  for (const [i, q] of asked.entries()) {
    if (!isObj(q) || q.position !== i + 1) return bad("do not run 1..n");
    const s = scoring.get(i + 1);
    const id = str(q.id);
    const text = str(q.question);
    const source = s?.source;
    const competency = str(s?.competency);
    const guide = str(s?.rubric);
    const weight = typeof s?.weight === "number" && s.weight > 0 ? s.weight : null;
    const guideSource =
      s?.guide_source === "recruiter" || s?.guide_source === "ai" ? s.guide_source : null;
    if (!id || !text || s?.question_id !== id) return bad(`are incomplete at position ${i + 1}`);
    if (!(LIVE_QUESTION_SOURCES as readonly unknown[]).includes(source)) {
      return bad(`have no source at position ${i + 1}`);
    }
    // Remotiv wrote every non-job question, so it must carry both.
    if (source !== "job" && (!competency || !guide)) {
      return bad(`are missing a competency or guide at position ${i + 1}`);
    }
    questions.push(
      Object.freeze({
        question_id: id,
        position: i + 1,
        text,
        source: source as LiveQuestionSource,
        competency,
        scoring_guide: guide,
        guide_source: guide ? guideSource : null,
        weight,
      }),
    );
  }
  if (questions.length === 0 || scoring.size !== questions.length) {
    return bad("do not match between the two snapshots");
  }
  const set: FrozenLiveQuestionSet = Object.freeze({
    session_id: row.id,
    frozen: Object.freeze(marker),
    questions: Object.freeze(questions),
  });
  registry.add(set);
  return set;
}

/** The two snapshot columns for a set of questions about to be frozen. */
export function snapshotsFor(questions: readonly FrozenLiveQuestion[]): {
  questions_snapshot: Obj[];
  scoring_snapshot: Obj[];
} {
  return {
    // The candidate payload: what is asked, nothing about how it is marked.
    questions_snapshot: questions.map((q) => ({
      id: q.question_id,
      position: q.position,
      question: q.text,
      prep_seconds: null,
      answer_seconds: null,
      required: true,
    })),
    // The marking scheme. A null weight reads as Normal in the scorer.
    scoring_snapshot: questions.map((q) => ({
      position: q.position,
      question_id: q.question_id,
      competency: q.competency,
      rubric: q.scoring_guide,
      guide_source: q.scoring_guide ? (q.guide_source ?? null) : null,
      weight: q.weight,
      source: q.source,
    })),
  };
}
