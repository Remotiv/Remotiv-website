import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { confirmPiece } from "@/lib/interviews/live-video";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview camera video, step 2 of 2: confirm piece N once it has
 * uploaded. Body: { token, piece, mimeType, startedAtMs, durationMs, last }.
 * startedAtMs is milliseconds since the interview server's "conversation
 * started" message, measured by the screen; durationMs is at most 180000.
 *
 *   200 { ok }                   saved (confirming again is also ok)
 *   404 not_uploaded             nothing arrived; upload it again
 *   400 empty / 413 too_large / 415 not_video
 *                                the file was removed; upload it again
 *   409 window_closed            more than 30 minutes after the interview ended
 *   502 unavailable              our side; retry with backoff
 *
 * The video carries the camera and the candidate's own microphone only;
 * Sarah's voice is not in it. Every rule is in lib/interviews/live-video.ts.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = rateLimitByKey(`live-video-confirm:${token.slice(0, 64)}`, {
    max: 120,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await confirmPiece(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
