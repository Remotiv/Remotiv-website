import "server-only";
import { skipJob } from "@/lib/job-skip";
import { createServiceClient } from "@/lib/supabase/server";
import { requestScorecard } from "./scorecard";
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

/**
 * Whisper's own ceiling. A file over it is marked `failed` and NOT retried —
 * nothing here chunks. This comment used to say the opposite, and the gap
 * between a comment and its code is how a 30MB recording gets a shrug instead
 * of a transcript. See the size check below: it is a terminal markFailed.
 */
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
    throw new Error("transcribe: OPENAI_API_KEY is not configured — cannot transcribe.");
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
    /** Whisper's own measurement of the audio, in seconds. */
    duration?: unknown;
  };
  const transcript = (payload.text ?? "").trim();
  const segments = toStoredSegments(payload.segments);
  /*
   * The provider's audio length, kept since migration 031. It is the TRUSTED
   * duration: interview_answers.duration_seconds is the browser's timer and
   * can say anything. The assessability rule (lib/interviews/assessable.ts)
   * gates on this and on the segments, never on the browser's figure.
   */
  const providerDuration =
    typeof payload.duration === "number" &&
    Number.isFinite(payload.duration) &&
    payload.duration >= 0
      ? payload.duration
      : null;

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
      transcript_duration_seconds: providerDuration,
      transcript_status: transcript ? "done" : "failed",
      transcript_error: transcript ? null : "Transcription returned nothing.",
    })
    .eq("id", answerId);

  if (error) throw new Error(`transcribe: write failed: ${error.message}`);

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
async function maybeEnqueueScorecard(
  service: ReturnType<typeof createServiceClient>,
  sessionId: string,
): Promise<void> {
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
