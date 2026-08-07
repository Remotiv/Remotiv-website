import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import {
  answerPath,
  INTERVIEW_BUCKET,
  resolveSessionByToken,
} from "@/lib/interviews/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Step 1 of 2 — mint a short-lived signed URL the browser uploads straight to.
 *
 * ── Why the video no longer passes through us ────────────────
 *
 * Vercel caps a serverless request body at 4.5MB. A recording measured at
 * ~257 KB/s means the DEFAULT 120-second answer is ~31.6MB, so every real
 * answer was failing at the platform layer before the route ever ran — the
 * candidate saw a network error rather than any message of ours. Only answers
 * under about 17 seconds fit. Localhost has no such cap, which is why it never
 * showed up in testing.
 *
 * So the bytes go browser -> Supabase Storage directly, and this route only
 * hands out permission to write to ONE object.
 *
 * ── What the client is trusted with ──────────────────────────
 *
 * Nothing that widens scope. It sends a token and a position; the session, the
 * question and the storage key are all re-derived here. `kind` picks the file
 * extension only, is checked against a two-value allowlist, and is verified
 * against the actual container bytes at confirm — a lie there fails the object.
 *
 * NOTE, stated plainly: a Supabase signed upload URL embeds its object key, so
 * the client does learn its own key as a substring. That is inherent to the
 * mechanism. It grants nothing further — the key is derived from the session's
 * own id, listing is not possible with it, and any other object needs its own
 * signature. Reading still goes through /api/interview/playback, which never
 * returns a path.
 */

const EXTENSIONS = { webm: "webm", mp4: "mp4" } as const;
type Kind = keyof typeof EXTENSIONS;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: { token?: string; position?: number; kind?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "Bad request.");
  }

  const token = String(body.token ?? "");
  if (!token) return fail(400, "Missing session.");

  /*
   * Keyed on the TOKEN, not the IP — a whole office behind one NAT is a real
   * shape for a hiring pipeline. Sized for six questions plus re-records and
   * retries, and deliberately checked BEFORE the session lookup so a caller
   * cannot use this route to probe tokens cheaply.
   */
  const rl = rateLimitByKey(`interview-upload-url:${token.slice(0, 64)}`, {
    max: 40,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) return fail(429, `Too many uploads. Try again in ${rl.retryAfter}s.`);

  const resolved = await resolveSessionByToken(token);
  if (!resolved) return fail(404, "This interview link isn't valid.");
  if (resolved.session.state !== "ready") {
    return fail(409, "This interview is no longer accepting answers.");
  }

  const position = Number(body.position);
  const question = resolved.session.questions.find((q) => q.position === position);
  if (!question) return fail(400, "That question isn't part of this interview.");

  if (!resolved.session.allowRerecord && question.answered) {
    return fail(409, "This answer has already been recorded.");
  }

  const kind = String(body.kind ?? "") as Kind;
  if (!(kind in EXTENSIONS)) return fail(400, "Unsupported recording format.");

  const path = answerPath(resolved.row.id, position, EXTENSIONS[kind]);

  const { data, error } = await createServiceClient()
    .storage.from(INTERVIEW_BUCKET)
    // upsert so a re-record replaces the object instead of failing on a
    // path that already exists.
    .createSignedUploadUrl(path, { upsert: true });

  if (error || !data?.signedUrl) {
    console.error("[interview] signed upload url failed:", error?.message);
    return fail(502, "Couldn't start that upload. Please try again.");
  }

  return NextResponse.json({ url: data.signedUrl });
}
