import { receiveRecallWebhook } from "@/lib/final-interviews/bots";

/**
 * Recall.ai webhooks: bot status and recording events for the Final Human
 * Interview recorder. Recording step 3.
 *
 * The signature is the authorisation: proxy.ts matches /admin and
 * /ai-dashboard only, so no login sits in front of this path, and nothing is
 * read from the body until verifyRecallWebhook has accepted it. The body is
 * read once, as text, under a size cap, because the signature covers those
 * exact bytes.
 *
 * POST only. 503 when RECALL_WEBHOOK_SECRET is missing, 401 when the request
 * does not verify, 413 when it is too large. Otherwise the status comes from
 * receiveRecallWebhook: 200 when the event is handled, a 503 that Recall
 * retries when a database step it needed did not happen. Response bodies say
 * nothing beyond that, and the request body is never logged.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recall's events are a few kilobytes; anything near this is not one of them. */
const MAX_BODY_BYTES = 256 * 1024;

function reply(status: number): Response {
  const body =
    status < 300 ? { received: true } : { error: status === 401 ? "unauthorized" : "unavailable" };
  return new Response(JSON.stringify(status === 413 ? { error: "too_large" } : body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The body as text, or null once it passes the cap. Stops reading at the cap. */
async function readCapped(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413);
  const rawBody = await readCapped(request);
  if (rawBody === null) return reply(413);

  const result = await receiveRecallWebhook({
    rawBody,
    header: (name) => request.headers.get(name),
    secret: process.env.RECALL_WEBHOOK_SECRET,
  });
  return reply(result.status);
}
