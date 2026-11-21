import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { adminApplicationScope } from "@/lib/admin-scope";
import { findContactDuplicate } from "@/lib/contact-duplicates";

/**
 * POST /api/check-duplicate-bulk
 *
 * Cross-table duplicate detection used by the batch-detail bulk CV upload
 * modal during its review phase. Accepts an array of {email, phone} pairs;
 * returns one match descriptor per row (same array order).
 *
 * Each row is checked against:
 *   1. client_batch_candidates (any batch)
 *   2. job_applications
 *   3. talent_profiles
 *
 * The first match wins (priority above). The modal uses `source` to render
 * "Already in Batch / Apps / Talent" badges and auto-deselect the row.
 *
 * Auth: requireAdmin — only admins should be able to query across tables.
 *
 * A row that cannot be checked fails the whole request (503), never "new":
 * the modal then stops before anything is submitted.
 *
 * Body: { rows: Array<{ email?: string | null; phone?: string | null }> }
 * Response: { results: Array<DupResult> }
 *   where DupResult = { source: 'batch' | 'application' | 'talent' | null; name: string | null }
 */

const MAX_ROWS = 100;

/** Returned with 503 when any row could not be checked. */
const COULD_NOT_CHECK = "We couldn't check these candidates for duplicates. Nothing was changed. Try again.";
type DupSource = "batch" | "application" | "talent" | null;
type DupResult = { source: DupSource; name: string | null };

function safeName(row: { first_name?: string | null; last_name?: string | null } | null): string | null {
  if (!row) return null;
  const f = (row.first_name ?? "").trim();
  const l = (row.last_name ?? "").trim();
  const combined = `${f} ${l}`.trim();
  return combined || null;
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "check-duplicate-bulk", group: "public" });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as {
      rows?: Array<{ email?: string | null; phone?: string | null }>;
    };
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];

    const supabase = createServiceClient();
    // Remotiv-owned applications only. This route is admin-only (requireAdmin
    // above), and a customer's applicants are their data: an admin bulk upload
    // into a Remotiv batch is not the place a customer's applicant surfaces.
    const applicationScope = await adminApplicationScope();
    // Per row, three tables in parallel (findContactDuplicate): up to
    // MAX_ROWS (100) rows × 3 = 300 queries in flight for a full upload.
    const lookups = await Promise.all(
      rows.map((row) =>
        findContactDuplicate(
          supabase,
          {
            email: row.email?.toString().trim().toLowerCase() ?? "",
            phone: row.phone?.toString().trim() ?? "",
          },
          { applicationScope },
        ),
      ),
    );
    if (lookups.some((l) => !l.ok)) {
      return NextResponse.json({ error: COULD_NOT_CHECK }, { status: 503 });
    }
    const results: DupResult[] = lookups.map((l) =>
      l.ok && l.match ? { source: l.match.source, name: safeName(l.match) } : { source: null, name: null },
    );

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
