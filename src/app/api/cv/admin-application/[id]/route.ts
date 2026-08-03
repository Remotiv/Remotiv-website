import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { adminApplicationScope } from "@/lib/admin-scope";

export const runtime = "nodejs";

// Safari-safe CV open (Option C pilot): the dashboard's View/Download buttons
// become plain <a target="_blank"> links to this route, which signs the CV
// server-side and 302-redirects to the Supabase signed URL. No popup-blocking
// because the navigation is a direct anchor click — no JS-after-await gap.
//
// Self-contained on purpose. The file comment on getApplicationCvSignedUrl in
// src/app/admin/applications/actions.ts explicitly warns against cross-importing
// the browse-talent helpers; we keep this route the same way. Bucket / TTL /
// audit-log shape MUST match getApplicationCvSignedUrl exactly.

const CV_BUCKET = "cvs";
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — matches the action

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
  // 1. Rate limit (per-IP). Mirrors send-invite/route.ts pattern; 60/min is
  //    generous for clicking through a list of CVs.
  const rl = rateLimit(request, {
    bucketKey: "cv-admin-application",
    max: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // 2. Auth — requireAdmin accepts super_admin OR admin; throws otherwise.
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

  // 3. Validate id (Next 16: params is a Promise that must be awaited).
  const { id } = await ctx.params;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) {
    return htmlError(400, "Invalid request", "The CV link is malformed.");
  }

  // 4. Look up CV path.
  const service = createServiceClient();
  const { data: appRow, error: appErr } = await service
    .from("job_applications")
    .select("cv_path, cv_url")
    .eq("id", id)
    // Hard product separation: an application to a COMPANY-owned job
    // (company_id_snapshot non-null) belongs to that company's pipeline and is
    // never signed for Remotiv admin. Filtering in the query rather than
    // branching after the fetch means a company row returns null here and
    // falls into the SAME generic "CV not found" a genuinely missing row
    // gets — no distinct error that would confirm the application exists.
    .or(await adminApplicationScope())
    .maybeSingle();
  if (appErr || !appRow) {
    return htmlError(404, "CV not found", "We couldn't find this application.");
  }
  const cvPath =
    (appRow.cv_path as string | null) ??
    deriveCvPathFromUrl(appRow.cv_url as string | null);
  if (!cvPath) {
    return htmlError(
      404,
      "CV not found",
      "This application doesn't have a CV file attached.",
    );
  }

  // 5. Download mode? ?download=1 → force Content-Disposition: attachment via
  //    Supabase's createSignedUrl({ download: true }) option (storage-js adds
  //    a ?download= query param to the signed URL the storage server honors).
  const url = new URL(request.url);
  const downloadMode = url.searchParams.get("download") === "1";

  // 6. Sign.
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

  // 7. Audit log — fire-and-forget; a logging failure must not block the
  //    grant. Mirrors the insert shape in getApplicationCvSignedUrl exactly
  //    so analytics stay consistent.
  service
    .from("signed_url_logs")
    .insert({
      user_id: adminCtx.user.id,
      candidate_id: id,
      source_table: "job_applications",
      was_admin: true,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  // 8. Redirect to the signed URL. 302 = temporary; the browser will follow
  //    immediately and the user lands on the (Supabase-served) PDF.
  return NextResponse.redirect(signed.signedUrl, 302);
}
