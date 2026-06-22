import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { createServiceClient } from "@/lib/supabase/server";
import { extractPdfTextServer } from "@/lib/pdf-text";

// pdf-parse / unpdf require Node. Pdfjs internally uses APIs not available
// on the edge runtime, so pin nodejs explicitly.
export const runtime = "nodejs";
// Backfill walks up to ~100 rows sequentially. Each row: 1 storage download
// + 1 PDF parse (~100-400ms typical, helper caps at 6s). Even a worst-case
// run finishes well under 60s for the current row counts (13 + 4), but the
// extra headroom matches /api/admin/extract-cv and protects against a
// future re-run on a larger backlog.
export const maxDuration = 60;

// ── Types ────────────────────────────────────────────────────

type BackfillTableKey = "applications" | "talent" | "both";

type RowResult =
  | { id: string; ok: true; chars: number }
  | { id: string; ok: false; reason: string };

type TableSummary = {
  table: string;
  scanned: number;
  updated: number;
  failed: number;
  details: RowResult[];
};

// ── Body parsing (optional) ─────────────────────────────────

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseTable(v: unknown): BackfillTableKey {
  if (v === "applications" || v === "talent" || v === "both") return v;
  return "both";
}

function parseLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_LIMIT;
  const rounded = Math.floor(v);
  if (rounded <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, rounded);
}

// ── Core ─────────────────────────────────────────────────────

async function backfillTable(
  tableName: "job_applications" | "talent_profiles",
  hasStatusCols: boolean,
  limit: number,
): Promise<TableSummary> {
  const service = createServiceClient();
  const summary: TableSummary = {
    table: tableName,
    scanned: 0,
    updated: 0,
    failed: 0,
    details: [],
  };

  const { data: rows, error: selectErr } = await service
    .from(tableName)
    .select("id, cv_path")
    .is("cv_text", null)
    .not("cv_path", "is", null)
    .limit(limit);

  if (selectErr) {
    summary.details.push({
      id: `(select)`,
      ok: false,
      reason: `select_failed: ${selectErr.message}`,
    });
    summary.failed += 1;
    return summary;
  }

  const candidates = (rows ?? []) as Array<{ id: string; cv_path: string | null }>;
  summary.scanned = candidates.length;

  for (const row of candidates) {
    const cvPath = row.cv_path;
    if (!cvPath) {
      // Should be ruled out by the .not("cv_path", "is", null) above, but
      // belt-and-braces: skip rows with a null/empty cv_path.
      summary.details.push({ id: row.id, ok: false, reason: "no_cv_path" });
      summary.failed += 1;
      continue;
    }

    // 1. Download from the "cvs" bucket.
    const { data: blob, error: dlErr } = await service.storage
      .from("cvs")
      .download(cvPath);
    if (dlErr || !blob) {
      summary.details.push({
        id: row.id,
        ok: false,
        reason: `download_failed${dlErr ? `: ${dlErr.message}` : ""}`,
      });
      summary.failed += 1;
      continue;
    }

    // 2. Extract text. Helper never throws — always returns { text, status, error }.
    const buffer = Buffer.from(await blob.arrayBuffer());
    const result = await extractPdfTextServer(buffer);

    // 3. Build the per-row update.
    const hasText = typeof result.text === "string" && result.text.length > 0;

    if (hasText) {
      const patch: Record<string, unknown> = { cv_text: result.text };
      if (hasStatusCols) {
        patch.cv_text_status = result.status;
        patch.cv_text_error = result.error;
      }
      const { error: updateErr } = await service
        .from(tableName)
        .update(patch)
        .eq("id", row.id);
      if (updateErr) {
        summary.details.push({
          id: row.id,
          ok: false,
          reason: `update_failed: ${updateErr.message}`,
        });
        summary.failed += 1;
        continue;
      }
      summary.updated += 1;
      summary.details.push({
        id: row.id,
        ok: true,
        chars: result.text?.length ?? 0,
      });
      continue;
    }

    // 4. No text. For applications, still record the status so we know we
    //    tried (and don't keep retrying every backfill run on a CV that
    //    truly has no extractable text). For talent_profiles there are no
    //    status columns, so just record the result in the response and
    //    leave the row alone.
    if (hasStatusCols) {
      const { error: updateErr } = await service
        .from(tableName)
        .update({
          cv_text_status: result.status,
          cv_text_error: result.error,
        })
        .eq("id", row.id);
      if (updateErr) {
        summary.details.push({
          id: row.id,
          ok: false,
          reason: `status_update_failed: ${updateErr.message}`,
        });
        summary.failed += 1;
        continue;
      }
    }
    summary.failed += 1;
    summary.details.push({
      id: row.id,
      ok: false,
      reason: result.error ?? "no_text",
    });
  }

  return summary;
}

// ── Handler ──────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // 1. Super-admin gate. Mirrors extract-cv/route.ts:130-137's try/catch shape.
  try {
    await requireSuperAdmin();
  } catch {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  // 2. Optional JSON body — { table?: "applications" | "talent" | "both",
  //    limit?: number }. Missing/invalid → safe defaults.
  let table: BackfillTableKey = "both";
  let limit = DEFAULT_LIMIT;
  try {
    const raw = await request.json();
    if (raw && typeof raw === "object") {
      const body = raw as Record<string, unknown>;
      table = parseTable(body.table);
      limit = parseLimit(body.limit);
    }
  } catch {
    // No body / invalid JSON — keep defaults.
  }

  try {
    const results: TableSummary[] = [];
    if (table === "applications" || table === "both") {
      results.push(
        await backfillTable("job_applications", /* hasStatusCols */ true, limit),
      );
    }
    if (table === "talent" || table === "both") {
      results.push(
        await backfillTable("talent_profiles", /* hasStatusCols */ false, limit),
      );
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("[backfill-cv-text] unexpected error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "backfill_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
