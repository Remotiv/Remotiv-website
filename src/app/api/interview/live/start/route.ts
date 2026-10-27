import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { startLiveInterview } from "@/lib/interviews/live-start";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview start: the server creates the provider session and the
 * browser gets only its join ticket. Body: { token }.
 *
 *   200 { join }                the ticket: for VoxAgent, the short-lived
 *                               ws_url and ws_token. Never a key.
 *   503 busy                    at capacity: "Please try again shortly",
 *                               with retryAfterSeconds; nothing used up
 *   503 unavailable             no provider, or it failed: the same sentence
 *   403 consent_required        no saved live-v1 consent
 *   409 already_started         started once already; never again
 *   409 not_open, consent_locked, not_ready
 *
 * Every rule is in lib/interviews/live-start.ts. The ticket is never logged.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = rateLimitByKey(`live-start:${token.slice(0, 64)}`, { max: 10, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many attempts. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await startLiveInterview(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
