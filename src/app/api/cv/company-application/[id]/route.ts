import { NextResponse } from "next/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { deriveCvPathFromUrl } from "@/lib/cv-path";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
// No maxDuration export and no vercel.json entry, on purpose: this route
// inherits the project-level Function Max Duration rather than capping itself
// lower. A file download is the one case that should be allowed to run long;
// the lower caps in vercel.json are for routes that must not. The project
// setting Waleed reported is 300 s (nothing in this repo proves it; check the
// deployment). That is still a limit: a download slower than it is cut off
// mid-stream, and a 5 MB CV needs roughly 136 kbps to finish inside it.

// Company-side CV open. A ROUTE, not a server action, because the browser
// navigates to it directly from an <a target="_blank">.
//
// The document is SERVED THROUGH THIS ORIGIN (#99): after the checks below the
// route streams the object's bytes itself. No signed storage URL is ever
// minted, so there is no bearer link to copy, no history entry that opens the
// file without a session, and nothing that outlives a revoked permission: every
// request repeats the company and job checks. What this cannot do is recall a
// document already delivered; see DEPLOYMENT LIMITATIONS in #99.
//
// Self-contained by design: bucket and the signed_url_logs shape MUST match the
// admin route (src/app/api/cv/admin-application/[id]/route.ts), but the two
// products never import each other's guards or helpers. The admin route still
// signs and redirects; that is deferred, not forgotten.

const CV_BUCKET = "cvs";
// A FIXED filename. The applicant's name never rides in a header.
const CV_FILENAME = "cv.pdf";

function htmlError(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:40px;color:#333;max-width:480px;margin:0 auto"><h2 style="margin:0 0 8px;font-weight:600">${title}</h2><p style="margin:0;color:#666">${body}</p></body>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: Request, routeCtx: { params: Promise<{ id: string }> }) {
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
    return htmlError(403, "Not authorised", "Sign in to your company workspace to open this CV.");
  }

  const service = createServiceClient();

  // 2. Ownership gate BEFORE signing. Scoped on company_id_snapshot for the
  //    same reason the list is: it survives job deletion.
  const { data: appRow } = await service
    .from("job_applications")
    .select("id, job_id, cv_path, cv_url, cv_delete_after, company_id_snapshot")
    .eq("id", id)
    .maybeSingle();

  const application = appRow as {
    id: string;
    job_id: string | null;
    cv_path: string | null;
    cv_url: string | null;
    cv_delete_after: string | null;
    company_id_snapshot: string | null;
  } | null;

  // Missing, not-yours and not-your-job return the SAME response on purpose —
  // a distinct 404 would confirm that some other company's application id
  // exists, or that a colleague's job does.
  const notInWorkspace = () =>
    htmlError(
      404,
      "CV not found",
      "This application isn't in your workspace, or it no longer exists.",
    );
  if (!application || application.company_id_snapshot !== ctx.companyId) {
    return notInWorkspace();
  }

  // 2b. Job scope, the pairing gateApplication uses (applicants/actions.ts):
  //     company first, then the viewer's hiring team. Owner and admin pass for
  //     any job of their company; a recruiter or hiring manager passes only for
  //     a job they are on (#97).
  //
  //     job_id is NULL for an application whose job was deleted
  //     (job_applications.job_id is ON DELETE SET NULL on production, read
  //     8 Nov 2026) and for a direct-add candidate. The empty string is
  //     deliberate: canAccessJob answers true for owner and admin before it
  //     reads the id, and false for a scoped role on a missing id. So a
  //     job-less application stays open to the roles that see every job and
  //     closed to the roles that are given jobs one at a time — the same answer
  //     the Applicants list already gives them (.in("job_id", scope)), since an
  //     application on no job is on no hiring team. Nothing here changes those
  //     rows; they stay out of dashboard scope.
  if (!(await canAccessJob(ctx, application.job_id ?? ""))) {
    return notInWorkspace();
  }

  // 3. Resolve the storage path (prefer cv_path; derive from the legacy public
  //    cv_url for rows that predate the private bucket).
  const cvPath = application.cv_path ?? deriveCvPathFromUrl(application.cv_url);
  if (!cvPath) {
    /*
     * Expired and never-supplied are different facts and must not share a
     * message. "No CV attached" on a purged application reads as a broken
     * button — or worse, as an applicant who never sent one.
     *
     * Told apart with no new column, exactly as the interview drawer does it:
     * a retention date that has PASSED, with no path left, is a document this
     * job deleted. A future date with no path never had one.
     */
    const deleteAfter = application.cv_delete_after;
    const expired = Boolean(deleteAfter && new Date(deleteAfter).getTime() <= Date.now());
    return expired
      ? htmlError(
          410,
          "CV expired",
          "CVs are removed 24 months after the application. The applicant's details and your hiring notes are unaffected.",
        )
      : htmlError(404, "CV not found", "This application doesn't have a CV file attached.");
  }

  // 4. ?download=1 forces Content-Disposition: attachment. Nothing in the
  //    dashboard appends it today; the branch exists for a future button.
  const downloadMode = new URL(request.url).searchParams.get("download") === "1";
  const bucket = service.storage.from(CV_BUCKET);

  // 5. The object's size, for Content-Length. A PDF with no length is the case
  //    browser viewers handle worst, so it is read from storage.info, which
  //    describes exactly this path. The path is immutable: every writer uploads
  //    to a fresh <folder>/<uuid>.pdf with upsert false (apply route, attach
  //    action, direct add, import script) and a replace re-points the row to a
  //    new object, so the size read here and the stream in step 7 describe the
  //    same bytes. A missing or malformed size means NO header, never a guess.
  //    The size is a nicety and can never fail the request: an error return and
  //    a THROW (dropped connection, DNS, abort) are both "no size". Nothing of
  //    the thrown object is logged; a storage error is the one place a path or
  //    URL could still reach the logs.
  let contentLength: string | null = null;
  try {
    const { data: info, error: infoErr } = await bucket.info(cvPath);
    const size = infoErr ? undefined : info?.size;
    if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) {
      contentLength = String(size);
    } else {
      console.error("[cv-company-application] size unavailable; serving without Content-Length");
    }
  } catch {
    console.error("[cv-company-application] size read threw; serving without Content-Length");
  }

  // 6. The access log, AWAITED and FAIL-CLOSED (#99; the #71A defect class).
  //    Once the response is a stream the function returns at once, and a
  //    fire-and-forget insert still in flight can be killed with the row
  //    silently lost. So the insert completes before any byte is served, and a
  //    failed insert serves nothing: the same database answered the application
  //    lookup two steps ago, so a failure here is a real fault, not a blip, and
  //    an unlogged view is the one outcome the privacy page rules out. The row
  //    holds who, which application and when (was_admin false, as the admin
  //    route writes true); never a path, URL, token or credential.
  //    Do not move this after the stream and do not drop the await.
  const { error: logErr } = await service.from("signed_url_logs").insert({
    user_id: ctx.user.id,
    candidate_id: id,
    source_table: "job_applications",
    was_admin: false,
  });
  if (logErr) {
    console.error("[cv-company-application] access log insert failed:", logErr.code ?? "error");
    return htmlError(
      500,
      "Could not open CV",
      "Something went wrong opening this document. Please try again.",
    );
  }

  // 7. The bytes, streamed through this origin. asStream forwards the storage
  //    response body chunk by chunk, so the function never holds the file and
  //    the platform's cap on non-streamed response bodies does not apply. No
  //    Accept-Ranges header: byte ranges are not served and must not be
  //    advertised. An error return and a THROW (dropped connection, DNS, abort)
  //    land on the same page below: one path, not two. The error page names no
  //    path, URL or token, and neither does the log line; the thrown object is
  //    never logged.
  let stream: ReadableStream | null = null;
  try {
    const { data, error: streamErr } = await bucket.download(cvPath).asStream();
    if (!streamErr && data) stream = data;
  } catch {
    // Handled below, exactly as an error return.
  }
  if (!stream) {
    console.error("[cv-company-application] storage read failed");
    return htmlError(
      502,
      "Could not open CV",
      "Something went wrong opening this document. Please try again.",
    );
  }

  const headers = new Headers({
    "content-type": "application/pdf",
    "content-disposition": `${downloadMode ? "attachment" : "inline"}; filename="${CV_FILENAME}"`,
    // Never cached by a shared cache or the browser's disk: a private document
    // served to one session.
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(stream, { status: 200, headers });
}
