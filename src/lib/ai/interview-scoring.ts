import "server-only";
import { getAnthropic } from "@/lib/anthropic";
import { createServiceClient } from "@/lib/supabase/server";
import { recordUsage } from "@/lib/usage";
import {
  type Confidence,
  type EvidenceItem,
  resolveScoringModel,
  ScoringSkipped,
  verifyEvidence,
} from "./cv-scoring";

/**
 * AI interview scoring — the plumbing, not yet the judgement.
 *
 * ══ THIS SCORES THE TRANSCRIPT. NOTHING ELSE. ══════════════════
 *
 * The only input to a score is the WORDS the candidate said, read against the
 * question they were asked. There is no analysis of the video: no face, no
 * expression, no eye contact, no "confidence" inferred from delivery, no
 * measurement of pauses or speech rate, no voice analysis of any kind. None of
 * that exists in this file, none of it is passed to the model, and none of it
 * is coming. Those signals correlate with disability, neurotype, culture and
 * class far more reliably than with competence, and a hiring product that
 * scored them would be discriminating with extra steps.
 *
 * If a future change needs video frames or audio features to do its job, that
 * is the signal to stop and have a different conversation, not to add a field.
 *
 * ══ WHAT IS AND IS NOT BUILT ═══════════════════════════════════
 *
 * Built: the job handler, the per-answer and session-rollup writes, evidence
 * verification, skip paths, idempotency, human-override protection, metering.
 *
 * NOT built: the prompt. SYSTEM_PROMPT below is a PLACEHOLDER and is marked as
 * such. The CV scorer took nine versions driven by real model output on real
 * CVs; writing this one against imagined transcripts would produce a rubric
 * tuned to nothing. It needs a genuine transcript to iterate against, which
 * needs OPENAI_API_KEY, which is not yet set.
 *
 * Until it is written, scoring is OFF by default — see SCORING_ENABLED. The
 * handler still runs, and records an honest `skipped` with a reason, so the
 * whole path is exercised without storing a scorecard nobody should trust.
 */

// ── Configuration ────────────────────────────────────────────

/**
 * PLACEHOLDER version. Bump to `interview-scoring-v1` when the real prompt
 * lands, and thereafter on every prompt change — the value is stored on every
 * row so a score can always be traced to the wording that produced it.
 */
export const PROMPT_VERSION = "interview-scoring-v0-placeholder";

/** Same env var as the CV scorer — one model setting for the product. */
export { resolveScoringModel };

/**
 * Off unless explicitly enabled.
 *
 * Two independent reasons, and either alone is sufficient: the prompt is a
 * placeholder, and no company has agreed to have candidates scored by a model.
 * Turning this on is a product decision, not a deploy.
 */
export function scoringEnabled(): boolean {
  return process.env.AI_INTERVIEW_SCORING_ENABLED?.trim() === "true";
}

const MAX_TOKENS = 2000;

/** Greedy decoding, for the reason the CV scorer documents at length: a score
 *  a recruiter acts on should not move between identical runs. */
const SCORING_TEMPERATURE = 0;

/** Below this there is nothing to assess — a two-word answer is not a signal. */
const MIN_TRANSCRIPT_CHARS = 40;

/** More than half the quotes unverifiable → the response is not trustworthy. */
const MAX_FAIL_RATE = 0.5;

const CONFIDENCE_ORDER: Confidence[] = ["high", "medium", "low"];
function lowerConfidence(c: Confidence): Confidence {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return CONFIDENCE_ORDER[Math.min(i + 1, CONFIDENCE_ORDER.length - 1)];
}

/**
 * Columns a re-score must never overwrite.
 *
 * Identical list to the CV scorer's, and deliberately enforced the same way —
 * stripped from the payload rather than read-and-merged. A merge has a window
 * where a reviewer's correction can be read, then overwritten by a score
 * computed before it existed; stripping cannot.
 */
const HUMAN_OVERRIDE_COLUMNS: readonly string[] = [
  "human_adjusted_score",
  "human_feedback",
  "adjusted_by",
  "adjusted_by_name",
  "adjusted_at",
];

// ══ THE PROMPT — PLACEHOLDER, DO NOT SHIP ENABLED ═════════════
//
// Everything below this line until the next banner is scaffolding. It states
// the output contract the parser expects so the plumbing can be exercised end
// to end, and it deliberately does NOT attempt a rubric: what "a good answer"
// means for a competency is exactly the part that needs real output to tune.
//
// When writing the real prompt, the CV scorer's hard-won lessons apply:
//   - every claim carries its OWN verbatim quote (no parallel arrays — the
//     positional join is how a real quote got attached to the wrong claim);
//   - say explicitly that an ellipsis-stitched quote will be rejected;
//   - score against the question asked, never against a general impression;
//   - the model must be told it is reading a TRANSCRIPT: disfluency, false
//     starts and grammar are artefacts of speech and must not cost marks.

export const SYSTEM_PROMPT = `PLACEHOLDER — not a production prompt.

You are assessing ONE spoken interview answer, supplied as a transcript, against
ONE question and its rubric.

Return ONLY a JSON object:
{
  "score": 0-100,
  "confidence": "high" | "medium" | "low",
  "reasoning": "two or three sentences",
  "evidence": [{ "claim": "...", "quote": "verbatim from the transcript" }],
  "strengths": ["..."],
  "concerns": ["..."],
  "missing": ["..."]
}

Rules:
1. Every quote MUST appear verbatim in the transcript. Do not join separate
   sentences with an ellipsis — a stitched quote is treated as fabricated and
   the claim is discarded.
2. You are reading speech. Filler words, false starts and loose grammar are
   artefacts of talking and must not affect the score.
3. Assess only what was said. You have no video, no audio and no information
   about the person beyond these words.`;

// ══ END PLACEHOLDER ═══════════════════════════════════════════

// ── Shapes ───────────────────────────────────────────────────

export type AnswerScore = {
  score: number;
  confidence: Confidence;
  reasoning: string;
  evidence: EvidenceItem[];
  strengths: string[];
  concerns: string[];
  missing: string[];
  inputTokens: number;
  outputTokens: number;
};

/** What the scorer is given about one answer. Transcript text only. */
export type AnswerScoreInput = {
  questionText: string;
  competency: string | null;
  rubric: string | null;
  transcript: string;
};

// ── Parsing ──────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function stringList(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, max);
}

function evidenceList(v: unknown): EvidenceItem[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceItem[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const e = item as { claim?: unknown; quote?: unknown };
    if (typeof e.claim !== "string" || typeof e.quote !== "string") continue;
    out.push({ claim: e.claim.trim(), quote: e.quote.trim() });
  }
  return out.slice(0, 12);
}

type RawAnswerResponse = {
  score: number;
  confidence: Confidence;
  reasoning: string;
  evidence: EvidenceItem[];
  strengths: string[];
  concerns: string[];
  missing: string[];
};

export function parseAnswerJson(raw: string): RawAnswerResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const o = parsed as Record<string, unknown>;
  const confidence: Confidence =
    o.confidence === "high" || o.confidence === "low" ? o.confidence : "medium";

  return {
    score: clampScore(o.score),
    confidence,
    reasoning: typeof o.reasoning === "string" ? o.reasoning.trim() : "",
    evidence: evidenceList(o.evidence),
    strengths: stringList(o.strengths),
    concerns: stringList(o.concerns),
    missing: stringList(o.missing),
  };
}

// ── Scoring one answer ───────────────────────────────────────

/**
 * Score a single answer against its own question.
 *
 * Throws on a model or parse failure so the queue's backoff handles it.
 * Throws ScoringSkipped when there is nothing worth scoring — the handler
 * turns that into a `skipped` row with the reason, never a retry.
 */
export async function scoreAnswer(
  input: AnswerScoreInput,
): Promise<AnswerScore> {
  const transcript = input.transcript.trim();
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new ScoringSkipped(
      `Transcript too short to assess (${transcript.length} chars, minimum ${MIN_TRANSCRIPT_CHARS}).`,
    );
  }

  const model = resolveScoringModel();
  const response = await getAnthropic().messages.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: SCORING_TEMPERATURE,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  const block = response.content[0];
  const text = block && block.type === "text" ? block.text : "";
  const parsed = parseAnswerJson(text);
  if (!parsed) {
    throw new Error(
      `Model returned unparseable JSON (${text.length} chars, model ${model}).`,
    );
  }

  /*
   * ── Evidence gate ──
   *
   * Identical discipline to the CV scorer: a claim survives only if its quote
   * is genuinely in the transcript. Unverifiable quotes drop their claim and
   * lower confidence; if most fail, the whole response is rejected rather than
   * stored, because a scorecard built on invented quotes is worse than none.
   */
  const { verified, failRate } = verifyEvidence(parsed.evidence, transcript);
  if (failRate > MAX_FAIL_RATE) {
    throw new Error(
      `Evidence verification failed: ${Math.round(failRate * 100)}% of quotes were not found in the transcript.`,
    );
  }

  return {
    score: parsed.score,
    confidence:
      verified.length < parsed.evidence.length
        ? lowerConfidence(parsed.confidence)
        : parsed.confidence,
    reasoning: parsed.reasoning,
    evidence: verified,
    strengths: parsed.strengths,
    concerns: parsed.concerns,
    missing: parsed.missing,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function section(label: string, value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v ? `\n## ${label}\n${v}\n` : "";
}

export function buildUserMessage(input: AnswerScoreInput): string {
  return [
    section("Question asked", input.questionText),
    section("Competency being assessed", input.competency),
    section("Rubric", input.rubric),
    section("Transcript of the candidate's spoken answer", input.transcript),
  ]
    .join("")
    .trim();
}

// ── Persistence ──────────────────────────────────────────────

async function writeAnswerScore(
  row: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const service = createServiceClient();

  const payload: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [column, value] of Object.entries(row)) {
    if (HUMAN_OVERRIDE_COLUMNS.includes(column)) {
      refused.push(column);
      continue;
    }
    payload[column] = value;
  }
  if (refused.length > 0) {
    console.error(
      "[interview-scoring] refused to write human-override columns — a re-score must never clobber a reviewer's correction",
      { answerId: row.answer_id, refused },
    );
  }

  const { error } = await service
    .from("interview_answer_scores")
    .upsert(payload, { onConflict: "answer_id" });
  return { error: error?.message ?? null };
}

async function writeSessionScore(
  row: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const service = createServiceClient();

  const payload: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (HUMAN_OVERRIDE_COLUMNS.includes(column)) continue;
    payload[column] = value;
  }

  const { error } = await service
    .from("interview_session_scores")
    .upsert(payload, { onConflict: "session_id" });
  return { error: error?.message ?? null };
}

// ── The `ai_scorecard` job handler ───────────────────────────

type SessionRow = {
  id: string;
  company_id: string;
  job_id: string | null;
  status: string;
  questions_snapshot: unknown;
};

type AnswerRow = {
  id: string;
  position: number;
  question_text: string | null;
  transcript: string | null;
  transcript_status: string | null;
  video_path: string | null;
  recorded_at: string | null;
};

type QuestionMeta = {
  questionText: string;
  competency: string | null;
  rubric: string | null;
  weight: number;
};

/**
 * Resolve what one answer should be scored against.
 *
 * ── The snapshot and the live row hold different halves ──────
 *
 * questions_snapshot is what the candidate was ACTUALLY ASKED, frozen at
 * invite time — so the question TEXT comes from there, always. But the
 * snapshot deliberately omits competency, rubric and weight: it is read to
 * build the candidate payload, and shipping the marking scheme to the person
 * being marked would defeat the exercise. Those three therefore come from
 * interview_questions, the live row.
 *
 * That split means a rubric edited after the invite went out applies to the
 * scoring of an already-recorded answer. That is the right way round — the
 * rubric is the company's standard, not part of the candidate's experience —
 * but it is a real asymmetry and worth knowing when a score looks off.
 *
 * Matching prefers the snapshot's question id (exact, survives untouched
 * rows) and falls back to position. syncInterviewQuestions delete-and-
 * reinserts on every job save, so ids churn; position is the durable key in
 * practice and the id match is the bonus.
 */
function resolveQuestionMeta(
  answer: AnswerRow,
  snapshot: { id?: string; position?: number; question?: string | null }[],
  live: {
    id: string;
    position: number;
    question: string | null;
    competency: string | null;
    rubric: string | null;
    weight: number | null;
  }[],
): QuestionMeta {
  const snap = snapshot.find((q) => q.position === answer.position);
  const liveRow =
    (snap?.id ? live.find((q) => q.id === snap.id) : undefined) ??
    live.find((q) => q.position === answer.position);

  return {
    // Snapshot first, then the answer's own snapshotted text, then the live
    // row — three fallbacks because scoring against the wrong question is the
    // worst failure available here.
    questionText:
      (snap?.question ?? "").trim() ||
      (answer.question_text ?? "").trim() ||
      (liveRow?.question ?? "").trim(),
    competency: (liveRow?.competency ?? "").trim() || null,
    rubric: (liveRow?.rubric ?? "").trim() || null,
    weight: liveRow?.weight && liveRow.weight > 0 ? liveRow.weight : 1,
  };
}

/**
 * The `ai_scorecard` handler.
 *
 * Payload is `{ sessionId }` and nothing else is trusted from it — the
 * company, job, questions and transcripts are all loaded server-side from the
 * session row, so a forged payload cannot make one company's rubric score
 * another's candidate.
 *
 * Idempotent throughout: both writes upsert on their unique key, so a retry
 * or a duplicate enqueue overwrites rather than erroring or double-counting.
 */
export async function handleAiScorecard(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const sessionId = job.payload?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(`ai_scorecard: payload.sessionId missing (job ${job.id})`);
  }

  const service = createServiceClient();
  const model = resolveScoringModel();

  const { data: sessionData, error: sessionErr } = await service
    .from("interview_sessions")
    .select("id, company_id, job_id, status, questions_snapshot")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionErr) {
    throw new Error(`ai_scorecard: session lookup failed: ${sessionErr.message}`);
  }
  const session = sessionData as SessionRow | null;
  if (!session) throw new Error(`ai_scorecard: session ${sessionId} not found`);

  /** Session-level skip. Records WHY, so a reviewer never sees a blank panel. */
  const skipSession = async (reason: string) => {
    await writeSessionScore({
      session_id: session.id,
      company_id: session.company_id,
      status: "skipped",
      error: reason,
      ai_model: model,
      prompt_version: PROMPT_VERSION,
    });
    console.warn(`[interview-scoring] skipped ${session.id}: ${reason}`);
  };

  if (session.status !== "submitted") {
    await skipSession(
      "The interview hasn't been submitted, so the answers may still change.",
    );
    return;
  }
  if (!scoringEnabled()) {
    await skipSession(
      "AI interview scoring is turned off for this deployment (AI_INTERVIEW_SCORING_ENABLED).",
    );
    return;
  }

  const { data: answerData } = await service
    .from("interview_answers")
    .select(
      "id, position, question_text, transcript, transcript_status, video_path, recorded_at",
    )
    .eq("session_id", session.id)
    .order("position", { ascending: true })
    .limit(50);

  const answers = (answerData ?? []) as AnswerRow[];
  if (answers.length === 0) {
    await skipSession("This interview has no recorded answers.");
    return;
  }

  const snapshot = Array.isArray(session.questions_snapshot)
    ? (session.questions_snapshot as {
        id?: string;
        position?: number;
        question?: string | null;
      }[])
    : [];

  const { data: liveQuestions } = session.job_id
    ? await service
        .from("interview_questions")
        .select("id, position, question, competency, rubric, weight")
        .eq("job_id", session.job_id)
        .eq("company_id", session.company_id)
        .limit(50)
    : { data: [] };

  const live = (liveQuestions ?? []) as {
    id: string;
    position: number;
    question: string | null;
    competency: string | null;
    rubric: string | null;
    weight: number | null;
  }[];

  // ── Score each answer ──
  const scored: { score: number; weight: number }[] = [];
  let anyFailed = false;

  for (const answer of answers) {
    const meta = resolveQuestionMeta(answer, snapshot, live);
    const base = {
      answer_id: answer.id,
      session_id: session.id,
      company_id: session.company_id,
      ai_model: model,
      prompt_version: PROMPT_VERSION,
    };

    /** Per-answer skip. The reason distinguishes the three causes. */
    const skipAnswer = async (reason: string) => {
      await writeAnswerScore({ ...base, status: "skipped", error: reason });
    };

    const transcript = (answer.transcript ?? "").trim();

    if (!transcript) {
      // Purged reads differently from never-transcribed, and a reviewer
      // needs to know which — one is recoverable, the other is not.
      const purged = Boolean(answer.recorded_at) && !answer.video_path;
      await skipAnswer(
        purged
          ? "The recording was deleted after six months, before it was transcribed."
          : answer.transcript_status === "failed"
            ? "Transcription failed for this answer, so there are no words to assess."
            : "No transcript is available for this answer.",
      );
      continue;
    }

    try {
      const result = await scoreAnswer({
        questionText: meta.questionText,
        competency: meta.competency,
        rubric: meta.rubric,
        transcript,
      });

      const { error } = await writeAnswerScore({
        ...base,
        status: "scored",
        error: null,
        score: result.score,
        confidence: result.confidence,
        reasoning: result.reasoning,
        evidence: result.evidence,
        strengths: result.strengths,
        concerns: result.concerns,
        missing: result.missing,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        scored_at: new Date().toISOString(),
      });
      if (error) throw new Error(`answer score write failed: ${error}`);

      scored.push({ score: result.score, weight: meta.weight });
    } catch (err) {
      if (err instanceof ScoringSkipped) {
        await skipAnswer(err.message);
        continue;
      }
      /*
       * One answer failing must not lose the other four. The row records the
       * failure and the loop continues; the session rollup then says how many
       * answers it is actually based on.
       */
      anyFailed = true;
      await writeAnswerScore({
        ...base,
        status: "failed",
        error: err instanceof Error ? err.message.slice(0, 1000) : String(err),
      });
      console.error(`[interview-scoring] answer ${answer.id} failed:`, err);
    }
  }

  // ── Session rollup ──
  if (scored.length === 0) {
    await skipSession(
      "No answer in this interview could be scored — see the individual answers for why.",
    );
    return;
  }

  /*
   * Weighted by each question's weight, so a question the company marked as
   * mattering more moves the overall more. Weight comes from the live
   * interview_questions row (see resolveQuestionMeta) and defaults to 1.
   */
  const totalWeight = scored.reduce((sum, s) => sum + s.weight, 0);
  const overall = Math.round(
    scored.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight,
  );

  const { error: rollupErr } = await writeSessionScore({
    session_id: session.id,
    company_id: session.company_id,
    status: "scored",
    error: null,
    overall_score: overall,
    /*
     * PLACEHOLDER verdict and summary, alongside the placeholder prompt. The
     * real version should come from a model that has read every answer
     * together — a verdict derived arithmetically from per-answer numbers is
     * not a judgement, and dressing one up as prose would be worse than
     * leaving it plain.
     */
    verdict: null,
    summary:
      scored.length === answers.length
        ? null
        : `Based on ${scored.length} of ${answers.length} answers — the rest could not be scored.`,
    confidence: anyFailed ? "low" : "medium",
    ai_model: model,
    prompt_version: PROMPT_VERSION,
    scored_at: new Date().toISOString(),
  });
  if (rollupErr) {
    throw new Error(`ai_scorecard: rollup write failed: ${rollupErr}`);
  }

  // Metering. Never throws — see src/lib/usage.ts.
  await recordUsage({
    companyId: session.company_id,
    type: "interview_scored",
    refId: session.id,
  });
}
