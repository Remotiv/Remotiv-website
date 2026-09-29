import "server-only";
import { skipJob } from "@/lib/job-skip";
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
import { requestScorecard } from "./scorecard";
import { INTERVIEW_BUCKET } from "./session";
import { readTranscribePayload, resolveGeneration } from "./transcribe-generation";

/**
 * The `transcribe` job handler — Whisper, one answer at a time.
 *
 * ── Which recording (Phase 5, P3/P12) ────────────────────────
 *
 * The payload is `{ answerId, recordedAt }`. `recordedAt` is the recording
 * generation - the row's recorded_at as PostgREST returned it when the answer
 * was confirmed - and this handler checks it THREE times against the row:
 *
 *   1. before any storage access, so a job for a superseded recording costs
 *      no signed URL, no download and no provider call;
 *   2. after the download and before the Whisper upload, because a re-record
 *      can land during a long download;
 *   3. on the final write, as a compare-and-set on recorded_at, so a stale
 *      worker can never put an old recording's words on a new one.
 *
 * A payload WITHOUT recordedAt is a legacy job from before this contract. It
 * runs once with no generation check, exactly as before. This path exists for
 * safety only: the pre-deploy check (migration 032, step 0b) confirmed ZERO
 * queued or running transcribe jobs without recordedAt at this deploy, so it
 * is not exercised by it, and nothing enqueued afterwards can take it because
 * requestTranscription refuses a payload with no generation.
 *
 * ── Terminal versus retryable (Phase 5, P13) ─────────────────
 *
 * A missing key, a 401/403, or a provider 400 will fail the same way on the
 * next attempt. Those now write transcript_status = 'failed' with a fixed safe
 * sentence and throw TerminalJobError, so the job is dead on the first attempt
 * with the provider's detail in last_error. The dead job stays replayable from
 * the admin panel: this handler treats a `failed` row as work to do, so a
 * replay after the fix transcribes it. A 429, a 5xx, a network error or our
 * own deadline leave the row `pending` and the queue retries with backoff.
 *
 * ── What a repeatedly failing video costs ────────────────────
 *
 * The VIDEO is never at risk. It is already uploaded and its row already
 * exists; transcription is a later enrichment of a row that is safe. A job
 * that exhausts its attempts leaves transcript_status = 'failed' with a safe
 * message in transcript_error, the answer still plays in the drawer, and the
 * reviewer sees "Transcript unavailable" beside a working video rather than a
 * blank panel. Replaying the dead job later fills it in.
 */

/**
 * Whisper's own ceiling. A file over it is marked `failed` and NOT retried —
 * nothing here chunks. See the size check below: it is a terminal markFailed.
 */
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

const SIGNED_URL_TTL_SECONDS = 10 * 60;

type AnswerRow = {
  id: string;
  session_id: string;
  video_path: string | null;
  transcript_status: string | null;
  duration_seconds: number | null;
  recorded_at: string | null;
};

type Service = ReturnType<typeof createServiceClient>;

export async function handleTranscribe(
  job: {
    id: string;
    payload: Record<string, unknown>;
  },
  ctx?: JobContext,
): Promise<void> {
  const payload = readTranscribePayload(job.payload);
  if (!payload) {
    throw new Error(`transcribe: payload.answerId missing (job ${job.id})`);
  }
  const { answerId, recordedAt } = payload;

  const service = createServiceClient();

  const { data } = await service
    .from("interview_answers")
    .select("id, session_id, video_path, transcript_status, duration_seconds, recorded_at")
    .eq("id", answerId)
    .maybeSingle();

  const answer = data as AnswerRow | null;
  /*
   * The answer was deleted — with its interview, or by the retention purge —
   * between this job being queued and being claimed. There is nothing to
   * transcribe and there never will be, so this is a skip: retrying a deleted
   * row three times with backoff only delays the same answer and parks it in
   * the dead letter for someone to triage by hand.
   */
  if (!answer) {
    skipJob("transcribe", job.id, `answer ${answerId} no longer exists`);
    return;
  }

  // ── Generation check 1: before ANY storage access ──
  const generation = resolveGeneration(recordedAt, answer.recorded_at);
  if (generation === "stale") {
    skipJob(
      "transcribe",
      job.id,
      `answer ${answerId} was re-recorded (job for ${recordedAt}, row is ${answer.recorded_at}); superseded`,
    );
    return;
  }
  if (generation === "legacy") {
    console.warn(
      `[transcribe] job ${job.id} has no recordedAt - legacy payload, running once without a generation check`,
    );
  }

  // Already done — a duplicate enqueue for the SAME recording must not spend
  // a second API call on the same audio. A `failed` row is work to do: that is
  // how an admin replay after a fix reaches the provider again.
  if (answer.transcript_status === "done") return;

  if (!answer.video_path) {
    await markFailed(service, answer, recordedAt, "Answer has no video to transcribe.");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Terminal, and the row says so: a pending transcript with no key would
    // block the session's scorecard and the recovery button forever. The dead
    // job is replayed from the admin panel once the key exists.
    const c = classifyProviderError(new Error("OPENAI_API_KEY is not configured"));
    await markFailed(service, answer, recordedAt, safeFailureSentence(c, "transcription"));
    throw new TerminalJobError("configuration", "transcribe: OPENAI_API_KEY is not configured");
  }

  const { data: signed } = await service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(answer.video_path, SIGNED_URL_TTL_SECONDS);

  const url = signed?.signedUrl;
  if (!url) throw new Error(`transcribe: could not sign ${answer.video_path}`);

  // The download counts against the same budget as the provider call: a
  // 100MB object on a slow link is exactly the thing that used to outlive the
  // function.
  assertProviderBudget(ctx, MIN_PROVIDER_CALL_BUDGET_MS, "transcribe before video download");
  const videoRes = await fetch(url, { signal: ctx?.signal });
  if (!videoRes.ok) {
    throw new Error(`transcribe: fetch failed (${videoRes.status})`);
  }
  const bytes = Buffer.from(await videoRes.arrayBuffer());

  if (bytes.byteLength > WHISPER_MAX_BYTES) {
    // Not retryable — the same file will be the same size next time, so this
    // is recorded as failed rather than burning three attempts on it.
    await markFailed(
      service,
      answer,
      recordedAt,
      `Recording is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, over the ${WHISPER_MAX_BYTES / 1024 / 1024}MB transcription limit.`,
    );
    return;
  }

  // ── Generation check 2: after the download, before paying for Whisper ──
  if (recordedAt !== null) {
    const { data: fresh } = await service
      .from("interview_answers")
      .select("recorded_at")
      .eq("id", answerId)
      .maybeSingle();
    const current = (fresh as { recorded_at: string | null } | null)?.recorded_at ?? null;
    if (resolveGeneration(recordedAt, current) === "stale") {
      skipJob(
        "transcribe",
        job.id,
        `answer ${answerId} was re-recorded during download (job for ${recordedAt}, row is ${current}); superseded`,
      );
      return;
    }
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "video/webm" }),
    `${answerId}.webm`,
  );
  form.append("model", "whisper-1");
  /*
   * verbose_json, for the timings.
   *
   * This used to ask for plain text on the grounds that nothing used the
   * timing data. Something does now: an evidence quote in a scorecard is only
   * checkable if a reviewer can jump to the moment it was said, and that needs
   * a start time per span. The plain `transcript` column is still written
   * exactly as before — every existing reader keeps working — and the timings
   * land alongside it in transcript_segments.
   */
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  /*
   * Force English rather than letting Whisper auto-detect.
   *
   * Auto-detection produced Devanagari on a test recording of English speech
   * — a Pakistani or Indian accent is close enough to Hindi/Urdu acoustics
   * that the detector picks the wrong language, and the whole answer comes
   * back in a script no reviewer here reads. Worse, the transcript then feeds
   * a scorer whose criteria are written in English, which would score noise.
   *
   * Interviews on this platform are conducted in English, so the language is
   * known ahead of time and there is nothing to detect. See the handover for
   * what this costs a candidate who genuinely answers in another language,
   * and what a per-job override would take.
   */
  form.append("language", "en");

  assertProviderBudget(ctx, MIN_PROVIDER_CALL_BUDGET_MS, "transcribe before Whisper call");
  const remainingAtStart = ctx ? ctx.remainingMs() : null;
  const callStarted = Date.now();
  let res: Response;
  try {
    // Our own timeout inside the budget: the platform must never be the thing
    // that ends this call.
    const timeout = AbortSignal.timeout(providerTimeoutMs(remainingAtStart ?? 600_000));
    const signal = ctx ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (err) {
    // Abort, DNS, reset: retryable. The row stays pending; the queue backs off.
    const c = classifyProviderError(err);
    logProviderCall({
      jobType: "transcribe",
      provider: "openai-whisper",
      model: "whisper-1",
      durationMs: Date.now() - callStarted,
      remainingAtStartMs: remainingAtStart,
      outcome: ctx?.signal.aborted ? "aborted" : "error",
      failureClass: c.failureClass,
      status: c.status,
    });
    throw err;
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    const httpErr = new ProviderHttpError("OpenAI", res.status, detail);
    const c = classifyProviderError(httpErr);
    logProviderCall({
      jobType: "transcribe",
      provider: "openai-whisper",
      model: "whisper-1",
      durationMs: Date.now() - callStarted,
      remainingAtStartMs: remainingAtStart,
      outcome: "error",
      failureClass: c.failureClass,
      status: res.status,
    });
    if (!c.retryable) {
      // 400, 401, 403, 413 and the like: the same request fails the same way.
      // The row says so in a fixed sentence; the provider's own words go to
      // the job's last_error only.
      await markFailed(service, answer, recordedAt, safeFailureSentence(c, "transcription"));
      throw new TerminalJobError(
        c.failureClass as "deterministic" | "configuration" | "billing",
        c.summary,
        {
          cause: httpErr,
        },
      );
    }
    // 429 or 5xx: rethrown so the queue retries with backoff.
    throw httpErr;
  }
  logProviderCall({
    jobType: "transcribe",
    provider: "openai-whisper",
    model: "whisper-1",
    durationMs: Date.now() - callStarted,
    remainingAtStartMs: remainingAtStart,
    outcome: "ok",
  });

  const payloadJson = (await res.json()) as {
    text?: string;
    segments?: unknown;
    /** Whisper's own measurement of the audio, in seconds. */
    duration?: unknown;
  };
  const transcript = (payloadJson.text ?? "").trim();
  const segments = toStoredSegments(payloadJson.segments);
  /*
   * The provider's audio length, kept since migration 031. It is the TRUSTED
   * duration: interview_answers.duration_seconds is the browser's timer and
   * can say anything. The assessability rule (lib/interviews/assessable.ts)
   * gates on this and on the segments, never on the browser's figure.
   */
  const providerDuration =
    typeof payloadJson.duration === "number" &&
    Number.isFinite(payloadJson.duration) &&
    payloadJson.duration >= 0
      ? payloadJson.duration
      : null;

  // ── Generation check 3: compare-and-set on the write ──
  let write = service
    .from("interview_answers")
    .update({
      transcript,
      /*
       * Null rather than [] when there are no usable segments, so "this row
       * predates timestamps" and "this row has timings" stay distinguishable.
       * Readers must treat null as "no timings available" and fall back to the
       * plain transcript — which is what every existing row does.
       */
      transcript_segments: segments.length > 0 ? segments : null,
      transcript_duration_seconds: providerDuration,
      transcript_status: transcript ? "done" : "failed",
      transcript_error: transcript ? null : "Transcription returned nothing.",
    })
    .eq("id", answerId);
  if (recordedAt !== null) write = write.eq("recorded_at", recordedAt);
  const { data: written, error } = await write.select("id");

  if (error) throw new Error(`transcribe: write failed: ${error.message}`);
  if ((written ?? []).length === 0) {
    // A re-record landed between check 2 and here. The new recording has its
    // own job (the confirm route enqueued it), so there is nothing to retry:
    // this transcript belongs to a video that no longer exists.
    skipJob(
      "transcribe",
      job.id,
      `answer ${answerId} was re-recorded before the transcript was written (job for ${recordedAt}); superseded, nothing written`,
    );
    return;
  }

  await maybeEnqueueScorecard(service, answer.session_id);
}

/**
 * Ask for session scoring once THIS transcript has landed.
 *
 * Transcripts arrive minutes after submit through this queue, so the scorer
 * cannot be handed the set at submit time - it would score empty transcripts.
 * This is one of the two automatic askers; the submit route is the other, and
 * lib/interviews/scorecard.ts explains why both are needed and why at most one
 * job results. The eligibility (submitted, nothing still `pending`) lives
 * there; a `failed` or `skipped` transcript counts as settled so one bad
 * recording cannot block the other answers forever.
 */
async function maybeEnqueueScorecard(service: Service, sessionId: string): Promise<void> {
  try {
    await requestScorecard(service, sessionId);
  } catch (err) {
    // Non-fatal: the transcript is already stored, and a scorecard that was
    // never queued is recoverable from the review page. Failing here would
    // retry the whole transcription and spend another Whisper call on audio
    // already done.
    console.error("[transcribe] scorecard enqueue failed (non-fatal):", err);
  }
}

/**
 * One span of speech with the moment it was said.
 *
 * Whisper returns far more per segment — `id`, `seek`, `tokens`,
 * `avg_logprob`, `compression_ratio`, `no_speech_prob` — all of which is
 * decoder telemetry that tells a reviewer nothing and costs real bytes on
 * every answer. Only what a click-to-seek needs is stored.
 */
export type TranscriptSegment = {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  /**
   * Whisper's no_speech_prob for this segment, 0-1. The one direct signal for
   * "this span is silence the model filled in". Kept since Phase 4 (AI-1);
   * absent on every segment stored before that, and readers must treat absent
   * as UNKNOWN, never as zero.
   */
  noSpeech?: number;
};

function toStoredSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const seg = item as {
      start?: unknown;
      end?: unknown;
      text?: unknown;
      no_speech_prob?: unknown;
    };
    const start = typeof seg.start === "number" ? seg.start : Number.NaN;
    const end = typeof seg.end === "number" ? seg.end : Number.NaN;
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    // A segment without a usable start is not seekable, so it is not stored.
    if (!Number.isFinite(start) || !text) continue;
    const noSpeech =
      typeof seg.no_speech_prob === "number" && Number.isFinite(seg.no_speech_prob)
        ? Math.round(seg.no_speech_prob * 1000) / 1000
        : undefined;
    out.push({
      start: Math.max(0, Math.round(start * 100) / 100),
      end: Number.isFinite(end) ? Math.round(end * 100) / 100 : start,
      text,
      ...(noSpeech === undefined ? {} : { noSpeech }),
    });
  }
  return out;
}

/**
 * Terminal, non-retryable failure of THIS recording. The video is untouched
 * and still plays. Compare-and-set on recorded_at like the success write, so
 * a stale job cannot mark a newer recording failed.
 */
async function markFailed(
  service: Service,
  answer: AnswerRow,
  recordedAt: string | null,
  message: string,
): Promise<void> {
  let write = service
    .from("interview_answers")
    .update({
      transcript_status: "failed",
      transcript_error: message.slice(0, 1000),
    })
    .eq("id", answer.id);
  if (recordedAt !== null) write = write.eq("recorded_at", recordedAt);
  await write;
  console.error(`[transcribe] ${answer.id}: ${message}`);
}
