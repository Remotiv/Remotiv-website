import { NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { getClientCvSignedUrl } from "@/app/client/actions";

export const runtime = "nodejs";

// Safari-safe CV open for the client portal (Option C). Thin wrapper: the
// route calls the existing getClientCvSignedUrl action and 302-redirects to
// its signed URL. All permission logic (client-ownership vs admin-preview),
// identity resolution (cookies → getCurrentClientOrAdmin), and audit logging
// live inside the action — we do NOT reimplement them here.

function htmlError(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:40px;color:#333;max-width:480px;margin:0 auto"><h2 style="margin:0 0 8px;font-weight:600">${title}</h2><p style="margin:0;color:#666">${body}</p></body>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const rl = rateLimit(request, {
    bucketKey: "cv-client-batch",
    max: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const { id } = await ctx.params;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) {
    return htmlError(400, "Invalid request", "The CV link is malformed.");
  }

  const result = await getClientCvSignedUrl(id);
  if (result.ok) {
    return NextResponse.redirect(result.url, 302);
  }

  switch (result.error) {
    case "not_authenticated":
      return htmlError(403, "Sign in required", "Please sign in to view this CV.");
    case "not_authorized":
      return htmlError(
        403,
        "Not allowed",
        "You don't have access to this candidate's CV.",
      );
    case "cv_missing":
      return htmlError(404, "CV not found", "We couldn't find this CV.");
    default:
      return htmlError(
        500,
        "Could not open CV",
        "Something went wrong. Please try again.",
      );
  }
}
