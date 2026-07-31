import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";

export const runtime = "nodejs";

// Company-side CV open. A ROUTE, not a server action, because the browser
// navigates to it directly from an <a target="_blank"> — signing server-side
// and 302-redirecting avoids the popup blocker that trips on a JS-after-await
// window.open.
//
// Self-contained by design: bucket, TTL and the signed_url_logs shape MUST
// match the admin route (src/app/api/cv/admin-application/[id]/route.ts), but
// the two products never import each other's guards or helpers.

const CV_BUCKET = "cvs";
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — matches the admin route

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
  routeCtx: { params: Promise<{ id: string }> },
) {
  const rl = rateLimit(request, {
    bucketKey: "cv-company-application",
    max: 30,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return htmlError(
      429,
      "Too many requests",
      "You've opened a lot of CVs in a short window. Please wait a moment and try again.",
    );
  }

  const { id } = await routeCtx.params;
  if (!id) {
    return htmlError(400, "Invalid request", "No application was specified.");
  }

  // 1. Resolve the company. Throws for any non-company session.
  let ctx: Awaited<ReturnType<typeof getCompanyContext>>;
  try {
    ctx = await getCompanyContext();
  } catch {
    return htmlError(
      403,
      "Not authorised",
      "Sign in to your company workspace to open this CV.",
    );
  }

  const service = createServiceClient();

  // 2. Ownership gate BEFORE signing. Scoped on company_id_snapshot for the
  //    same reason the list is: it survives job deletion.
  const { data: appRow } = await service
    .from("job_applications")
    .select("id, cv_path, cv_url, company_id_snapshot")
    .eq("id", id)
    .maybeSingle();

  const application = appRow as {
    id: string;
    cv_path: string | null;
    cv_url: string | null;
    company_id_snapshot: string | null;
  } | null;

  // Missing and not-yours return the SAME response on purpose — a distinct
  // 404 would confirm that some other company's application id exists.
  if (!application || application.company_id_snapshot !== ctx.companyId) {
    return htmlError(
      404,
      "CV not found",
      "This application isn't in your workspace, or it no longer exists.",
    );
  }

  // 3. Resolve the storage path (prefer cv_path; derive from the legacy public
  //    cv_url for rows that predate the private bucket).
  const cvPath = application.cv_path ?? deriveCvPathFromUrl(application.cv_url);
  if (!cvPath) {
    return htmlError(
      404,
      "CV not found",
      "This application doesn't have a CV file attached.",
    );
  }

  // 4. ?download=1 forces Content-Disposition: attachment.
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

  // 5. Audit log — fire-and-forget; a logging failure must not block the grant.
  //    Same shape as the admin route, with was_admin false so the two can be
  //    told apart in analytics.
  service
    .from("signed_url_logs")
    .insert({
      user_id: ctx.user.id,
      candidate_id: id,
      source_table: "job_applications",
      was_admin: false,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  return NextResponse.redirect(signed.signedUrl, 302);
}
