"use server";

import { createServiceClient } from "@/lib/supabase/server";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { revalidatePath } from "next/cache";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import { enqueue } from "@/lib/jobs-queue";
import {
  PIPELINE_STAGES,
  type ApplicantScore,
  type ApplicantScoreDetail,
  type CompanyApplicantDetail,
  type CompanyApplicantQuery,
  type CompanyApplicantRow,
  type PipelineStage,
  type ScoreConfidence,
  type ScoreStatus,
  type ScoreStrengthRow,
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

/** Summary columns for the list; the drawer selects the jsonb on top. */
const SCORE_SUMMARY_COLUMNS =
  "application_id, status, overall_score, human_adjusted_score, confidence, error";

type ScoreSummaryRow = {
  application_id: string;
  status: string | null;
  overall_score: number | null;
  human_adjusted_score: number | null;
  confidence: string | null;
  error: string | null;
};

/** An applicant with no score row at all reads as pending, not as an error. */
const NO_SCORE: ApplicantScore = {
  status: "pending",
  overall: null,
  adjusted: false,
  confidence: null,
  error: null,
};

/**
 * A human override wins over the model's number wherever a score is shown —
 * that is the whole point of the column. `adjusted` lets the UI say so rather
 * than passing a human judgement off as the AI's.
 */
function toScore(r: ScoreSummaryRow | undefined): ApplicantScore {
  if (!r) return NO_SCORE;
  const status = (r.status ?? "pending") as ScoreStatus;
  const adjusted = r.human_adjusted_score != null;
  const overall =
    status === "scored" ? (r.human_adjusted_score ?? r.overall_score) : null;
  return {
    status,
    overall,
    adjusted,
    confidence: (r.confidence as ScoreConfidence | null) ?? null,
    error: r.error,
  };
}

function jsonArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Strengths are {point, quote} from prompt v2 onward; v1 rows stored bare
 * strings. Normalise both so a scorecard written before the change still
 * renders — it simply has no quote to show.
 */
function normaliseStrengths(v: unknown): ScoreStrengthRow[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((raw) => {
      if (typeof raw === "string") return { point: raw, quote: "" };
      const o = raw as Record<string, unknown>;
      return {
        point: typeof o?.point === "string" ? o.point : "",
        quote: typeof o?.quote === "string" ? o.quote : "",
      };
    })
    .filter((x) => x.point.length > 0);
}

function toRow(r: ApplicantQueryRow, score?: ScoreSummaryRow): CompanyApplicantRow {
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
    score: toScore(score),
    has_cv: Boolean(r.cv_path || r.cv_url),
  };
}

/**
 * Score summaries for a set of applications, keyed by application_id.
 *
 * Fetched in id batches rather than one giant `.in()` — a few thousand uuids
 * overflow the PostgREST request URL, the same limit the applicants list
 * already range-pages around.
 */
async function fetchScoreSummaries(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  applicationIds: string[],
): Promise<Map<string, ScoreSummaryRow>> {
  const byId = new Map<string, ScoreSummaryRow>();
  const CHUNK = 200;

  for (let i = 0; i < applicationIds.length; i += CHUNK) {
    const chunk = applicationIds.slice(i, i + CHUNK);
    const { data, error } = await service
      .from("application_scores")
      .select(SCORE_SUMMARY_COLUMNS)
      .eq("company_id", companyId)
      .in("application_id", chunk);

    if (error) {
      // A scoring outage must not blank the applicants list — every row simply
      // reads as pending, which is what it looks like before scoring anyway.
      console.error("[applicants] score summary query failed:", error);
      return byId;
    }
    for (const r of (data ?? []) as ScoreSummaryRow[]) {
      byId.set(r.application_id, r);
    }
  }
  return byId;
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

  const scores = await fetchScoreSummaries(
    service,
    ctx.companyId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toRow(r, scores.get(r.id)));
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

  // Full scorecard — the jsonb columns are drawer-only, never in the list.
  const { data: scoreData, error: scoreErr } = await service
    .from("application_scores")
    .select(
      `${SCORE_SUMMARY_COLUMNS}, dimension_scores, evidence, strengths, missing_requirements, concerns, summary, screening_score, ai_model, scored_at`,
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  if (scoreErr) {
    console.error("[applicants] score detail query failed:", scoreErr);
  }

  const sRow = scoreData as (ScoreSummaryRow & Record<string, unknown>) | null;
  const scoreDetail: ApplicantScoreDetail | null = sRow
    ? {
        ...toScore(sRow),
        dimensions: jsonArray(sRow.dimension_scores),
        evidence: jsonArray(sRow.evidence),
        strengths: normaliseStrengths(sRow.strengths),
        missing_requirements: jsonArray(sRow.missing_requirements),
        concerns: jsonArray(sRow.concerns),
        summary: (sRow.summary as string | null) ?? null,
        screening_score: (sRow.screening_score as number | null) ?? null,
        ai_model: (sRow.ai_model as string | null) ?? null,
        scored_at: (sRow.scored_at as string | null) ?? null,
      }
    : null;

  return {
    applicant: toRow(row, sRow ?? undefined),
    history: (histData ?? []) as StageHistoryRow[],
    scoreDetail,
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

/**
 * Re-queue AI scoring for one application.
 *
 * Ownership is re-checked against company_id_snapshot before enqueueing: the
 * client-supplied id proves nothing, and without the check any member could
 * spend another company's scoring budget on their applicants.
 *
 * The handler upserts on the unique application_id, so re-scoring overwrites
 * the previous card rather than erroring or accumulating duplicates.
 */
export async function rescoreApplication(
  applicationId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const service = createServiceClient();
  const { data } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, job_id")
    .eq("id", applicationId)
    .maybeSingle();

  const target = data as {
    company_id_snapshot: string | null;
    job_id: string | null;
  } | null;

  // Not-found and not-yours return the SAME message so ids can't be probed.
  if (!target || target.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: "Applicant not found in your workspace." };
  }
  if (!target.job_id) {
    return { success: false, error: "This application has no job to score against." };
  }

  const queued = await enqueue({
    type: "ai_cv_score",
    payload: { applicationId },
    companyId: ctx.companyId,
  });
  if (!queued.ok) return { success: false, error: queued.error };

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

/**
 * Re-queue scoring for every application on one job — the after-you-changed-
 * the-criteria path.
 *
 * The job's own ownership is checked once, then applications are selected by
 * BOTH job_id and company_id_snapshot, so a mismatched snapshot can never be
 * swept in. Range-paged for the same reason the list is.
 */
export async function rescoreJob(
  jobId: string,
): Promise<MutationResult<{ queued: number }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");
  const service = createServiceClient();

  const { data: jobData } = await service
    .from("jobs")
    .select("id, company_id")
    .eq("id", jobId)
    .maybeSingle();

  const job = jobData as { company_id: string | null } | null;
  if (!job || job.company_id !== ctx.companyId) {
    return { success: false, error: "Job not found in your workspace." };
  }

  const PAGE = 1000;
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from("job_applications")
      .select("id")
      .eq("job_id", jobId)
      .eq("company_id_snapshot", ctx.companyId)
      .range(from, from + PAGE - 1);

    if (error) return { success: false, error: error.message };
    const batch = (data ?? []) as { id: string }[];
    ids.push(...batch.map((b) => b.id));
    if (batch.length < PAGE) break;
  }

  // One job row per application. Enqueued sequentially in small waves so a
  // 500-applicant job doesn't open 500 concurrent inserts.
  let queued = 0;
  const WAVE = 25;
  for (let i = 0; i < ids.length; i += WAVE) {
    const results = await Promise.all(
      ids.slice(i, i + WAVE).map((applicationId) =>
        enqueue({
          type: "ai_cv_score",
          payload: { applicationId },
          companyId: ctx.companyId,
        }),
      ),
    );
    queued += results.filter((r) => r.ok).length;
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { queued } };
}
