import "server-only";
import { resolveInterviewScoringModel } from "@/lib/ai/interview-scoring";
import {
  LIVE_SCORING_PROMPT_VERSION,
  type LiveExchangeLine,
  type LiveQuestionScore,
  type ScoringCall,
  scoreLiveQuestion,
} from "@/lib/ai/live-interview-scoring";
import {
  CANDIDATE_TAG,
  type CandidateName,
  removeCandidateName,
} from "@/lib/interviews/candidate-name";
import { sanitizeCvForInterview } from "@/lib/interviews/cv-sanitize";
import { type FrozenLiveQuestion, readFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
import { isOutcomeDecided, type LiveOutcome } from "@/lib/interviews/live-ingest";
import {
  excludedFailedTurns,
  type LiveActionRow,
  type NeedsCheckDecision,
  needsCheckDecisions,
  repeatCheckDecisions,
  styleCheckDecisions,
} from "@/lib/interviews/live-resolutions";
import { hasRealWords } from "@/lib/interviews/live-transcribe";
import { JobYield, TerminalJobError, toJobError } from "@/lib/queue/failure-class";
import type { JobContext } from "@/lib/queue/job-context";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Score an AI Video Interview, question by question, into
 * live_interview_scores (migration 042).
 *
 * ── Eligibility, in code (planLiveScoring) ───────────────────
 *
 *   outcome not decided (isOutcomeDecided)  nothing is scored at all
 *   not_reached                             left out: no score, never zero
 *   a failed turn a person excluded         left out, never zero
 *   needs_check (suspect timing)            waits for a person; 'score' lets
 *                                           it through, 'exclude' leaves it out
 *   repeat_check (a repeat not asked as     waits for a person, answered or
 *   agreed: a hint may have shaped it)      skipped alike; 'score' lets it
 *                                           through, 'exclude' leaves it out
 *   skipped (asked, no real answer)         the lowest score, no AI call
 *   answered and confirmed                  scored by the AI
 *   ...whose rationale kept describing      waits for a person (style check);
 *   speaking style after a retry            'score' counts it, 'exclude' leaves
 *                                           it out
 *
 * The timing, repeat and style checks are SEPARATE flags on each question,
 * resolved by separate logged actions: resolving one never clears another.
 *
 * A failed transcription keeps the outcome undecided, so nothing is scored
 * until the turn is retried or a person excludes it: a failure never counts
 * against the candidate.
 *
 * ── The overall ──────────────────────────────────────────────
 *
 * The weighted average (frozen weight, Normal = 1) over the questions with a
 * score: AI-scored and skipped-at-lowest (0, decision D2). Left-out questions
 * are not in it. The row's status:
 *
 *   pending     not decided yet, or a question waits for a person
 *   scored      completed, partial or ending_unconfirmed, with at least
 *               one score: the overall
 *   incomplete  abandoned or technical_failure (per-question scores and
 *               evidence kept, NO overall: "Incomplete - X of 8 answered"),
 *               or any other interview with nothing scorable
 *
 * answered/total, skipped_count and completion % come from the outcome, so a
 * 0 for a skipped question reads differently from a 0 for a bad answer.
 * `partial` is set for every outcome short of completed, and for a completed
 * interview held from ranking (Sarah closed before asking every question): it
 * must never be ranked against a completed one (migrations 042 and 045;
 * nothing ranks from this table yet, and auto-shortlist does not read it).
 *
 * ── The attempt that counts ──────────────────────────────────
 *
 * A restart is a new session (migration 020). Every attempt is scored and kept
 * for audit, but only the LATEST attempt is ever the candidate's result:
 * countingLiveScore follows the restart link forward and returns the latest
 * attempt's row, pending or incomplete as it may be, never an earlier one.
 * Anything that shows or ranks a live score must read it through that.
 *
 * ── Its own switch ───────────────────────────────────────────
 *
 * LIVE_INTERVIEW_SCORING_ENABLED, off unless set to "true". Not the async
 * scorer's AI_INTERVIEW_SCORING_ENABLED: turning one on never turns on the
 * other.
 *
 * ── Once per question, never stale ───────────────────────────
 *
 * A question already AI-scored in the stored row is reused, never re-bought.
 * The row is written with a compare-and-set on `rev`; a writer that loses
 * reads again and keeps the AI results it already paid for. A retryable
 * provider failure leaves its question waiting, writes what was scored, and
 * rethrows so the queue retries; a terminal one leaves that question out.
 *
 * ── After retention ──────────────────────────────────────────
 *
 * Once a session's turns are purged there are no words to score: the scorer
 * does nothing, so it can never write quotes back (live-score-purge.ts clears
 * them).
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Transcripts, the exchange, guides, rationales, quotes. Logs carry ids,
 * counts and token totals.
 */

type Service = ReturnType<typeof createServiceClient>;

/** The bottom of the 0-100 scale: an asked question with no real answer. */
export const LOWEST_SCORE = 0;

/** Live scoring's own switch: off unless LIVE_INTERVIEW_SCORING_ENABLED is "true". */
export function liveScoringEnabled(): boolean {
  return process.env.LIVE_INTERVIEW_SCORING_ENABLED?.trim() === "true";
}

/** No overall for these, ever (migration 043). */
const NO_OVERALL_OUTCOMES: ReadonlySet<string> = new Set(["abandoned", "technical_failure"]);
const WRITE_TRIES = 5;

export type ScoreDecision = "ai" | "lowest" | "left_out" | "wait";
export type ScoreReason =
  | "not_final"
  | "needs_check"
  | "unconfirmed"
  | "no_guide"
  | "scoring_retry"
  | "not_reached"
  | "excluded_by_reviewer"
  | "transcription_excluded"
  | "scoring_failed"
  | "style_check"
  | "style_excluded"
  | "repeat_check"
  | "repeat_excluded"
  | "skipped"
  | "answered";

export type QuestionPlan = { position: number; decision: ScoreDecision; reason: ScoreReason };

/** Which questions are scored, and how. Pure. */
export function planLiveScoring(
  outcome: LiveOutcome | null,
  questions: readonly Pick<FrozenLiveQuestion, "position" | "scoring_guide">[],
  resolved: {
    needsCheck: ReadonlyMap<number, NeedsCheckDecision>;
    repeatCheck: ReadonlyMap<number, NeedsCheckDecision>;
    excludedPositions: ReadonlySet<number>;
  },
): QuestionPlan[] {
  const decided = isOutcomeDecided(outcome);
  return questions.map(({ position, scoring_guide }) => {
    const plan = (decision: ScoreDecision, reason: ScoreReason) => ({ position, decision, reason });
    if (!decided || !outcome) return plan("wait", "not_final");
    const f = outcome.questions.find((q) => q.position === position);
    if (!f || f.status === "not_reached") return plan("left_out", "not_reached");
    if (resolved.excludedPositions.has(position)) return plan("left_out", "transcription_excluded");
    if (f.needs_check) {
      const d = resolved.needsCheck.get(position);
      if (!d) return plan("wait", "needs_check");
      if (d === "exclude") return plan("left_out", "excluded_by_reviewer");
    }
    // Before the skipped rule: a hint can cause a skip as easily as an answer.
    if ((f.repeat_check ?? null) !== null) {
      const d = resolved.repeatCheck.get(position);
      if (!d) return plan("wait", "repeat_check");
      if (d === "exclude") return plan("left_out", "repeat_excluded");
    }
    if (f.status === "skipped") return plan("lowest", "skipped");
    if (f.confirmed !== true) return plan("wait", "unconfirmed");
    if (!scoring_guide) return plan("wait", "no_guide");
    return plan("ai", "answered");
  });
}

export type StoredQuestionScore = {
  position: number;
  source: string;
  competency: string | null;
  weight: number;
  status: "scored" | "lowest" | "left_out" | "waiting";
  reason: ScoreReason;
  score: number | null;
  confidence: string | null;
  rationale: string | null;
  quotes: string[];
  dropped_quotes: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  scored_at: string | null;
  /** The question's TIMING check (suspect turn timing, from the outcome). */
  timing_check: boolean;
  /**
   * The question's STYLE check: its rationale kept describing speaking style
   * after a retry, so those sentences were removed and a person must look.
   */
  style_check: boolean;
  /** Set by retention: the rationale and quotes were cleared, the numbers kept. */
  content_purged?: boolean;
  // `status` decides what counts: only 'scored' and 'lowest' are in the
  // overall. A 'left_out' or 'waiting' question may still hold the AI result
  // already paid for (score, rationale, quotes), never counted while it is.
};

/** The weighted average over questions with a score. Null when none has one. Pure. */
export function overallFrom(entries: readonly StoredQuestionScore[]): {
  overall: number | null;
  scored_count: number;
} {
  const scored = entries.filter(
    (e) => (e.status === "scored" || e.status === "lowest") && e.score !== null,
  );
  if (scored.length === 0) return { overall: null, scored_count: 0 };
  const weight = scored.reduce((s, e) => s + e.weight, 0);
  const sum = scored.reduce((s, e) => s + (e.score as number) * e.weight, 0);
  return { overall: Math.round(sum / weight), scored_count: scored.length };
}

/**
 * The row's status (migration 043). Pending until decided and nothing waits;
 * then incomplete for abandoned or technical_failure, or when nothing could be
 * scored; otherwise scored. Pure.
 */
export function rowStatus(
  outcome: string | null,
  waiting: boolean,
  scoredCount: number,
): "pending" | "scored" | "incomplete" {
  if (outcome === null || waiting) return "pending";
  if (NO_OVERALL_OUTCOMES.has(outcome) || scoredCount === 0) return "incomplete";
  return "scored";
}

/* ── the exchange ─────────────────────────────────────────────── */

export type ScoringTurn = {
  id: string;
  sequence: number;
  speaker: string;
  kind: string | null;
  question_position: number | null;
  responds_to_turn_id: string | null;
  text: string | null;
  transcript: string | null;
  transcript_status: string | null;
  transcript_segments: unknown;
  content_purged_at: string | null;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Contact details and the candidate's name out of any line, the interviewer's
 * included. removeCandidateName takes the full name and surname; the first
 * name alone is taken here too, because the interviewer greets the candidate
 * by it ("Hi Alex"). Capitalised, whole word only, so "will" in a sentence is
 * never touched by a candidate called Will.
 */
function scrub(text: string, name: CandidateName): string {
  let out = removeCandidateName(sanitizeCvForInterview(text).text, name).text;
  for (const given of (name.firstName ?? "").split(/[\s.-]+/).filter((g) => g.length >= 2)) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(given)}(?![\\p{L}\\p{N}])`, "gu"),
      CANDIDATE_TAG,
    );
  }
  return out.trim();
}

/**
 * One question's exchange, in turn order: the interviewer's question, follow-
 * ups and clarifications, and the candidate's transcribed answers. Procedural
 * turns (repeats, silence reminders) and filler-only answers are left out.
 * Text only: no turn kind, index, count or reason travels. Pure.
 */
export function exchangeFor(
  position: number,
  turns: readonly ScoringTurn[],
  name: CandidateName,
): LiveExchangeLine[] {
  const byId = new Map(turns.map((t) => [t.id, t]));
  const positionOf = (t: ScoringTurn) =>
    t.question_position ??
    (t.responds_to_turn_id ? (byId.get(t.responds_to_turn_id)?.question_position ?? null) : null);
  const lines: LiveExchangeLine[] = [];
  for (const t of [...turns].sort((a, b) => a.sequence - b.sequence)) {
    if (positionOf(t) !== position) continue;
    if (t.speaker === "interviewer") {
      if (!["base_question", "follow_up", "clarification"].includes(t.kind ?? "")) continue;
      const text = scrub(t.text ?? "", name);
      if (text) lines.push({ speaker: "interviewer", text });
    } else if (t.speaker === "candidate" && t.transcript_status === "done") {
      const segments = Array.isArray(t.transcript_segments)
        ? (t.transcript_segments as {
            start: number;
            end: number;
            text: string;
            noSpeech?: number;
          }[])
        : null;
      if (!hasRealWords(t.transcript, segments)) continue;
      const text = scrub(t.transcript ?? "", name);
      if (text) lines.push({ speaker: "candidate", text });
    }
  }
  return lines;
}

/* ── the session ──────────────────────────────────────────────── */

export type LiveScoringDeps = {
  service: Service;
  /** The model call. Defaults to the scoring transport. */
  call?: ScoringCall;
  /** Defaults to AI_INTERVIEW_SCORING_ENABLED. */
  enabled?: boolean;
  now?: () => number;
};

export type LiveScoreRow = {
  session_id: string;
  company_id: string;
  status: "pending" | "scored" | "incomplete" | "failed";
  questions: StoredQuestionScore[];
  overall_score: number | null;
  scored_count: number;
  answered_count: number;
  skipped_count: number;
  total: number;
  completion_percent: number;
  outcome: string | null;
  partial: boolean;
  ai_model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  rev: number;
  scored_at: string | null;
  updated_at: string;
};

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  kind: string | null;
  live_outcome: LiveOutcome | null;
  live_settings: unknown;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
};

export class LiveScoringError extends Error {
  readonly code: "not_found" | "not_live" | "not_frozen" | "db_error" | "write_lost";
  constructor(code: LiveScoringError["code"], sessionId: string) {
    super(`live scoring: ${code} (session ${sessionId})`);
    this.name = "LiveScoringError";
    this.code = code;
  }
}

/**
 * Work out what can be scored, score what is newly eligible, and store the
 * session's row. Returns the stored row, or null when scoring is off or the
 * session's words are purged.
 */
export async function scoreLiveSession(
  sessionId: string,
  deps: LiveScoringDeps,
  ctx?: JobContext,
): Promise<LiveScoreRow | null> {
  const { service } = deps;
  const now = deps.now ?? Date.now;
  const { data: sData, error: sErr } = await service
    .from("interview_sessions")
    .select(
      "id, company_id, application_id, job_id, kind, live_outcome, live_settings, questions_snapshot, scoring_snapshot",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) throw new LiveScoringError("db_error", sessionId);
  const session = sData as SessionRow | null;
  if (!session) throw new LiveScoringError("not_found", sessionId);
  if (session.kind !== "live") throw new LiveScoringError("not_live", sessionId);
  if (!(deps.enabled ?? liveScoringEnabled())) {
    console.log(
      `[live-scoring] session ${sessionId}: scoring is off (LIVE_INTERVIEW_SCORING_ENABLED)`,
    );
    return null;
  }
  const frozen = readFrozenQuestionSet(session);
  if (!frozen) throw new LiveScoringError("not_frozen", sessionId);

  const { data: tData, error: tErr } = await service
    .from("interview_turns")
    .select(
      "id, sequence, speaker, kind, question_position, responds_to_turn_id, text, transcript, transcript_status, transcript_segments, content_purged_at",
    )
    .eq("session_id", sessionId);
  if (tErr) throw new LiveScoringError("db_error", sessionId);
  const turns = (tData ?? []) as ScoringTurn[];
  if (turns.some((t) => t.content_purged_at !== null)) {
    console.log(`[live-scoring] session ${sessionId}: content purged, nothing to score`);
    return null;
  }

  const { data: aData, error: aErr } = await service
    .from("live_interview_actions")
    .select("action, decision, question_position, turn_id, turn_sequence, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (aErr) throw new LiveScoringError("db_error", sessionId);
  const actions = (aData ?? []) as LiveActionRow[];

  const candidateTurns = turns.filter((t) => t.speaker === "candidate");
  const excludedSeqs = excludedFailedTurns(actions, candidateTurns);
  const byId = new Map(turns.map((t) => [t.id, t]));
  const excludedPositions = new Set<number>();
  for (const t of candidateTurns) {
    if (!excludedSeqs.has(t.sequence)) continue;
    const p =
      t.question_position ??
      (t.responds_to_turn_id ? byId.get(t.responds_to_turn_id)?.question_position : null);
    if (typeof p === "number") excludedPositions.add(p);
  }
  const outcome = session.live_outcome;
  const timingChecked = new Set(
    (outcome?.questions ?? []).filter((x) => x.needs_check).map((x) => x.position),
  );
  const styleChecks = styleCheckDecisions(actions);
  const plans = planLiveScoring(outcome, frozen.questions, {
    needsCheck: needsCheckDecisions(actions),
    repeatCheck: repeatCheckDecisions(actions),
    excludedPositions,
  });

  let name: CandidateName = { firstName: null, lastName: null };
  if (plans.some((p) => p.decision === "ai") && session.application_id) {
    const { data: app } = await service
      .from("job_applications")
      .select("first_name, last_name")
      .eq("id", session.application_id)
      .eq("company_id_snapshot", session.company_id)
      .maybeSingle();
    const a = app as { first_name: string | null; last_name: string | null } | null;
    name = { firstName: a?.first_name ?? null, lastName: a?.last_name ?? null };
  }

  const model = resolveInterviewScoringModel();
  const paid = new Map<number, LiveQuestionScore>();
  let retryLater: unknown = null;

  for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
    const { data: rData, error: rErr } = await service
      .from("live_interview_scores")
      .select("session_id, questions, rev")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (rErr) throw new LiveScoringError("db_error", sessionId);
    const stored = rData as { questions: StoredQuestionScore[]; rev: number } | null;
    const before = new Map((stored?.questions ?? []).map((q) => [q.position, q]));

    const entries: StoredQuestionScore[] = [];
    for (const plan of plans) {
      const q = frozen.questions.find((x) => x.position === plan.position) as FrozenLiveQuestion;
      const base = {
        position: q.position,
        source: q.source,
        competency: q.competency,
        weight: q.weight ?? 1,
        timing_check: timingChecked.has(q.position),
        style_check: false,
      };
      const empty = {
        score: null,
        confidence: null,
        rationale: null,
        quotes: [],
        dropped_quotes: 0,
        model: null,
        input_tokens: 0,
        output_tokens: 0,
        scored_at: null,
      };
      if (plan.decision === "lowest") {
        entries.push({
          ...base,
          ...empty,
          status: "lowest",
          reason: plan.reason,
          score: LOWEST_SCORE,
          scored_at: before.get(q.position)?.scored_at ?? new Date(now()).toISOString(),
        });
        continue;
      }
      const had = before.get(q.position);
      if (plan.decision !== "ai") {
        // An AI result already paid for stays with the question, never counted
        // while it is left out or waiting: a person who changes their mind
        // later gets the same result, with the same style check, not a new one.
        const held =
          had && had.model !== null && had.score !== null
            ? {
                score: had.score,
                confidence: had.confidence,
                rationale: had.rationale,
                quotes: had.quotes,
                dropped_quotes: had.dropped_quotes,
                model: had.model,
                input_tokens: had.input_tokens,
                output_tokens: had.output_tokens,
                scored_at: had.scored_at,
                style_check: had.style_check,
              }
            : {};
        entries.push({
          ...base,
          ...empty,
          ...held,
          status: plan.decision === "wait" ? "waiting" : "left_out",
          reason: plan.reason,
        });
        continue;
      }
      // An AI result already stored (counted, held for a style check, or held
      // while a person had it left out) is reused, never re-bought.
      let result: LiveQuestionScore | undefined =
        had && had.model !== null && had.score !== null
          ? {
              score: had.score,
              confidence: had.confidence as LiveQuestionScore["confidence"],
              rationale: had.rationale ?? "",
              quotes: had.quotes,
              dropped_quotes: had.dropped_quotes,
              style_flagged: had.style_check,
              model: had.model,
              input_tokens: had.input_tokens,
              output_tokens: had.output_tokens,
            }
          : paid.get(q.position);
      if (!result && !retryLater) {
        try {
          result = await scoreLiveQuestion(
            {
              question: q.text,
              competency: q.competency,
              guide: q.scoring_guide as string,
              exchange: exchangeFor(q.position, turns, name),
            },
            { call: deps.call },
            ctx,
          );
          paid.set(q.position, result);
        } catch (err) {
          if (err instanceof JobYield) throw err;
          const jobErr = toJobError(err);
          if (jobErr instanceof TerminalJobError && jobErr.failureClass === "deterministic") {
            console.error(`[live-scoring] session ${sessionId} q${q.position}: scoring failed`);
            entries.push({ ...base, ...empty, status: "left_out", reason: "scoring_failed" });
            continue;
          }
          // Retryable, billing or configuration: keep it waiting, store the
          // rest, and hand the error to the queue.
          retryLater = jobErr;
        }
      }
      if (!result) {
        entries.push({ ...base, ...empty, status: "waiting", reason: "scoring_retry" });
        continue;
      }
      // The style check is its own flag, resolved only by resolve_style_check.
      const styleDecision = result.style_flagged ? styleChecks.get(q.position) : "score";
      entries.push({
        ...base,
        style_check: result.style_flagged,
        status: !styleDecision ? "waiting" : styleDecision === "exclude" ? "left_out" : "scored",
        reason: !styleDecision
          ? "style_check"
          : styleDecision === "exclude"
            ? "style_excluded"
            : "answered",
        score: result.score,
        confidence: result.confidence,
        rationale: result.rationale || null,
        quotes: result.quotes,
        dropped_quotes: result.dropped_quotes,
        model: result.model,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        scored_at: had?.scored_at ?? new Date(now()).toISOString(),
      });
    }

    const { overall, scored_count } = overallFrom(entries);
    const waiting = entries.some((e) => e.status === "waiting");
    const decided = isOutcomeDecided(outcome) && outcome !== null;
    const status = rowStatus(decided ? outcome.outcome : null, waiting, scored_count);
    const stamp = new Date(now()).toISOString();
    const row: LiveScoreRow = {
      session_id: sessionId,
      company_id: session.company_id,
      status,
      questions: entries,
      overall_score: status === "scored" ? overall : null,
      scored_count,
      answered_count: outcome?.answered_count ?? 0,
      skipped_count: outcome?.skipped_count ?? 0,
      total: outcome?.total ?? frozen.questions.length,
      completion_percent: outcome?.completion_percent ?? 0,
      outcome: decided ? outcome.outcome : null,
      // Never ranked against completed: short of completed, or completed but held (D2).
      partial: decided
        ? outcome.outcome !== "completed" || outcome.held_from_ranking === true
        : false,
      ai_model: model,
      prompt_version: LIVE_SCORING_PROMPT_VERSION,
      input_tokens: entries.reduce((s, e) => s + e.input_tokens, 0),
      output_tokens: entries.reduce((s, e) => s + e.output_tokens, 0),
      rev: (stored?.rev ?? -1) + 1,
      scored_at: status === "scored" || status === "incomplete" ? stamp : null,
      updated_at: stamp,
    };

    const write = stored
      ? service
          .from("live_interview_scores")
          .update(row)
          .eq("session_id", sessionId)
          .eq("rev", stored.rev)
          .select("session_id")
      : service.from("live_interview_scores").insert(row).select("session_id");
    const { data: landed, error: wErr } = await write;
    if (wErr && wErr.code !== "23505") throw new LiveScoringError("db_error", sessionId);
    if (!wErr && ((landed ?? []) as unknown[]).length > 0) {
      console.log(
        `[live-scoring] session ${sessionId}: ${row.status}, scored ${row.scored_count}, waiting ${entries.filter((e) => e.status === "waiting").length}, calls ${paid.size}, tokens ${row.input_tokens}/${row.output_tokens}`,
      );
      if (retryLater) throw retryLater;
      return row;
    }
    // Another writer landed first: read again, keeping what was paid for.
  }
  throw new LiveScoringError("write_lost", sessionId);
}

/** The `ai_scorecard` job for a live session (routed here by interview-scoring.ts). */
export async function handleLiveScorecard(
  job: { id: string; payload: Record<string, unknown> },
  ctx?: JobContext,
): Promise<void> {
  const sessionId = job.payload?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(`ai_scorecard (live): payload.sessionId missing (job ${job.id})`);
  }
  await scoreLiveSession(sessionId, { service: createServiceClient() }, ctx);
}

export type EnqueueScorecard = (input: {
  type: "ai_scorecard";
  companyId: string;
  payload: { sessionId: string };
}) => Promise<{ ok: boolean; code?: string }>;

/**
 * Queue the session's scorecard, once: a 23505 from the ai_scorecard unique
 * index (migration 027) means it is already queued. Returns whether one is
 * queued now.
 */
export async function requestLiveScoring(
  service: Service,
  sessionId: string,
  enqueue?: EnqueueScorecard,
): Promise<boolean> {
  if (!liveScoringEnabled()) return false;
  const { data } = await service
    .from("interview_sessions")
    .select("id, company_id, kind")
    .eq("id", sessionId)
    .maybeSingle();
  const s = data as { company_id: string; kind: string } | null;
  if (s?.kind !== "live") return false;
  const send = enqueue ?? ((await import("@/lib/jobs-queue")).enqueue as EnqueueScorecard);
  const result = await send({
    type: "ai_scorecard",
    companyId: s.company_id,
    payload: { sessionId },
  });
  return result.ok || result.code === "23505";
}

/* ── the attempt that counts ──────────────────────────────────── */

/** A restart never chains past this many attempts (migration 020 allows two). */
const MAX_ATTEMPTS = 5;

export type CountingLiveScore = {
  /** The latest attempt: the only one that is ever the candidate's result. */
  session_id: string;
  attempt: number;
  /** Earlier attempts, oldest first. Kept for audit; never shown or ranked. */
  superseded: string[];
  /** The latest attempt's status: 'pending' until it has a row. */
  status: LiveScoreRow["status"];
  /** The latest attempt's row, or null while it has none. Never an earlier attempt's. */
  score: LiveScoreRow | null;
};

/**
 * The live score that counts for the candidate of this session: the latest
 * attempt's, following restarts forward (previous_attempt_id), whatever its
 * state. Scoped to the company at every read. Null when the session is not
 * this company's live session.
 */
export async function countingLiveScore(
  service: Service,
  companyId: string,
  sessionId: string,
): Promise<CountingLiveScore | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("id, attempt, kind")
    .eq("id", sessionId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new LiveScoringError("db_error", sessionId);
  let current = data as { id: string; attempt: number | null; kind: string | null } | null;
  if (current?.kind !== "live") return null;
  const superseded: string[] = [];
  for (let hop = 0; hop < MAX_ATTEMPTS; hop++) {
    const { data: next, error: nErr } = await service
      .from("interview_sessions")
      .select("id, attempt, kind")
      .eq("previous_attempt_id", current.id)
      .eq("company_id", companyId)
      .eq("kind", "live")
      .maybeSingle();
    if (nErr) throw new LiveScoringError("db_error", sessionId);
    if (!next) break;
    superseded.push(current.id);
    current = next as { id: string; attempt: number | null; kind: string | null };
  }
  const { data: row, error: rErr } = await service
    .from("live_interview_scores")
    .select("*")
    .eq("session_id", current.id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (rErr) throw new LiveScoringError("db_error", sessionId);
  const score = (row as LiveScoreRow | null) ?? null;
  return {
    session_id: current.id,
    attempt: current.attempt ?? 1,
    superseded,
    status: score?.status ?? "pending",
    score,
  };
}
