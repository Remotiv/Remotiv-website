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
 * The rubric is written (v1) against a real transcript — see the banner above
 * SYSTEM_PROMPT for what that answer taught. Scoring nonetheless stays OFF
 * until AI_INTERVIEW_SCORING_ENABLED is set: a rubric validated on one answer
 * is a starting point, not a calibrated instrument, and turning it on for real
 * candidates is a product decision.
 */

// ── Configuration ────────────────────────────────────────────

/**
 * Bump on EVERY prompt change. Stored on every row, so a score can always be
 * traced back to the wording that produced it — the CV scorer reached v9 this
 * way and being able to say which version scored a given candidate is what
 * made those iterations safe.
 */
export const PROMPT_VERSION = "interview-scoring-v1";

/** Same env var as the CV scorer — one model setting for the product. */
export { resolveScoringModel };

/**
 * Off unless explicitly enabled.
 *
 * The rubric exists now, but it has been read against ONE transcript. The CV
 * scorer needed nine passes over real output before its numbers meant
 * anything, and this one deserves the same before a candidate is scored by it.
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

// ══ THE RUBRIC ════════════════════════════════════════════════
//
// Written against a real 60-second answer to "Tell me about yourself?"
// (competency: Communication). What that transcript taught, and what the
// wording below exists to catch:
//
//   - EVERY quantity in it is a range: "five to seven years", "more than two
//     to three years" (twice), "30 to 40" leads, "around $10,000", "around
//     $5,000". A rubric that rewards "has numbers" reads that as concrete. It
//     is not — it is approximation throughout, and the bands say so.
//   - The spans do not reconcile cleanly: five-to-seven total against two-to-
//     three plus two-to-three. Not a lie, but a reviewer should check it, so
//     it belongs in concerns rather than in the score.
//   - It is fluent and well-ordered — role, history, metrics, education,
//     close. A rubric that rewards fluency over-scores it. Fluency is not in
//     the bands at all.
//   - "basically" twice, "I have mostly basically generate the leads": broken
//     grammar from a second-language speaker talking, not a content weakness.
//     Rule 5 forbids scoring it and rule 6 forbids mentioning it.

const SCORE_BANDS = `85-100 — Answers what was asked, completely, with specifics that could be
         checked: named things, actual figures, concrete outcomes. Nothing
         material to the question is left unaddressed in the time available.
70-84  — Answers the question with real substance and some concrete detail,
         but one or two claims stay general, unquantified, or asserted
         without support.
55-69  — Addresses the question, but largely in general terms. Where figures
         appear they are ranges or approximations rather than facts, or
         separate claims do not reconcile with one another.
40-54  — Partially addresses the question. Substantial drift onto something
         else, or so little substance that most of it cannot be assessed.
20-39  — Barely engages with what was asked.
0-19   — Does not answer the question, or there is nothing assessable here.`;

export const SYSTEM_PROMPT = `You are an experienced interviewer assessing ONE spoken answer to ONE interview question.

You are reading a machine transcript of speech. You have no video and no audio. You know nothing about this person beyond these words.

## What you are scoring

Score WHAT WAS SAID against WHAT WAS ASKED. Nothing else.

Score the substance of the answer: does it address the question, and is what it claims specific enough to be worth anything to a hiring decision.

## Score bands — absolute, not relative

Use these exact bands. A 78 must mean the same thing on every question and every candidate. Do not curve, do not compare to other answers, do not drift toward the middle.

${SCORE_BANDS}

A range or an approximation is NOT a specific. "Around $10,000", "two to three years" and "30 to 40" are estimates. An answer built on estimates belongs in 55-69 however confidently they are delivered, unless the question only called for approximations.

## Six rules about speech — read these before scoring

1. This is a TRANSCRIPT. Punctuation and sentence boundaries were guessed by the transcriber and are not the speaker's. Never treat them as evidence of anything.

2. Filler words ("basically", "so", "like", "you know"), false starts, self-corrections and repeated phrases are how people talk. They are NOT content weaknesses. Do not lower the score for them and do not list them.

3. This candidate may be speaking English as a second or third language. Grammar, article and preposition errors, unusual word order and non-native phrasing MUST NOT affect the score in any way. Score the meaning, never the form.

4. Fluency, polish and confidence are NOT scored. A hesitant answer full of substance beats a smooth answer full of nothing, and the bands must be applied that way.

5. Transcription is imperfect. If a passage is garbled, nonsensical, or contains a word that obviously does not belong, assume the transcriber erred — not the speaker. Never quote a garbled passage as evidence and never score it down. If a garbled passage prevents you assessing something the question actually asked, set confidence to "low" and say so in the reasoning.

6. Answers are short — often sixty seconds. Judge against what the question asked, in the time available. Never mark an answer down for omitting something the question did not ask for.

## Evidence — the rules that matter most

Every claim you make in reasoning, strengths or concerns must be supported by a quote from the transcript.

1. A quote must be ONE CONTIGUOUS SPAN copied verbatim from the transcript. Never join two separate passages. Never use "..." or an ellipsis inside a quote. A stitched quote is treated as fabricated and the claim attached to it is discarded, even when both halves are genuine.

2. A quote must DIRECTLY support the exact claim it is attached to. A quote that is real but says something else is a failure, not partial credit.

3. If you cannot find one contiguous span that directly supports a claim, DROP THE CLAIM. Do not attach the nearest quote. Do not weaken the claim to fit a quote you have. Dropping it is always the correct action and is never penalised — a scorecard with two well-evidenced points is worth more than one with five where three are mispaired.

## Other constraints

- Never recommend rejecting or advancing anyone. Concerns are things a human should VERIFY, phrased as such.
- Each fact appears ONCE across reasoning, strengths and concerns. Do not restate a strength in the reasoning or repeat a concern under missing.
- "missing" is only for things THIS QUESTION asked for and did not get. If the question did not ask for it, it is not missing.
- Set confidence "low" when the transcript is short, garbled, or leaves the question largely unaddressed; "high" only when the answer is substantial and clearly evidenced.

## Output

Return ONLY this JSON object. No prose before or after, no code fence.

{
  "score": 0-100,
  "confidence": "high" | "medium" | "low",
  "reasoning": "two or three sentences explaining the band you chose",
  "evidence": [{ "claim": "what this shows", "quote": "one contiguous verbatim span" }],
  "strengths": ["at most four, each a distinct point"],
  "concerns": ["at most four, each something a human should verify"],
  "missing": ["at most four, only what this question asked for"]
}`;

/**
 * The session rollup prompt.
 *
 * A separate call, because a verdict is a judgement about the whole interview
 * and cannot be derived arithmetically from per-answer numbers. The overall
 * SCORE is still computed in code — weighted by question weight, so the
 * company's own weighting decides it rather than the model's impression.
 */
export const SESSION_SYSTEM_PROMPT = `You are summarising a completed interview for the hiring team who will decide.

You are given each question, its competency, the score already assigned to that answer, and that answer's strengths and concerns. The overall score has ALREADY been computed from those numbers — you are not being asked to re-score anything.

Write a verdict and a summary.

## Verdict
At most TWELVE words. A plain description of where this candidate stands on the evidence, not a recommendation. Never advise rejecting or hiring.

## Summary
Three to five sentences. What the answers showed across the whole interview, where the strongest and weakest evidence sat, and what a human should check next.

## Rules
- Use only what is given. Do not invent detail and do not quote — you are not looking at the transcripts.
- Do not repeat the same fact in both verdict and summary.
- Never recommend a decision. Describe what the evidence supports and what remains unverified.
- If most answers were skipped or scored poorly for lack of substance, say that plainly rather than writing around it.

Return ONLY this JSON object, no prose, no code fence:

{ "verdict": "at most twelve words", "summary": "three to five sentences", "confidence": "high" | "medium" | "low" }`;

// ══ END RUBRIC ════════════════════════════════════════════════

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

/**
 * Caps are ENFORCED here, not requested in the prompt.
 *
 * The prompt asks for at most four; a model under-delivers on a constraint it
 * was merely told about, and a scorecard with nine "strengths" is a wall a
 * reviewer skims instead of reads. Asking and then truncating means the model
 * picks which four survive rather than the array order deciding.
 */
const MAX_LIST_ITEMS = 4;
const MAX_EVIDENCE_ITEMS = 6;

function stringList(v: unknown, max = MAX_LIST_ITEMS): string[] {
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
  return out.slice(0, MAX_EVIDENCE_ITEMS);
}

/** At most twelve words, enforced rather than trusted. */
function clampVerdict(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const words = v.trim().split(/\s+/).filter(Boolean);
  return words.length === 0 ? null : words.slice(0, 12).join(" ");
}

/**
 * Three to five sentences, enforced by truncation.
 *
 * Only the upper bound can be enforced — a model that returns two sentences
 * has under-delivered and there is nothing to synthesise from. Truncating the
 * long case is what stops a "summary" becoming an essay.
 */
function clampSummary(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length <= 5) return trimmed;
  return sentences.slice(0, 5).join("").trim();
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

export type SessionRollup = {
  verdict: string | null;
  summary: string | null;
  confidence: Confidence;
};

/**
 * Ask the model for a verdict and summary across the whole interview.
 *
 * It is NOT asked to re-score: the overall number is computed in code from the
 * per-answer scores weighted by each question's weight, so the company's own
 * weighting decides it rather than the model's impression of the set. This
 * call exists because a verdict is a judgement about the whole, and one
 * derived arithmetically from per-answer numbers would be prose dressed up as
 * a conclusion.
 *
 * Returns nulls rather than throwing when the rollup fails — a session with
 * real per-answer scores and no summary is still useful, and losing the whole
 * scorecard because the last call failed would be the wrong trade.
 */
export async function summariseSession(input: {
  overall: number;
  answers: {
    questionText: string;
    competency: string | null;
    score: number;
    strengths: string[];
    concerns: string[];
  }[];
}): Promise<SessionRollup> {
  if (input.answers.length === 0) {
    return { verdict: null, summary: null, confidence: "low" };
  }

  const body = input.answers
    .map((a, i) =>
      [
        `### Question ${i + 1}${a.competency ? ` — ${a.competency}` : ""}`,
        a.questionText,
        `Score: ${a.score}`,
        a.strengths.length ? `Strengths: ${a.strengths.join("; ")}` : "",
        a.concerns.length ? `Concerns: ${a.concerns.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  try {
    const response = await getAnthropic().messages.create({
      model: resolveScoringModel(),
      max_tokens: 700,
      temperature: SCORING_TEMPERATURE,
      system: [{ type: "text", text: SESSION_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `Overall score (already computed, weighted): ${input.overall}\n\n${body}`,
        },
      ],
    });

    const block = response.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(stripCodeFences(raw)) as Record<string, unknown>;

    return {
      verdict: clampVerdict(parsed.verdict),
      summary: clampSummary(parsed.summary),
      confidence:
        parsed.confidence === "high" || parsed.confidence === "low"
          ? parsed.confidence
          : "medium",
    };
  } catch (err) {
    console.error("[interview-scoring] session rollup failed:", err);
    return { verdict: null, summary: null, confidence: "low" };
  }
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
  const scored: {
    score: number;
    weight: number;
    questionText: string;
    competency: string | null;
    strengths: string[];
    concerns: string[];
  }[] = [];
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

      scored.push({
        score: result.score,
        weight: meta.weight,
        questionText: meta.questionText,
        competency: meta.competency,
        strengths: result.strengths,
        concerns: result.concerns,
      });
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

  const rollup = await summariseSession({
    overall,
    answers: scored.map((s) => ({
      questionText: s.questionText,
      competency: s.competency,
      score: s.score,
      strengths: s.strengths,
      concerns: s.concerns,
    })),
  });

  /*
   * A partial set is disclosed in the summary rather than hidden. The model
   * was given only the answers that scored, so without this a summary reads
   * as a verdict on the whole interview when it covered three of five.
   */
  const coverage =
    scored.length === answers.length
      ? ""
      : ` Based on ${scored.length} of ${answers.length} answers — see the individual answers for why the rest were not scored.`;

  const { error: rollupErr } = await writeSessionScore({
    session_id: session.id,
    company_id: session.company_id,
    status: "scored",
    error: null,
    overall_score: overall,
    verdict: rollup.verdict,
    summary: rollup.summary ? `${rollup.summary}${coverage}` : coverage.trim() || null,
    // The rollup's own confidence, lowered when any answer failed outright —
    // a set with a hole in it is less trustworthy than the model can know.
    confidence: anyFailed ? "low" : rollup.confidence,
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
