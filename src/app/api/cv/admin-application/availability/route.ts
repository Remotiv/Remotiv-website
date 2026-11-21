import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { adminApplicationScope } from "@/lib/admin-scope";
import { availabilityOf, type CvAvailability, cvObjectState } from "@/lib/cv-object";
import { deriveCvPathFromUrl } from "@/lib/cv-path";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Which of a page of admin applications have a CV that can really be opened
 * (#6). POST { ids } -> { results: { [id]: "available" | "unavailable" |
 * "unknown" | "none" } }.
 *
 * One request per page of the admin Applications table, so a row whose file
 * is gone shows "CV unavailable" instead of View and Download links that fail.
 * The answer is storage's own (cv-object.ts); a storage error is "unknown" and
 * the table keeps its links. Same guard and scope as the CV route
 * ([id]/route.ts): requireAdmin, and adminApplicationScope in the query, so a
 * company's application is simply absent from the answer. Nothing is opened,
 * so nothing is logged in signed_url_logs.
 */

const CV_BUCKET = "cvs";
/** A table page is 20 rows; a little headroom, and a hard ceiling. */
const MAX_IDS = 50;
/** Storage reads in flight at once. */
const CONCURRENCY = 4;

export async function POST(request: Request) {
  const rl = rateLimit(request, {
    bucketKey: "cv-admin-availability",
    group: "security",
    max: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorised." }, { status: 403 });
  }

  let ids: string[];
  try {
    const body = (await request.json()) as { ids?: unknown };
    ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  ids = [...new Set(ids)].filter((id) => id.length > 0 && id.length <= 100);
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const service = createServiceClient();
  const { data, error } = await service
    .from("job_applications")
    .select("id, cv_path, cv_url")
    .in("id", ids)
    .or(await adminApplicationScope());
  if (error) {
    console.error("[cv-admin-availability] application read failed:", error.code ?? "error");
    return NextResponse.json({ error: "Couldn't check the CVs." }, { status: 502 });
  }

  const rows = (data ?? []) as { id: string; cv_path: string | null; cv_url: string | null }[];
  const bucket = service.storage.from(CV_BUCKET);
  const results: Record<string, CvAvailability | "none"> = {};
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const path = row.cv_path ?? deriveCvPathFromUrl(row.cv_url);
      results[row.id] = path ? availabilityOf(await cvObjectState(bucket, path)) : "none";
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, lane));
  return NextResponse.json({ results });
}
