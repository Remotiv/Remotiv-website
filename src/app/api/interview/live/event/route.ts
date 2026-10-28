import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { handleLiveEvent } from "@/lib/interviews/live-events";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview events: what the candidate screen saw happen.
 * Body: { token, kind, detail? }, as JSON or as text (navigator.sendBeacon
 * sends the tab-closed report as text/plain).
 *
 *   200 { ok }                  recorded (live_session_events, migration 050)
 *   400 bad_event               not one of the codes
 *   409 not_started             the interview never started
 *   502 not_recorded            not stored; the screen may send it again
 *
 * A record, never an outcome, and never the interview's end: no report, not
 * even provider_end_reported, stamps live_ended_at (RB1). Only the server's
 * time-limit backstop may stamp it here. Every rule is in
 * lib/interviews/live-events.ts.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await request.text()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = rateLimitByKey(`live-event:${token.slice(0, 64)}`, { max: 60, windowMs: 10 * 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await handleLiveEvent(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
