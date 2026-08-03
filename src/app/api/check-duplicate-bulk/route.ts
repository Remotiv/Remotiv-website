import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { requireAdmin } from "@/app/admin/lib/role-guards";
import { adminApplicationScope } from "@/lib/admin-scope";

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
 * Body: { rows: Array<{ email?: string | null; phone?: string | null }> }
 * Response: { results: Array<DupResult> }
 *   where DupResult = { source: 'batch' | 'application' | 'talent' | null; name: string | null }
 */

const MAX_ROWS = 100;
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
  const rl = rateLimit(request, { bucketKey: "check-duplicate-bulk" });
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

    // Per-row check, three tables in parallel. 50 rows × 3 = 150 in-flight
    // queries — well within Supabase limits, and each row's three checks
    // race so the user-facing latency is just the slowest single query.
    const results: DupResult[] = await Promise.all(
      rows.map(async (row): Promise<DupResult> => {
        const email = row.email?.toString().trim().toLowerCase() ?? "";
        const phone = row.phone?.toString().trim() ?? "";

        const orParts: string[] = [];
        if (email) orParts.push(`email.eq.${email}`);
        if (phone) orParts.push(`phone.eq.${phone}`);
        if (orParts.length === 0) return { source: null, name: null };

        const orFilter = orParts.join(",");

        const [batchRes, appRes, talentRes] = await Promise.all([
          supabase
            .from("client_batch_candidates")
            .select("first_name, last_name")
            .or(orFilter)
            .limit(1)
            .maybeSingle(),
          supabase
            .from("job_applications")
            .select("first_name, last_name")
            .or(orFilter)
            // Remotiv-owned applications only — this endpoint is reachable
            // from the public apply flow, and a match confirms that the
            // person applied somewhere. A customer's applicants are their
            // data, not a signal Remotiv surfaces publicly.
            .or(await adminApplicationScope())
            .limit(1)
            .maybeSingle(),
          supabase
            .from("talent_profiles")
            .select("first_name, last_name")
            .or(orFilter)
            .limit(1)
            .maybeSingle(),
        ]);

        if (batchRes.data)  return { source: "batch",       name: safeName(batchRes.data as { first_name: string; last_name: string }) };
        if (appRes.data)    return { source: "application", name: safeName(appRes.data as { first_name: string; last_name: string }) };
        if (talentRes.data) return { source: "talent",      name: safeName(talentRes.data as { first_name: string; last_name: string }) };
        return { source: null, name: null };
      }),
    );

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
