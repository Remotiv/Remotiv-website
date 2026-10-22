import "server-only";
import {
  isOutcomeDecided,
  type LiveOutcome,
  type LiveQuestionFacts,
  needsReview,
  outcomeFrom,
} from "@/lib/interviews/live-ingest";
import { excludedFailedTurns, type LiveActionRow } from "@/lib/interviews/live-resolutions";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import { type TranscriptSegment, toStoredSegments } from "@/lib/interviews/transcribe";
import {
  logProviderCall,
  MIN_PROVIDER_CALL_BUDGET_MS,
  providerTimeoutMs,
} from "@/lib/queue/budgets";
import {
  classifyProviderError,
  ProviderHttpError,
  safeFailureSentence,
  TerminalJobError,
} from "@/lib/queue/failure-class";
import { assertProviderBudget, type JobContext } from "@/lib/queue/job-context";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Transcribe each CANDIDATE turn of an AI Video Interview, confirm its
 * answer, and settle live_outcome (migration 041) once every turn is done.
 *
 * ── The job: the existing `transcribe` type, with a turn payload ──
 *
 * `{ turnId, sessionId }` instead of `{ answerId, recordedAt }`.
 * handleTranscribe (transcribe.ts) hands such a payload here and nothing else
 * changes for async answers. A new job type would mean altering
 * background_jobs_type_check, a migration; reusing `transcribe` also reuses
 * the queue's retries, backoff and dead letter as they are.
 *
 * ── Only the candidate ───────────────────────────────────────
 *
 * The interviewer's words are already the exact text the provider generated.
 * A job for an interviewer turn does nothing, and requestLiveTranscription
 * never queues one.
 *
 * ── The confirm rule ─────────────────────────────────────────
 *
 * An answered question is CONFIRMED when one of its candidate turns has at
 * least one real word: not empty, not only fillers (um, uh, hmm, ah...), and
 * not a transcript Whisper invented over silence (every segment's
 * no_speech_prob at NO_SPEECH_MIN or above). No length minimum: "Yes, three
 * years" confirms. A question whose candidate turns are all transcribed with
 * no real word is downgraded to skipped, and the outcome is worked out again.
 *
 * ── Final ────────────────────────────────────────────────────
 *
 * live_outcome.final becomes true only when EVERY candidate turn is
 * transcribed. Until then the outcome is not decided: restart eligibility is
 * null and nothing may be scored from it. A turn that fails for good (every
 * retry used, or a failure no retry can fix) is marked failed, the outcome
 * stays final: false, transcription_failed_turns lists it and needs_review is
 * set: a person must look.
 * No turn is ever dropped. A person may retry it, or exclude its question
 * (live-recovery.ts); an excluded failed turn counts as resolved for `final`,
 * and its question is left out of scoring, never zero.
 *
 * ── Scoring, once decided ────────────────────────────────────
 *
 * The settle that makes the outcome decided asks for the session's scorecard
 * (live-scoring.ts), when live scoring is on (LIVE_INTERVIEW_SCORING_ENABLED). It does not know or care
 * where the transcripts came from.
 *
 * ── Never overwritten, never stale ───────────────────────────
 *
 * A transcript is written only while the turn is pending or failed, so a
 * finished one is never replaced. The outcome is written with a
 * compare-and-set on settle_rev: a settle that read older turn states loses
 * and reads again, so two turns finishing at once cannot leave a stale
 * outcome behind.
 *
 * ── timing_suspect ───────────────────────────────────────────
 *
 * Still transcribed. The question keeps needs_check from the save
 * (live-ingest.ts) and the session keeps needs_review. For commit 7 (scoring):
 * a question is scored only when isOutcomeDecided(outcome) AND it has no
 * needs_check; a needs_check question waits for a person to check the audio.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Transcripts, file paths. Logs carry turn and session ids and counts.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Whisper's own ceiling, as for async answers. */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
/** At or above this on every segment, Whisper heard silence and wrote something anyway. */
export const NO_SPEECH_MIN = 0.8;
/** Settles retried after losing a compare-and-set, at most. */
const SETTLE_TRIES = 5;

/** Sounds, not words. Lower-case, letters only. */
const FILLERS: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "uhm",
  "uh",
  "uhh",
  "er",
  "erm",
  "hmm",
  "hm",
  "mm",
  "mmm",
  "mhm",
  "ah",
  "ahh",
  "eh",
  "oh",
]);

/** Whether a transcript holds at least one real word. */
export function hasRealWords(
  transcript: string | null | undefined,
  segments: readonly TranscriptSegment[] | null | undefined,
): boolean {
  const words = (
    String(transcript ?? "")
      .toLowerCase()
      .match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? []
  ).filter((w) => !FILLERS.has(w.replace(/['’]/g, "")));
  if (words.length === 0) return false;
  // Whisper fills silence with "Thank you." and the like; its own signal says so.
  if (
    segments &&
    segments.length > 0 &&
    segments.every((s) => typeof s.noSpeech === "number" && s.noSpeech >= NO_SPEECH_MIN)
  ) {
    return false;
  }
  return true;
}

/* ── settling the outcome ─────────────────────────────────────── */

/** What settling needs of a candidate turn, its question resolved. */
export type CandidateTurnState = {
  sequence: number;
  position: number | null;
  transcript_status: string | null;
  transcript: string | null;
  transcript_segments: TranscriptSegment[] | null;
};

/**
 * The outcome with every answered question settled against its transcripts,
 * and final set from the turns: every one transcribed, or failed and excluded
 * by a person (`excluded`, by sequence). Pure.
 */
export function settleOutcome(
  outcome: LiveOutcome,
  turns: readonly CandidateTurnState[],
  attempt: number,
  excluded: ReadonlySet<number> = new Set(),
): LiveOutcome {
  const questions: LiveQuestionFacts[] = outcome.questions.map((q) => {
    if (q.status !== "answered") return q;
    const mine = turns.filter((t) => t.position === q.position);
    if (
      mine.some(
        (t) => t.transcript_status === "done" && hasRealWords(t.transcript, t.transcript_segments),
      )
    ) {
      return { ...q, confirmed: true };
    }
    if (mine.length > 0 && mine.every((t) => t.transcript_status === "done")) {
      return { ...q, status: "skipped", confirmed: null };
    }
    return { ...q, confirmed: false };
  });
  const failed = turns.filter((t) => t.transcript_status === "failed").map((t) => t.sequence);
  const final = turns.every(
    (t) =>
      t.transcript_status === "done" ||
      (t.transcript_status === "failed" && excluded.has(t.sequence)),
  );
  // Usable: every transcript done. One a person left out after it failed is
  // still a lost answer (D2: provider_error then means technical_failure).
  const usable = final && turns.every((t) => t.transcript_status === "done");
  const fields = outcomeFrom(questions, outcome.provider_status_code, attempt, final, usable);
  return {
    ...outcome,
    questions,
    answers_usable: usable,
    needs_review: needsReview(questions, failed, fields.end_check),
    transcription_failed_turns: failed.sort((a, b) => a - b),
    settle_rev: (outcome.settle_rev ?? 0) + 1,
    ...fields,
  };
}

type TurnRow = {
  id: string;
  sequence: number;
  speaker: string;
  question_position: number | null;
  responds_to_turn_id: string | null;
  transcript_status: string | null;
  transcript: string | null;
  transcript_segments: TranscriptSegment[] | null;
};

/** Called once, by the settle that makes the outcome decided. */
export type OnDecided = (service: Service, sessionId: string) => Promise<void>;

/**
 * Ask for the scorecard. Reads live scoring's own switch
 * (LIVE_INTERVIEW_SCORING_ENABLED, as live-scoring.ts does) here, so that with
 * it off the scorer is never even loaded.
 */
const requestScoringWhenDecided: OnDecided = async (service, sessionId) => {
  if (process.env.LIVE_INTERVIEW_SCORING_ENABLED?.trim() !== "true") return;
  const { requestLiveScoring } = await import("@/lib/interviews/live-scoring");
  await requestLiveScoring(service, sessionId);
};

/**
 * Read the session's turns, recovery log and outcome, settle, and write it
 * back with a compare-and-set on settle_rev; on losing, read again. Returns
 * the stored outcome, or null when the session has none.
 */
export async function settleLiveOutcome(
  service: Service,
  sessionId: string,
  opts: { onDecided?: OnDecided } = {},
): Promise<LiveOutcome | null> {
  for (let i = 0; i < SETTLE_TRIES; i++) {
    const { data: session, error: sErr } = await service
      .from("interview_sessions")
      .select("id, attempt, live_outcome")
      .eq("id", sessionId)
      .maybeSingle();
    if (sErr) throw new Error(`live transcribe: session read failed (${sErr.code ?? "db"})`);
    const s = session as { attempt: number | null; live_outcome: LiveOutcome | null } | null;
    if (!s?.live_outcome) return null;

    const { data: actionRows, error: aErr } = await service
      .from("live_interview_actions")
      .select("action, decision, question_position, turn_id, turn_sequence, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    if (aErr) throw new Error(`live transcribe: action read failed (${aErr.code ?? "db"})`);

    const { data: rows, error: tErr } = await service
      .from("interview_turns")
      .select(
        "id, sequence, speaker, question_position, responds_to_turn_id, transcript_status, transcript, transcript_segments",
      )
      .eq("session_id", sessionId);
    if (tErr) throw new Error(`live transcribe: turn read failed (${tErr.code ?? "db"})`);
    const all = (rows ?? []) as TurnRow[];
    const byId = new Map(all.map((t) => [t.id, t]));
    const candidates = all
      .filter((t) => t.speaker === "candidate")
      .map((t) => ({
        sequence: t.sequence,
        position:
          t.question_position ??
          (t.responds_to_turn_id
            ? (byId.get(t.responds_to_turn_id)?.question_position ?? null)
            : null),
        transcript_status: t.transcript_status,
        transcript: t.transcript,
        transcript_segments: t.transcript_segments,
      }));

    const excluded = excludedFailedTurns(
      (actionRows ?? []) as LiveActionRow[],
      all.filter((t) => t.speaker === "candidate"),
    );
    const before = s.live_outcome;
    const next = settleOutcome(before, candidates, s.attempt ?? 1, excluded);
    let write = service
      .from("interview_sessions")
      .update({ live_outcome: next })
      .eq("id", sessionId);
    // Lands only on the outcome this settle read; an outcome saved before
    // settle_rev existed has none.
    write =
      before.settle_rev === undefined
        ? write.is("live_outcome->settle_rev", null)
        : write.eq("live_outcome->>settle_rev", String(before.settle_rev));
    const { data: landed, error: wErr } = await write.select("id");
    if (wErr) throw new Error(`live transcribe: outcome write failed (${wErr.code ?? "db"})`);
    if (((landed ?? []) as unknown[]).length > 0) {
      if (!isOutcomeDecided(before) && isOutcomeDecided(next)) {
        await (opts.onDecided ?? requestScoringWhenDecided)(service, sessionId);
      }
      return next;
    }
  }
  throw new Error("live transcribe: the outcome kept changing under the settle");
}

/* ── queueing ─────────────────────────────────────────────────── */

export type EnqueueTranscribe = (input: {
  type: "transcribe";
  companyId: string;
  payload: { turnId: string; sessionId: string };
}) => Promise<{ ok: boolean }>;

/**
 * Queue one transcribe job per candidate turn still pending, skipping turns
 * that already have a queued or running job. Interviewer turns are never
 * queued. Returns how many were queued.
 */
export async function requestLiveTranscription(
  service: Service,
  sessionId: string,
  enqueue: EnqueueTranscribe,
): Promise<number> {
  const { data: session } = await service
    .from("interview_sessions")
    .select("id, company_id, kind")
    .eq("id", sessionId)
    .maybeSingle();
  const s = session as { company_id: string; kind: string } | null;
  if (s?.kind !== "live") return 0;
  const { data: turns, error } = await service
    .from("interview_turns")
    .select("id")
    .eq("session_id", sessionId)
    .eq("speaker", "candidate")
    .eq("transcript_status", "pending");
  if (error) throw new Error(`live transcribe: pending read failed (${error.code ?? "db"})`);
  const { data: jobs } = await service
    .from("background_jobs")
    .select("payload")
    .eq("type", "transcribe")
    .in("status", ["queued", "running"])
    .eq("payload->>sessionId", sessionId);
  const live = new Set(
    ((jobs ?? []) as { payload: { turnId?: string } }[]).map((j) => j.payload?.turnId),
  );
  let queued = 0;
  for (const t of (turns ?? []) as { id: string }[]) {
    if (live.has(t.id)) continue;
    const result = await enqueue({
      type: "transcribe",
      companyId: s.company_id,
      payload: { turnId: t.id, sessionId },
    });
    if (result.ok) queued += 1;
  }
  return queued;
}

/* ── the job ──────────────────────────────────────────────────── */

export type WhisperResult = { text: string; segments: TranscriptSegment[] };
export type Transcriber = (
  audio: { bytes: Uint8Array; mime: string; ext: string },
  ctx?: JobContext,
) => Promise<WhisperResult>;

export type LiveTranscribeDeps = {
  service: Service;
  transcribe: Transcriber;
  /** What the settle that decides the outcome does next. Defaults to asking for the scorecard. */
  onDecided?: OnDecided;
};

type JobLike = {
  id: string;
  payload: Record<string, unknown>;
  attempts?: number;
  max_attempts?: number;
};

/** Whisper, as the async path calls it: English, verbose_json, segment timings, the file's real type. */
export const whisperTranscribe: Transcriber = async ({ bytes, mime, ext }, ctx) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new TerminalJobError("configuration", "transcribe: OPENAI_API_KEY is not configured");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `turn.${ext}`);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("language", "en");
  assertProviderBudget(ctx, MIN_PROVIDER_CALL_BUDGET_MS, "live transcribe before Whisper call");
  const remainingAtStart = ctx ? ctx.remainingMs() : null;
  const started = Date.now();
  const log = (outcome: "ok" | "error" | "aborted", status: number | null = null) =>
    logProviderCall({
      jobType: "transcribe",
      provider: "openai-whisper",
      model: "whisper-1",
      durationMs: Date.now() - started,
      remainingAtStartMs: remainingAtStart,
      outcome,
      status,
    });
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(providerTimeoutMs(remainingAtStart ?? 600_000));
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctx ? AbortSignal.any([ctx.signal, timeout]) : timeout,
    });
  } catch (err) {
    log(ctx?.signal.aborted ? "aborted" : "error");
    throw err;
  }
  if (!res.ok) {
    log("error", res.status);
    throw new ProviderHttpError("OpenAI", res.status, (await res.text()).slice(0, 500));
  }
  log("ok");
  const json = (await res.json()) as { text?: string; segments?: unknown };
  return { text: (json.text ?? "").trim(), segments: toStoredSegments(json.segments) };
};

function defaultDeps(): LiveTranscribeDeps {
  return { service: createServiceClient(), transcribe: whisperTranscribe };
}

async function markTurnFailed(service: Service, turnId: string, message: string): Promise<void> {
  const { error } = await service
    .from("interview_turns")
    .update({ transcript_status: "failed", transcript_error: message.slice(0, 1000) })
    .eq("id", turnId)
    .in("transcript_status", ["pending", "failed"]);
  if (error) throw new Error(`live transcribe: failure write failed (${error.code ?? "db"})`);
}

/** One `transcribe` job with a `{ turnId }` payload. */
export async function handleLiveTurnTranscribe(
  job: JobLike,
  ctx?: JobContext,
  deps: LiveTranscribeDeps = defaultDeps(),
): Promise<void> {
  const turnId = typeof job.payload.turnId === "string" ? job.payload.turnId : "";
  if (!turnId) throw new TerminalJobError("deterministic", "transcribe: payload.turnId missing");
  const { service } = deps;

  const { data } = await service
    .from("interview_turns")
    .select("id, session_id, sequence, speaker, media_path, media_mime_type, transcript_status")
    .eq("id", turnId)
    .maybeSingle();
  const turn = data as {
    id: string;
    session_id: string;
    sequence: number;
    speaker: string;
    media_path: string | null;
    media_mime_type: string;
    transcript_status: string | null;
  } | null;
  if (!turn) return; // deleted with its session: nothing to do, ever
  if (turn.speaker !== "candidate") {
    console.warn(`[live-transcribe] turn ${turnId} is the interviewer's: never transcribed`);
    return;
  }
  // Done is final: a finished transcript is never replaced. Settle anyway, in
  // case the run that wrote it stopped before settling.
  if (turn.transcript_status === "done" || !turn.media_path) {
    await settleLiveOutcome(service, turn.session_id, { onDecided: deps.onDecided });
    return;
  }

  const lastAttempt =
    typeof job.attempts === "number" && typeof job.max_attempts === "number"
      ? job.attempts + 1 >= job.max_attempts
      : false;
  const giveUp = async (message: string) => {
    await markTurnFailed(service, turnId, message);
    await settleLiveOutcome(service, turn.session_id, { onDecided: deps.onDecided });
    console.error(`[live-transcribe] turn ${turnId}: transcription failed for good`);
  };

  const { data: blob, error: dErr } = await service.storage
    .from(INTERVIEW_BUCKET)
    .download(turn.media_path);
  if (dErr || !blob) {
    if (lastAttempt) await giveUp("The turn's audio could not be read.");
    throw new Error(`live transcribe: download failed for turn ${turnId}`);
  }
  const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
  if (bytes.byteLength > WHISPER_MAX_BYTES) {
    await giveUp("The turn's audio is over the transcription limit.");
    throw new TerminalJobError("deterministic", `transcribe: turn ${turnId} audio too large`);
  }
  const ext = (turn.media_path.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "wav").toLowerCase();

  let result: WhisperResult;
  try {
    result = await deps.transcribe({ bytes, mime: turn.media_mime_type, ext }, ctx);
  } catch (err) {
    const c = classifyProviderError(err);
    if (!c.retryable) {
      await giveUp(safeFailureSentence(c, "transcription"));
      throw err instanceof TerminalJobError
        ? err
        : new TerminalJobError(
            c.failureClass as "deterministic" | "configuration" | "billing",
            c.summary,
            {
              cause: err,
            },
          );
    }
    // Retryable: the queue backs off and tries again, until the last attempt.
    if (lastAttempt) await giveUp(safeFailureSentence(c, "transcription"));
    throw err;
  }

  const { error: wErr } = await service
    .from("interview_turns")
    .update({
      transcript: result.text,
      transcript_segments: result.segments.length > 0 ? result.segments : null,
      transcript_status: "done",
      transcript_error: null,
    })
    .eq("id", turnId)
    .in("transcript_status", ["pending", "failed"]);
  if (wErr) throw new Error(`live transcribe: transcript write failed (${wErr.code ?? "db"})`);

  const settled = await settleLiveOutcome(service, turn.session_id, { onDecided: deps.onDecided });
  console.log(
    `[live-transcribe] turn ${turnId}: done; session ${turn.session_id} ${settled?.final ? "final" : "provisional"} ${settled?.outcome ?? ""}`,
  );
}
