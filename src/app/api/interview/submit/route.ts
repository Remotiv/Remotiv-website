import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { requestScorecard } from "@/lib/interviews/scorecard";
import { resolveSessionByToken } from "@/lib/interviews/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Close the session.
 *
 * Submitting stores nothing new — every answer is already a row, uploaded when
 * it was recorded. This only flips the status, which is what makes the link
 * stop working and what the dashboard reads.
 *
 * The completeness check is re-derived from the ANSWERS table, never from a
 * count the client sends: a page that posts "all done" with three of six
 * recorded must not be able to close an incomplete interview.
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

  const rl = rateLimitByKey(`interview-submit:${token.slice(0, 64)}`, {
    max: 8,
    windowMs: 10 * 60_000,
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
  if (resolved.session.state === "submitted") {
    // Not an error — a double-tap on a slow connection lands here, and the
    // page should show the submitted screen rather than a failure.
    return NextResponse.json({ ok: true, alreadySubmitted: true });
  }
  if (resolved.session.state !== "ready") {
    return NextResponse.json({ error: "This interview is closed." }, { status: 409 });
  }

  const missing = resolved.session.questions.filter(
    (q) => q.required && !q.answered,
  );
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `${missing.length} question${missing.length === 1 ? "" : "s"} still to answer.`,
        missing: missing.map((q) => q.position),
      },
      { status: 400 },
    );
  }

  const service = createServiceClient();
  const { error } = await service
    .from("interview_sessions")
    .update({ status: "submitted", submitted_at: new Date().toISOString() })
    .eq("id", resolved.row.id)
    // Guarded on the current status so two racing submits produce one write.
    .in("status", ["invited", "started"]);

  if (error) {
    console.error("[interview] submit failed:", error.message);
    return NextResponse.json({ error: "Couldn't submit. Try again." }, { status: 500 });
  }

  /*
   * Ask for the scorecard, AFTER the status has landed. If every transcript is
   * already done - the candidate reviewed for longer than a worker tick, so
   * transcription finished first and found the session still open - this is
   * the only asker left. If a transcript is still pending, this returns
   * without queueing and the transcribe handler asks when it lands. Non-fatal:
   * the interview is submitted either way, and the review page can ask again.
   */
  try {
    await requestScorecard(service, resolved.row.id);
  } catch (err) {
    console.error("[interview] scorecard request at submit failed (non-fatal):", err);
  }

  return NextResponse.json({ ok: true });
}
