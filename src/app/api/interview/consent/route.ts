import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import {
  asyncConsentGiven,
  CONSENT_NOT_SAVED,
  CONSENT_NOT_SAVED_MESSAGE,
  INTERVIEW_CONSENT_VERSION,
} from "@/lib/interviews/consent";
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
 * Idempotent: re-consenting to the current text keeps the FIRST timestamp,
 * because that is the moment they actually agreed. The version of the consent
 * text they saw is written alongside it, from the server's constant
 * (lib/interviews/consent.ts), never from the client.
 *
 * ── Success means saved ──────────────────────────────────────
 *
 * The answer is ok only once the row reads back with consent_at and the
 * current version: upload-url, confirm and submit refuse without exactly that,
 * so a reply of ok that saved nothing would strand the candidate. A failed
 * write, or a row that does not read back as saved, answers 500 with
 * CONSENT_NOT_SAVED, and the page asks them to try again.
 *
 * A session that agreed to an older version, or before versions were
 * recorded, has agreed to different words: agreeing now writes the current
 * time and version, replacing the old ones (an approved decision).
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

  if (asyncConsentGiven(resolved.row)) return NextResponse.json({ ok: true });

  const notSaved = () =>
    NextResponse.json(
      { error: CONSENT_NOT_SAVED_MESSAGE, code: CONSENT_NOT_SAVED },
      { status: 500 },
    );
  const service = createServiceClient();
  const { error } = await service
    .from("interview_sessions")
    .update({ consent_at: new Date().toISOString(), consent_version: INTERVIEW_CONSENT_VERSION })
    .eq("id", resolved.row.id)
    // Only while not yet agreed to the current text: two taps at once keep the first.
    .or(
      `consent_at.is.null,consent_version.is.null,consent_version.neq.${INTERVIEW_CONSENT_VERSION}`,
    );
  if (error) {
    console.error("[interview] consent save failed:", error.message);
    return notSaved();
  }

  const { data: saved, error: readErr } = await service
    .from("interview_sessions")
    .select("consent_at, consent_version")
    .eq("id", resolved.row.id)
    .maybeSingle();
  if (
    readErr ||
    !saved ||
    !asyncConsentGiven(saved as { consent_at: string | null; consent_version: string | null })
  ) {
    console.error("[interview] consent did not read back as saved");
    return notSaved();
  }
  return NextResponse.json({ ok: true });
}
