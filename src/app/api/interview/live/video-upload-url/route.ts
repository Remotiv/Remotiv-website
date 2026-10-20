import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { reservePieceUpload } from "@/lib/interviews/live-video";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview camera video, step 1 of 2: the upload URL for piece N.
 *
 * Called by Remotiv's candidate screen when piece N STARTS recording; that
 * reserves it. Body: { token, piece, mimeType: "video/webm" | "video/mp4" }.
 *
 *   200 { url, path }            PUT the piece to url (create-only: it can
 *                                never replace a stored file)
 *   200 { alreadyConfirmed }     already saved; skip it
 *   403 consent_required         no saved live-v1 consent
 *   409 not_open                 the interview is not accepting video
 *   400 bad_piece                piece number or type not allowed
 *
 * The video carries the camera and the candidate's own microphone only;
 * Sarah's voice is not in it (her turn audio is played separately). Every
 * rule is in lib/interviews/live-video.ts.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = rateLimitByKey(`live-video-upload:${token.slice(0, 64)}`, {
    max: 120,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await reservePieceUpload(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
