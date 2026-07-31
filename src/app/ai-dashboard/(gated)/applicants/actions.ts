"use server";

import { createServiceClient } from "@/lib/supabase/server";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { revalidatePath } from "next/cache";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import {
  PIPELINE_STAGES,
  type CompanyApplicantDetail,
  type CompanyApplicantQuery,
  type CompanyApplicantRow,
  type PipelineStage,
  type StageHistoryRow,
} from "@/app/ai-dashboard/lib/applicant-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Row/query types live in lib/applicant-types.ts.

/**
 * `cv_path` is deliberately absent from what we return, but IS selected so we
 * can derive `has_cv`. `cv_url` is the legacy public-URL column kept for rows
 * that predate the private bucket.
 */
const APPLICANT_COLUMNS =
  "id, first_name, last_name, email, phone, linkedin_url, job_id, job_title_snapshot, screening_answers, city, country, years_experience, notice_period, availability, created_at, pipeline_stage, cv_path, cv_url, jobs(title)";

type ApplicantQueryRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  screening_answers: unknown;
  city: string | null;
  country: string | null;
  years_experience: number | null;
  notice_period: string | null;
  availability: string | null;
  created_at: string | null;
  pipeline_stage: string | null;
  cv_path: string | null;
  cv_url: string | null;
  jobs: { title: string | null } | null;
};

function toRow(r: ApplicantQueryRow): CompanyApplicantRow {
  return {
    id: r.id,
    first_name: r.first_name ?? "",
    last_name: r.last_name ?? "",
    email: r.email ?? "",
    phone: r.phone,
    linkedin_url: r.linkedin_url,
    job_id: r.job_id,
    // Live title first; the snapshot is what survives a deleted job.
    job_title: r.jobs?.title?.trim() || r.job_title_snapshot?.trim() || "—",
    screening_answers: Array.isArray(r.screening_answers)
      ? (r.screening_answers as ScreeningAnswerSnapshot[])
      : [],
    city: r.city,
    country: r.country,
    years_experience: r.years_experience,
    notice_period: r.notice_period,
    availability: r.availability,
    created_at: r.created_at ?? "",
    // DB default is 'applied'; the coalesce covers rows written before the
    // column existed.
    pipeline_stage: ((r.pipeline_stage as PipelineStage) ?? "applied"),
    has_cv: Boolean(r.cv_path || r.cv_url),
  };
}

/**
 * Every applicant belonging to the viewer's company. Readable by any active
 * member; nothing here mutates.
 *
 * Scoped on `company_id_snapshot`, NOT a join through jobs.company_id. Two
 * reasons: the snapshot survives job deletion (job_id is ON DELETE SET NULL,
 * so a joined scope would silently drop those applicants), and it keeps this a
 * flat single-table filter — no `jobs!inner` embed, whose default LEFT join
 * makes `.eq("jobs.company_id", …)` an unreliable tenant boundary. The jobs
 * embed here is display-only.
 */
export async function fetchCompanyApplicants(
  query: CompanyApplicantQuery = {},
): Promise<CompanyApplicantRow[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const search = (query.search ?? "").trim();

  // Range-paged: job_applications has hit the PostgREST 1000-row cap before,
  // and an unbounded select silently truncates rather than erroring.
  const PAGE = 1000;
  const rows: ApplicantQueryRow[] = [];

  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("job_applications")
      .select(APPLICANT_COLUMNS)
      .eq("company_id_snapshot", ctx.companyId);

    if (query.jobId) q = q.eq("job_id", query.jobId);
    if (search) {
      const safe = search.replace(/[%,()]/g, " ");
      q = q.or(
        `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%`,
      );
    }

    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("[applicants] fetchCompanyApplicants failed:", error);
      return [];
    }

    const batch = (data ?? []) as unknown as ApplicantQueryRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  return rows.map(toRow);
}

/**
 * One applicant plus their stage history, for the detail drawer. Same tenant
 * boundary as the list — a client-supplied id proves nothing about who owns
 * the row.
 */
export async function fetchCompanyApplicant(
  applicationId: string,
): Promise<CompanyApplicantDetail | null> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data, error } = await service
    .from("job_applications")
    .select(APPLICANT_COLUMNS)
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  if (error) {
    console.error("[applicants] fetchCompanyApplicant failed:", error);
    return null;
  }

  const row = data as unknown as ApplicantQueryRow | null;
  if (!row) return null;

  // History is scoped by company_id too, not just application_id — the tenant
  // boundary shouldn't rest on the id lookup alone.
  const { data: histData, error: histErr } = await service
    .from("application_stage_history")
    .select("id, from_stage, to_stage, changed_by_name, note, created_at")
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false });

  if (histErr) {
    // A missing audit trail shouldn't blank the drawer.
    console.error("[applicants] stage history query failed:", histErr);
  }

  return {
    applicant: toRow(row),
    history: (histData ?? []) as StageHistoryRow[],
  };
}

// ── Mutations ────────────────────────────────────────────────

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Move an applicant through the hiring pipeline.
 *
 * Every active member may do this, including hiring managers — reviewing and
 * advancing candidates is their core job, and the role model grants them
 * "review applicants / move pipeline".
 *
 * Transitions are deliberately NOT forward-only: recruiters routinely move
 * people backwards (an interview that reveals a gap, a re-opened offer), and
 * blocking that would just push them to work around the tool.
 */
export async function updateApplicationStage(
  applicationId: string,
  toStage: string,
  note?: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole(
    "owner",
    "admin",
    "recruiter",
    "hiring_manager",
  );

  // Validate against the union server-side — never trust a client string.
  if (!(PIPELINE_STAGES as readonly string[]).includes(toStage)) {
    return { success: false, error: "Invalid pipeline stage." };
  }

  const service = createServiceClient();

  // Re-fetch and verify ownership before writing. Not-found and not-yours
  // return the SAME message so a probe can't confirm another company's id.
  const { data: targetRow } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, pipeline_stage")
    .eq("id", applicationId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id_snapshot: string | null;
    pipeline_stage: string | null;
  } | null;

  if (!target || target.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: "Applicant not found in your workspace." };
  }

  const fromStage = (target.pipeline_stage as PipelineStage) ?? "applied";
  // No-op: don't write a history row for a stage that didn't change.
  if (fromStage === toStage) return { success: true, data: undefined };

  const { error: updateErr } = await service
    .from("job_applications")
    .update({ pipeline_stage: toStage })
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  if (updateErr) return { success: false, error: updateErr.message };

  // Audit row AFTER the stage lands. A failure here is logged but does NOT
  // fail the action: the move is the user's intent and it has already
  // committed, so surfacing an error would imply the change was rejected when
  // it wasn't — and a retry would then no-op on the unchanged-stage guard,
  // leaving them stuck. The cost is a gap in the trail, not wrong state.
  const { error: histErr } = await service
    .from("application_stage_history")
    .insert({
      application_id: applicationId,
      company_id: ctx.companyId,
      from_stage: fromStage,
      to_stage: toStage,
      changed_by: ctx.user.id,
      changed_by_name: ctx.memberName,
      note: note?.trim() || null,
    });

  if (histErr) {
    console.error(
      "[applicants] stage history insert failed for",
      applicationId,
      histErr,
    );
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}
