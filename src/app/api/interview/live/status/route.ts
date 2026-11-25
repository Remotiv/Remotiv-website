import { NextResponse } from "next/server";
import { limitInterview } from "@/app/api/interview/_lib/limits";
import { liveInterviewStatus } from "@/lib/interviews/live-video";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview: is this interview still open? (#55 part 2)
 *
 * Asked by Remotiv's candidate screen only when no video piece request went
 * out for 30 seconds (the camera or the recorder stopped mid-call), so a
 * closed interview is still noticed. Body: { token }. Read-only.
 *
 *   200 { open: true }
 *   409 interview_closed         cancelled, or the applicant being deleted
 *   404 not_found                no live session for this token (or gone)
 *
 * Nothing about the candidate, the job or the session is ever answered. Every
 * rule is in lib/interviews/live-video.ts (liveInterviewStatus).
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = limitInterview("live-status", token);
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await liveInterviewStatus(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
