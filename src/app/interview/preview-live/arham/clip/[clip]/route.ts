import { isReplayClipId } from "../../../arham-replay";
import { readArhamClip } from "../../../arham-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One of Sarah's recorded turns from Arham's session (live screen demo,
 * development only): 24 kHz mono s16le PCM. 404 in production, without the
 * session folder, and for any name that is not an interviewer clip the
 * session JSON names. Never a static file; candidate audio is never served.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ clip: string }> }) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const { clip } = await params;
  if (!isReplayClipId(clip)) return new Response(null, { status: 404 });
  const pcm = await readArhamClip(clip);
  if (!pcm) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(pcm), {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}
