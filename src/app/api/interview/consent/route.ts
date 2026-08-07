import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { resolveSessionByToken } from "@/lib/interviews/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record that the candidate agreed to be recorded.
 *
 * Stamped once, server-side, at the moment they clear the consent gate — not
 * at submit. Someone who consents, records two answers and abandons the link
 * still consented to those two being stored, and the timestamp has to say so.
 *
 * Idempotent: re-consenting keeps the FIRST timestamp, because that is the
 * moment they actually agreed.
 */
export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const token = String(body.token ?? "");
  if (!token) return NextResponse.json({ error: "Missing session." }, { status: 400 });

  const rl = rateLimitByKey(`interview-consent:${token.slice(0, 64)}`, {
    max: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }

  const resolved = await resolveSessionByToken(token);
  if (!resolved) {
    return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  }
  if (resolved.session.state !== "ready") {
    return NextResponse.json({ error: "This interview is closed." }, { status: 409 });
  }

  if (!resolved.row.consent_at) {
    await createServiceClient()
      .from("interview_sessions")
      .update({ consent_at: new Date().toISOString() })
      .eq("id", resolved.row.id)
      .is("consent_at", null);
  }

  return NextResponse.json({ ok: true });
}
