import { NextResponse } from "next/server";
import {
  type MoveToTalentInput,
  moveApplicationToTalent,
} from "@/app/admin/applications/actions";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { extractTalentFieldsFromCv } from "@/lib/cv-extract";
import { createServiceClient } from "@/lib/supabase/server";

// Reuses the canonical move logic with ZERO replication:
//   - extractTalentFieldsFromCv  → AI fields off stored cv_text
//   - moveApplicationToTalent     → insert/dedupe/archived-restore/avatar.
//                                   That action creates rows pending + hidden
//                                   until an admin approves; this route never
//                                   touches the approval timestamp itself.
// Pinned to nodejs (the AI SDK + the service client both need Node) with the
// 60s ceiling. Each call does at most `limit` sequential Haiku extractions
// (~3-5s each), so the default stays small enough to finish inside 60s; the
// client auto-loops by advancing `offset` until hasMore is false.
export const runtime = "nodejs";
export const maxDuration = 60;

// Sequential AI calls dominate the budget: 10 × ~5s worst case ≈ 50s, leaving
// headroom for the two email range-pages + inserts. Capped at 15.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 15;
const PAGE = 1000;

// Sentinel returned by moveApplicationToTalent when an ACTIVE talent row with
// the same email already exists. We treat it as a skip, not a failure.
const ALREADY_IN_NETWORK = "This applicant is already in the Talent network";

type RowResult = {
  id: string;
  result:
    | "moved"
    | "skipped_already"
    | "skipped_no_ai"
    | "skipped_no_email"
    | "failed";
  error?: string;
};

const normaliseEmail = (raw: unknown): string =>
  typeof raw === "string" ? raw.toLowerCase().trim() : "";

function parseLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_LIMIT;
  const n = Math.floor(v);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

function parseOffset(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n > 0 ? n : 0;
}

export async function POST(request: Request) {
  try {
    await requireSuperAdmin();
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const limit = parseLimit((body as { limit?: unknown })?.limit);
  const offset = parseOffset((body as { offset?: unknown })?.offset);

  const service = createServiceClient();

  // 1. Build the set of emails already in the Pakistan talent pool (non-archived)
  //    via range paging — same count-safe pattern as the applications badge.
  //    Used to skip applicants already moved without a giant .in().
  const movedEmails = new Set<string>();
  {
    let from = 0;
    for (;;) {
      const { data, error } = await service
        .from("talent_profiles")
        .select("email")
        .eq("is_archived", false)
        .range(from, from + PAGE - 1);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      const batch = data ?? [];
      for (const r of batch) {
        const e = normaliseEmail((r as { email: string | null }).email);
        if (e.length > 0) movedEmails.add(e);
      }
      if (batch.length < PAGE) break;
      from += PAGE;
    }
  }

  // 2. Fetch this call's window of completed-CV applications by stable offset.
  //    Offset paging (not "filter the moved ones out of a fixed top-N") so the
  //    window ALWAYS advances — applications are never mutated, so a top-N
  //    ordering would keep returning the same already-moved rows forever.
  const { data: rows, error: fetchErr } = await service
    .from("job_applications")
    .select("id, email, cv_text")
    .eq("cv_text_status", "completed")
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  const window = (rows ?? []) as Array<{
    id: string;
    email: string | null;
    cv_text: string | null;
  }>;

  const results: RowResult[] = [];
  let moved = 0;
  let skippedAlready = 0;
  let skippedNoAi = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  // 3. Process sequentially to respect the 60s budget + avoid Anthropic spikes.
  for (const app of window) {
    const email = normaliseEmail(app.email);
    if (!email) {
      skippedNoEmail++;
      results.push({ id: app.id, result: "skipped_no_email" });
      continue;
    }
    if (movedEmails.has(email)) {
      skippedAlready++;
      results.push({ id: app.id, result: "skipped_already" });
      continue;
    }
    if (typeof app.cv_text !== "string" || app.cv_text.trim().length === 0) {
      skippedNoAi++;
      results.push({ id: app.id, result: "skipped_no_ai" });
      continue;
    }

    try {
      const ai = await extractTalentFieldsFromCv(app.cv_text);
      if (ai === null) {
        skippedNoAi++;
        results.push({ id: app.id, result: "skipped_no_ai" });
        continue;
      }

      const employmentHistory = (ai.employment_history ?? []).map((e) => ({
        title: e.title ?? "",
        company: e.company ?? "",
        dates: [e.start, e.end].filter(Boolean).join(" - "),
        description: e.description ?? "",
      }));
      const firstTitle = employmentHistory.find((e) => e.title)?.title ?? "";

      // Exactly matches MoveToTalentInput. city/country are intentionally
      // omitted — the action reads those from the application row, not input.
      const input: MoveToTalentInput = {
        job_title: ai.applicant_job_title || firstTitle || "Candidate",
        role_category: ai.role_category || "Other",
        years_experience:
          typeof ai.years_experience === "number" ? ai.years_experience : 0,
        industry: "",
        degree: ai.degree || "",
        institution: ai.institution || "",
        skills: Array.isArray(ai.skills) ? ai.skills : [],
        summary: ai.summary || "",
        employment_history: employmentHistory,
        availability: ai.availability || "Available Now",
        work_type: ai.work_type || "Full-time",
        notice_period: ai.notice_period || "Immediate",
        work_location: ai.work_location || "Remote",
        salary_min: null,
        salary_max: null,
      };

      const res = await moveApplicationToTalent(app.id, input);
      if (res.success) {
        moved++;
        movedEmails.add(email); // guard against a duplicate email later in-run
        results.push({ id: app.id, result: "moved" });
      } else if (res.error === ALREADY_IN_NETWORK) {
        skippedAlready++;
        results.push({ id: app.id, result: "skipped_already" });
      } else {
        failed++;
        results.push({ id: app.id, result: "failed", error: res.error });
      }
    } catch (err) {
      failed++;
      results.push({
        id: app.id,
        result: "failed",
        error: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  }

  // hasMore drives the client loop: a full window means more rows likely remain
  // at the next offset. nextOffset always advances past this window.
  const hasMore = window.length === limit;
  const nextOffset = offset + window.length;

  return NextResponse.json({
    ok: true,
    processed: window.length,
    moved,
    skipped_already: skippedAlready,
    skipped_no_ai: skippedNoAi,
    skipped_no_email: skippedNoEmail,
    failed,
    hasMore,
    nextOffset,
    results,
  });
}
