import { readArhamScript } from "../../arham-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The "Real Sarah voice" replay script (live screen demo, development only):
 * Arham's session, as mock steps. 404 in production, and whenever
 * PREVIEW_ARHAM_SESSION_DIR is unset or its folder unreadable (arham-session.ts).
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const script = await readArhamScript();
  if (!script) return new Response(null, { status: 404 });
  return Response.json(script, { headers: { "cache-control": "no-store" } });
}
