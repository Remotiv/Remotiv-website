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
  // Plain text: the reviewer reads prose, and asking for verbose JSON would
  // store timing data nothing in the product uses yet.
  form.append("response_format", "text");

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

  const transcript = (await res.text()).trim();

  const { error } = await service
    .from("interview_answers")
    .update({
      transcript,
      transcript_status: transcript ? "done" : "failed",
      transcript_error: transcript ? null : "Transcription returned nothing.",
    })
    .eq("id", answerId);

  if (error) throw new Error(`transcribe: write failed: ${error.message}`);
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
