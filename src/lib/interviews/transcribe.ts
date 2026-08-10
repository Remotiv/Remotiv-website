import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { INTERVIEW_BUCKET } from "./session";

/**
 * The `transcribe` job handler — Whisper, one answer at a time.
 *
 * ── OPENAI_API_KEY is not set yet, and that must be loud ─────
 *
 * A missing key THROWS. It does not mark the row 'skipped' and it does not
 * return success. A handler that quietly succeeded would leave every answer
 * with an empty transcript and no record that the work never happened — the
 * exact failure the queue's stubs were written to avoid. Throwing routes it
 * through the normal path: attempts increments, last_error names the missing
 * key, backoff applies (30s, 60s, 2m, 4m … capped at 1h), and after
 * max_attempts the job lands in 'dead' where it can be found and replayed once
 * the key exists.
 *
 * ── What a repeatedly failing video costs ────────────────────
 *
 * The VIDEO is never at risk. It is already uploaded and its row already
 * exists; transcription is a later enrichment of a row that is safe. A job
 * that exhausts its attempts leaves transcript_status = 'failed' with the
 * provider's message in transcript_error, the answer still plays in the
 * drawer, and the reviewer sees "Transcript unavailable" beside a working
 * video rather than a blank panel. Replaying the dead job later fills it in.
 */

/** Whisper's own ceiling. A longer answer is chunked rather than refused. */
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

const SIGNED_URL_TTL_SECONDS = 10 * 60;

type AnswerRow = {
  id: string;
  session_id: string;
  video_path: string | null;
  transcript_status: string | null;
  duration_seconds: number | null;
};

export async function handleTranscribe(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const answerId = job.payload?.answerId;
  if (typeof answerId !== "string" || !answerId) {
    throw new Error(`transcribe: payload.answerId missing (job ${job.id})`);
  }

  const service = createServiceClient();

  const { data } = await service
    .from("interview_answers")
    .select("id, session_id, video_path, transcript_status, duration_seconds")
    .eq("id", answerId)
    .maybeSingle();

  const answer = data as AnswerRow | null;
  if (!answer) throw new Error(`transcribe: answer ${answerId} not found`);

  // Already done — a duplicate enqueue (a re-record races its own job) must
  // not spend a second API call on the same audio.
  if (answer.transcript_status === "done") return;

  if (!answer.video_path) {
    await markFailed(service, answerId, "Answer has no video to transcribe.");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Deliberately BEFORE any state write: the row stays 'pending' so a replay
    // after the key is configured picks it up as ordinary work.
    throw new Error(
      "transcribe: OPENAI_API_KEY is not configured — cannot transcribe.",
    );
  }

  const { data: signed } = await service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(answer.video_path, SIGNED_URL_TTL_SECONDS);

  const url = signed?.signedUrl;
  if (!url) throw new Error(`transcribe: could not sign ${answer.video_path}`);

  const videoRes = await fetch(url);
  if (!videoRes.ok) {
    throw new Error(`transcribe: fetch failed (${videoRes.status})`);
  }
  const bytes = Buffer.from(await videoRes.arrayBuffer());

  if (bytes.byteLength > WHISPER_MAX_BYTES) {
    // Not retryable — the same file will be the same size next time, so this
    // is recorded as failed rather than burning three attempts on it.
    await markFailed(
      service,
      answerId,
      `Recording is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, over the ${WHISPER_MAX_BYTES / 1024 / 1024}MB transcription limit.`,
    );
    return;
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

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    // Rethrown so the queue retries with backoff — a 429 or a 5xx from the
    // provider is exactly what backoff exists for.
    throw new Error(`transcribe: OpenAI ${res.status} — ${detail}`);
  }

  const payload = (await res.json()) as {
    text?: string;
    segments?: unknown;
  };
  const transcript = (payload.text ?? "").trim();
  const segments = toStoredSegments(payload.segments);

  const { error } = await service
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
      transcript_status: transcript ? "done" : "failed",
      transcript_error: transcript ? null : "Transcription returned nothing.",
    })
    .eq("id", answerId);

  if (error) throw new Error(`transcribe: write failed: ${error.message}`);

  await maybeEnqueueScorecard(service, answer.session_id);
}

/**
 * Enqueue session scoring once the LAST transcript has landed.
 *
 * ── Why here and not at submit ───────────────────────────────
 *
 * Submitting closes the session, but the transcripts arrive minutes later
 * through this queue. Enqueuing the scorecard at submit would hand the scorer
 * a set of empty transcripts and produce a confidently meaningless result —
 * the race is not theoretical, it is the normal ordering.
 *
 * So the trigger is the completion of transcription, checked from the row that
 * just finished: the session must be submitted, and no answer may still be
 * `pending`. Whichever transcribe job writes last is the one that sees a fully
 * settled set and enqueues; the others see a pending sibling and do nothing.
 *
 * `failed` and `skipped` count as settled on purpose. A permanently failed
 * transcript — a 30MB recording over Whisper's ceiling — would otherwise block
 * scoring of the other four answers forever. The scorer skips that one answer
 * and scores the rest, which is the useful behaviour.
 */
async function maybeEnqueueScorecard(
  service: ReturnType<typeof createServiceClient>,
  sessionId: string,
): Promise<void> {
  try {
    /*
     * Imported at CALL time, not module top.
     *
     * jobs-queue.ts imports handleTranscribe from this file in order to
     * register it, so a top-level import back would close an
     * initialisation cycle: whichever module evaluated first would reach for a
     * binding the other had not created yet. Deferring to the call keeps the
     * dependency one-way at load and honest at runtime.
     */
    const { enqueue, JOB_TYPES } = await import("@/lib/jobs-queue");

    const { data: sessionRow } = await service
      .from("interview_sessions")
      .select("id, status")
      .eq("id", sessionId)
      .maybeSingle();

    const session = sessionRow as { status: string } | null;
    if (!session || session.status !== "submitted") return;

    const { count: stillPending } = await service
      .from("interview_answers")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("transcript_status", "pending");
    if ((stillPending ?? 0) > 0) return;

    /*
     * The handler upserts on session_id, so a duplicate job is harmless — but
     * several transcribe jobs can settle within the same second and each would
     * queue one. Checking for a live job first keeps the queue readable
     * without pretending this is the safety mechanism; idempotency is.
     */
    const { data: live } = await service
      .from("background_jobs")
      .select("id")
      .eq("type", JOB_TYPES.AI_SCORECARD)
      .in("status", ["queued", "running"])
      .contains("payload", { sessionId })
      .limit(1);
    if ((live ?? []).length > 0) return;

    await enqueue({
      type: JOB_TYPES.AI_SCORECARD,
      payload: { sessionId },
      companyId: null,
    });
  } catch (err) {
    // Non-fatal: the transcript is already stored, and a scorecard that was
    // never queued is recoverable. Failing here would retry the whole
    // transcription and spend another Whisper call on audio already done.
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
};

function toStoredSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const seg = item as { start?: unknown; end?: unknown; text?: unknown };
    const start = typeof seg.start === "number" ? seg.start : Number.NaN;
    const end = typeof seg.end === "number" ? seg.end : Number.NaN;
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    // A segment without a usable start is not seekable, so it is not stored.
    if (!Number.isFinite(start) || !text) continue;
    out.push({
      start: Math.max(0, Math.round(start * 100) / 100),
      end: Number.isFinite(end) ? Math.round(end * 100) / 100 : start,
      text,
    });
  }
  return out;
}

/** Terminal, non-retryable failure. The video is untouched and still plays. */
async function markFailed(
  service: ReturnType<typeof createServiceClient>,
  answerId: string,
  message: string,
): Promise<void> {
  await service
    .from("interview_answers")
    .update({
      transcript_status: "failed",
      transcript_error: message.slice(0, 1000),
    })
    .eq("id", answerId);
  console.error(`[transcribe] ${answerId}: ${message}`);
}
