import { NextResponse } from "next/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { agreeToLiveInterview } from "@/lib/interviews/live-start";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AI Video Interview consent: the candidate agreed to the live text.
 * Body: { token, agreed: true }.
 *
 *   200 { ok }                  saved as live-v1 (read back)
 *   409 consent_locked          the live text still has a placeholder: live
 *                               interviews stay closed until it is final
 *   409 not_open                not open, already started or ended
 *   500 consent_not_saved       not saved; the screen offers Try again
 *
 * Every rule is in lib/interviews/live-start.ts (agreeToLiveInterview).
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: "bad_request", error: "Bad request." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const rl = rateLimitByKey(`live-consent:${token.slice(0, 64)}`, { max: 10, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", error: `Too many attempts. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }
  const result = await agreeToLiveInterview(body, { service: createServiceClient() });
  return NextResponse.json(result.body, { status: result.status });
}
