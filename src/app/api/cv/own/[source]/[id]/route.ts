import { NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { getOwnCvSignedUrl } from "@/app/talent/(authed)/dashboard/edit/actions";

export const runtime = "nodejs";

// Safari-safe own-CV open for the talent dashboard (Option C). Thin wrapper:
// the route calls the existing getOwnCvSignedUrl action and 302-redirects to
// its signed URL. All identity resolution + ownership checks (via
// requireProfileOwner) + audit logging live inside the action — we do NOT
// reimplement them here.
//
// Two path params: [source] scopes to a pool (talent_profiles vs
// hire_remote_profiles); [id] is the profile UUID inside that pool.

// SourceTable is a private type in the action module, so declared inline.
type SourceTable = "talent_profiles" | "hire_remote_profiles";

function htmlError(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:40px;color:#333;max-width:480px;margin:0 auto"><h2 style="margin:0 0 8px;font-weight:600">${title}</h2><p style="margin:0;color:#666">${body}</p></body>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ source: string; id: string }> },
) {
  const rl = rateLimit(request, {
    bucketKey: "cv-own",
    max: 30,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const { source, id } = await ctx.params;

  if (source !== "talent_profiles" && source !== "hire_remote_profiles") {
    return htmlError(400, "Invalid request", "The CV link is malformed.");
  }
  if (typeof id !== "string" || id.length < 1 || id.length > 100) {
    return htmlError(400, "Invalid request", "The CV link is malformed.");
  }

  const result = await getOwnCvSignedUrl({
    profileId: id,
    sourceTable: source as SourceTable,
  });
  if (result.success) {
    return NextResponse.redirect(result.data.url, 302);
  }

  // The action returns human-readable strings (not codes) — map by keyword to
  // an appropriate status. Order matters: "not ready" / "under review" /
  // "claim" branches BEFORE the generic "not found" fallback.
  const msg = result.error?.toLowerCase() ?? "";
  if (msg.includes("sign in") || msg.includes("log in") || msg.includes("authenticated")) {
    return htmlError(403, "Sign in required", "Please sign in to view your CV.");
  }
  if (msg.includes("review") || msg.includes("approv") || msg.includes("claim")) {
    return htmlError(403, "Profile not ready", "Your profile isn't ready yet.");
  }
  if (msg.includes("owner") || msg.includes("permission") || msg.includes("access")) {
    return htmlError(403, "Not allowed", "You don't have access to this CV.");
  }
  if (msg.includes("no cv") || msg.includes("not found") || msg.includes("missing")) {
    return htmlError(404, "CV not found", "We couldn't find your CV.");
  }
  return htmlError(
    500,
    "Could not open CV",
    "Something went wrong. Please try again.",
  );
}
