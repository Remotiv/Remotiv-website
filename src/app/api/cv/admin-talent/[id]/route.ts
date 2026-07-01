import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";

export const runtime = "nodejs";

// Safari-safe CV open for /admin/talent (Option C). Mirrors
// /api/cv/admin-application/[id] exactly; only the lookup table + source_table
// differ. Self-contained on purpose — see the pilot's comment for rationale.

const CV_BUCKET = "cvs";
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60;

function deriveCvPathFromUrl(cvUrl: string | null | undefined): string | null {
  if (!cvUrl) return null;
  const match = String(cvUrl).match(
    /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
  );
  return match ? match[1] : null;
}

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
    bucketKey: "cv-admin-talent",
    max: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let adminCtx;
  try {
    adminCtx = await requireAdmin();
  } catch {
    return htmlError(
      403,
      "Forbidden",
      "Admin access required. Please sign in with an admin account.",
    );
  }

  const { id } = await ctx.params;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) {
    return htmlError(400, "Invalid request", "The CV link is malformed.");
  }

  const service = createServiceClient();
  const { data: profileRow, error: profileErr } = await service
    .from("talent_profiles")
    .select("cv_path, cv_url")
    .eq("id", id)
    .maybeSingle();
  if (profileErr || !profileRow) {
    return htmlError(404, "CV not found", "We couldn't find this talent profile.");
  }
  const cvPath =
    (profileRow.cv_path as string | null) ??
    deriveCvPathFromUrl(profileRow.cv_url as string | null);
  if (!cvPath) {
    return htmlError(
      404,
      "CV not found",
      "This talent profile doesn't have a CV file attached.",
    );
  }

  const url = new URL(request.url);
  const downloadMode = url.searchParams.get("download") === "1";

  const { data: signed, error: signErr } = await service.storage
    .from(CV_BUCKET)
    .createSignedUrl(
      cvPath,
      CV_SIGNED_URL_TTL_SECONDS,
      downloadMode ? { download: true } : undefined,
    );
  if (signErr || !signed?.signedUrl) {
    return htmlError(
      500,
      "Could not open CV",
      "Something went wrong generating the secure link. Please try again.",
    );
  }

  service
    .from("signed_url_logs")
    .insert({
      user_id: adminCtx.user.id,
      candidate_id: id,
      source_table: "talent_profiles",
      was_admin: true,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  return NextResponse.redirect(signed.signedUrl, 302);
}
