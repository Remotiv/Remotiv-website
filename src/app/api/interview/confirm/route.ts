import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import {
  answerPath,
  INTERVIEW_BUCKET,
  INTERVIEW_MAX_BYTES,
  resolveSessionByToken,
} from "@/lib/interviews/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Step 2 of 2 — verify what actually landed, then record the answer.
 *
 * The row is what makes an answer real: /api/interview/playback resolves
 * video_path FROM THE ROW, resume counts rows, and submit checks rows. An
 * object with no row is invisible and unreachable. So this route is the only
 * place an upload becomes an answer, and it refuses to take the client's word
 * for any of it.
 *
 * ── What replaces the magic-byte sniff ───────────────────────
 *
 * The bytes no longer pass through the function, so the old inline sniff is
 * gone — but the check is NOT gone. This route signs a short-lived read URL
 * and pulls the first 16 bytes back with a Range request, then runs the same
 * container check on them. Sixteen bytes over the wire replaces thirty-two
 * megabytes, and the guarantee is the same: a file is stored as an answer only
 * if it really begins like a WebM or an MP4.
 *
 * Three further checks the old route could not make at all, because it never
 * looked at the stored object:
 *   - the object EXISTS (a client cannot claim an upload it never performed),
 *   - its size is > 0 and within the ceiling,
 *   - its recorded mimetype is one we accept.
 *
 * ── Content type, honestly ───────────────────────────────────
 *
 * The old route forced contentType server-side because it did the PUT. A
 * signed upload URL is written by the browser, which sets its own
 * Content-Type, so it can no longer be FORCED at write time. It is instead
 * ENFORCED BY REJECTION here: a stored mimetype outside the allowlist fails,
 * the object is deleted, and no row is written — so it never becomes
 * reachable. Rejection rather than coercion, and worth saying plainly rather
 * than implying a guarantee that moved.
 */

const MAGIC_WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const ACCEPTED_MIME = new Set(["video/webm", "video/mp4"]);
const SNIFF_TTL_SECONDS = 60;

function sniffVideo(bytes: Uint8Array): "webm" | "mp4" | null {
  if (bytes.length >= 4 && MAGIC_WEBM.every((b, i) => bytes[i] === b)) return "webm";
  // Safari writes fragmented MP4, whose ftyp box sits at offset 4.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "mp4";
  }
  return null;
}

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: { token?: string; position?: number; duration?: number; kind?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "Bad request.");
  }

  const token = String(body.token ?? "");
  if (!token) return fail(400, "Missing session.");

  const rl = rateLimitByKey(`interview-confirm:${token.slice(0, 64)}`, {
    max: 40,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) return fail(429, `Too many uploads. Try again in ${rl.retryAfter}s.`);

  const resolved = await resolveSessionByToken(token);
  if (!resolved) return fail(404, "This interview link isn't valid.");
  if (resolved.session.state !== "ready") {
    return fail(409, "This interview is no longer accepting answers.");
  }

  const position = Number(body.position);
  const question = resolved.session.questions.find((q) => q.position === position);
  if (!question) return fail(400, "That question isn't part of this interview.");

  if (!resolved.session.allowRerecord && question.answered) {
    return fail(409, "This answer has already been recorded.");
  }

  const kind = body.kind === "mp4" ? "mp4" : "webm";
  const path = answerPath(resolved.row.id, position, kind);
  const service = createServiceClient();

  // ── Does the object exist, and how big is it? ──
  const { data: listed } = await service.storage
    .from(INTERVIEW_BUCKET)
    .list(resolved.row.id, { search: `q${position}.${kind}`, limit: 2 });

  const object = ((listed ?? []) as {
    name: string;
    metadata: { size?: number; mimetype?: string } | null;
  }[]).find((o) => o.name === `q${position}.${kind}`);

  if (!object) {
    return fail(404, "That recording didn't reach our storage. Please try again.");
  }

  const size = object.metadata?.size ?? 0;
  if (size <= 0) {
    await service.storage.from(INTERVIEW_BUCKET).remove([path]);
    return fail(400, "That recording came through empty.");
  }
  if (size > INTERVIEW_MAX_BYTES) {
    await service.storage.from(INTERVIEW_BUCKET).remove([path]);
    return fail(413, "That recording is too large.");
  }

  const mimetype = (object.metadata?.mimetype ?? "").split(";")[0].trim();
  if (!ACCEPTED_MIME.has(mimetype)) {
    await service.storage.from(INTERVIEW_BUCKET).remove([path]);
    return fail(415, "That file isn't a video we can accept.");
  }

  // ── The byte check, over 16 bytes instead of the whole file ──
  const { data: signed } = await service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(path, SNIFF_TTL_SECONDS);

  if (!signed?.signedUrl) {
    return fail(502, "Couldn't verify that recording. Please try again.");
  }

  let head: Uint8Array;
  try {
    const res = await fetch(signed.signedUrl, { headers: { Range: "bytes=0-15" } });
    if (!res.ok) throw new Error(String(res.status));
    head = new Uint8Array(await res.arrayBuffer());
  } catch {
    // Storage unreachable is OUR problem, not a bad file — the object is left
    // in place so a retry can confirm it rather than re-upload 30MB.
    return fail(502, "Couldn't verify that recording. Please try again.");
  }

  const sniffed = sniffVideo(head);
  if (!sniffed || sniffed !== kind) {
    await service.storage.from(INTERVIEW_BUCKET).remove([path]);
    return fail(415, "That file isn't a video we can accept.");
  }

  // ── It is what it claims. Record it. ──
  const duration = Number(body.duration);
  const { data: answerRow, error: rowErr } = await service
    .from("interview_answers")
    .upsert(
      {
        session_id: resolved.row.id,
        question_id: question.id,
        // Snapshot: the recruiter may edit the question afterwards, and an
        // answer has to stay attached to what was actually asked.
        question_text: question.question,
        position,
        video_path: path,
        duration_seconds: Number.isFinite(duration) ? Math.max(0, duration) : null,
        transcript_status: "pending",
        transcript: null,
        transcript_error: null,
        recorded_at: new Date().toISOString(),
      },
      { onConflict: "session_id,position" },
    )
    .select("id")
    .single();

  if (rowErr || !answerRow) {
    console.error("[interview] answer row failed:", rowErr?.message);
    return fail(500, "Your answer uploaded but didn't save. Please try again.");
  }

  /*
   * A re-record in the OTHER container leaves the previous object behind —
   * q1.webm and q1.mp4 cannot overwrite each other. Only the path in the row
   * is ever read, so the stray one is unreachable; removing it stops it
   * lingering until the retention sweep. Failure here is not the candidate's
   * problem and is deliberately ignored.
   */
  const stalePath = answerPath(resolved.row.id, position, kind === "webm" ? "mp4" : "webm");
  await service.storage
    .from(INTERVIEW_BUCKET)
    .remove([stalePath])
    .catch(() => {});

  // First answer flips the session out of 'invited' so the dashboard can tell
  // "sent" from "started" without inspecting the answers table.
  if (resolved.row.status === "invited") {
    await service
      .from("interview_sessions")
      .update({ status: "started", started_at: new Date().toISOString() })
      .eq("id", resolved.row.id)
      .eq("status", "invited");
  }

  /*
   * Transcription is queued per answer rather than at submit, so a candidate
   * who takes an hour over six questions has five already transcribed by the
   * time they finish. Non-fatal: the answer is safely stored, and a queue
   * outage must not tell the candidate their upload failed.
   */
  try {
    await enqueue({
      type: JOB_TYPES.TRANSCRIBE,
      payload: { answerId: (answerRow as { id: string }).id },
      companyId: resolved.row.company_id,
    });
  } catch (err) {
    console.error("[interview] transcribe enqueue failed (non-fatal):", err);
  }

  return NextResponse.json({ ok: true, position });
}
