import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitByKey } from "@/app/api/_lib/rate-limit";
import { INTERVIEW_BUCKET, resolveSessionByToken } from "@/lib/interviews/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A short-lived signed URL so a candidate can rewatch their OWN answer.
 *
 * The storage path never crosses the wire. The client sends a token and a
 * position; this route resolves the session server-side, looks the path up
 * itself, and returns only a signed URL that expires. A path in the client
 * would turn a bearer token for one interview into a probe against every
 * object in a private bucket.
 *
 * Scoped to the session in the query, so the token only ever unlocks its own
 * answers — there is no id here a caller could swap for someone else's.
 */
const TTL_SECONDS = 5 * 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const position = Number.parseInt(url.searchParams.get("position") ?? "", 10);

  if (!token || !Number.isFinite(position)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const rl = rateLimitByKey(`interview-playback:${token.slice(0, 64)}`, {
    max: 60,
    windowMs: 10 * 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }

  const resolved = await resolveSessionByToken(token);
  if (!resolved) {
    return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  }
  // Rewatching is part of reviewing before submitting. Once submitted the
  // session is finished and this closes with it.
  if (resolved.session.state !== "ready") {
    return NextResponse.json({ error: "This interview is closed." }, { status: 409 });
  }

  const service = createServiceClient();
  const { data } = await service
    .from("interview_answers")
    .select("video_path")
    .eq("session_id", resolved.row.id)
    .eq("position", position)
    .maybeSingle();

  const path = (data as { video_path: string | null } | null)?.video_path;
  if (!path) {
    return NextResponse.json({ error: "That answer isn't recorded yet." }, { status: 404 });
  }

  const { data: signed } = await service.storage
    .from(INTERVIEW_BUCKET)
    .createSignedUrl(path, TTL_SECONDS);

  if (!signed?.signedUrl) {
    return NextResponse.json({ error: "Couldn't load that answer." }, { status: 502 });
  }

  return NextResponse.json({ url: signed.signedUrl });
}
