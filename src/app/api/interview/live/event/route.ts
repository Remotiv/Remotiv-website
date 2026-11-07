import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { handleLiveEvent } from "@/lib/interviews/live-events";
import { hashSessionToken } from "@/lib/interviews/tokens";
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
 *   409 not_open                finished, closed or past retention: nothing stored
 *   409 link_replaced           a first attempt that was restarted: nothing stored
 *   502 not_recorded            not stored; the screen may send it again
 *
 * A record, never an outcome, and never the interview's end: no report, not
 * even provider_end_reported, stamps live_ended_at (RB1). Only the server's
 * time-limit backstop may stamp it here. Every rule but link_replaced is in
 * lib/interviews/live-events.ts; that one is refused here, before any of them,
 * so a restarted attempt gets no new row and no backstop stamp.
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
  const service = createServiceClient();
  if (token.length >= 20 && token.length <= 200) {
    const { data, error } = await service
      .from("interview_sessions")
      .select("id, status")
      .eq("token_hash", hashSessionToken(token))
      .maybeSingle();
    // Unknown is not "allowed": 5xx, which the screen may send again.
    if (error) {
      console.error(`[live-events] status read failed (${error.code ?? "error"})`);
      return NextResponse.json(
        { code: "not_recorded", error: "Couldn't record that. Please try again." },
        { status: 502 },
      );
    }
    const row = data as { id: string; status: string } | null;
    if (row?.status === "abandoned") {
      console.warn(`[live-events] session ${row.id}: refused, the link was replaced`);
      return NextResponse.json(
        { code: "link_replaced", error: "This link was replaced." },
        { status: 409 },
      );
    }
  }
  const result = await handleLiveEvent(body, { service });
  return NextResponse.json(result.body, { status: result.status });
}
