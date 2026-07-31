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
// 60s ceiling. The route moves exactly the application ids it's handed (≤15);
// each runs one sequential Haiku extraction (~3-5s), so a full call finishes
// inside 60s. The client passes one page's eligible ids, chunked to ≤12.
export const runtime = "nodejs";
export const maxDuration = 60;

// Sequential AI calls dominate the budget: ~12 × ~5s worst case ≈ 60s. The
// client chunks a page's ids to ≤12 per call; this hard cap defends the limit.
const MAX_IDS = 6;
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
  const rawIds = (body as { ids?: unknown })?.ids;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length === 0 ||
    !rawIds.every((x) => typeof x === "string")
  ) {
    return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
  }
  const ids = rawIds as string[];
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { ok: false, error: `too many ids (max ${MAX_IDS} per call)` },
      { status: 400 },
    );
  }

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

  // 2. Fetch exactly the requested applications, gated to completed-CV rows.
  //    The .in("id", ids) list is small (≤15 short UUIDs), so it's URL-safe.
  //    Filtering on cv_text_status here enforces the completed gate server-side:
  //    a non-completed id simply isn't returned (neither moved nor counted).
  const { data: rows, error: fetchErr } = await service
    .from("job_applications")
    .select("id, email, cv_text")
    .eq("cv_text_status", "completed")
    // Company applicants are never moved into Remotiv's talent pool. A
    // company id in the batch is simply not returned — neither moved nor
    // counted, matching how a non-completed id is handled.
    .is("company_id_snapshot", null)
    .in("id", ids);
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

  return NextResponse.json({
    ok: true,
    requested: ids.length,
    eligibleCompleted: window.length,
    moved,
    skipped_already: skippedAlready,
    skipped_no_ai: skippedNoAi,
    skipped_no_email: skippedNoEmail,
    failed,
    results,
  });
}
