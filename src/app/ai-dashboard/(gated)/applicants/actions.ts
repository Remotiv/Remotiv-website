"use server";

import { revalidatePath } from "next/cache";
import {
  type ApplicantComment,
  type ApplicantScore,
  type ApplicantScoreDetail,
  COMMENT_MAX,
  type CompanyApplicantDetail,
  type CompanyApplicantQuery,
  type CompanyApplicantRow,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
  SCORE_FEEDBACK_MAX,
  type ScoreConfidence,
  type ScoreEvidenceRow,
  type ScoreMustHaveRow,
  type ScoreStatus,
  type ScoreStrengthRow,
  type StageHistoryRow,
  WORTH_A_LOOK_STAGES,
} from "@/app/ai-dashboard/lib/applicant-types";
import { getCompanyContext, requireCompanyRole } from "@/app/ai-dashboard/lib/company-guards";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import { canAccessJob, getJobScope } from "@/app/ai-dashboard/lib/job-scope";
import { sanitiseSearchTerm } from "@/app/ai-dashboard/lib/search-query";
import { cancelPendingRejection, queueStageChange } from "@/lib/email/candidate/triggers";
import { dismissShortlistFlag } from "@/lib/interviews/shortlist";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { enqueue } from "@/lib/jobs-queue";
import { notifyCompany } from "@/lib/notifications/company";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Row/query types live in lib/applicant-types.ts.

/** Matches the bucket the apply route and the CV route both use. */
const CV_BUCKET = "cvs";

/**
 * `cv_path` is deliberately absent from what we return, but IS selected so we
 * can derive `has_cv`. `cv_url` is the legacy public-URL column kept for rows
 * that predate the private bucket. `cv_delete_after` is selected for the same
 * reason — it is what separates an expired CV from one never supplied.
 */
const APPLICANT_COLUMNS =
  "id, first_name, last_name, email, phone, linkedin_url, job_id, job_title_snapshot, screening_answers, city, country, years_experience, notice_period, availability, created_at, pipeline_stage, cv_path, cv_url, cv_delete_after, shortlist_flagged_at, shortlist_flag_reason, jobs(title)";

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
  cv_delete_after: string | null;
  shortlist_flagged_at: string | null;
  shortlist_flag_reason: string | null;
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
  ai_overall: null,
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
  const overall = status === "scored" ? (r.human_adjusted_score ?? r.overall_score) : null;
  return {
    status,
    overall,
    // The model's number travels alongside the override rather than being
    // replaced by it — the UI shows both, and the difference IS the signal.
    ai_overall: status === "scored" ? r.overall_score : null,
    adjusted,
    confidence: (r.confidence as ScoreConfidence | null) ?? null,
    error: r.error,
  };
}

/**
 * Shape the stored must_haves jsonb.
 *
 * A non-array, a missing key or a scorecard produced before v10 all collapse to
 * [] — the same value a job that named no must-haves stores. The two are
 * indistinguishable here and that is fine: both mean "nothing to show", and the
 * drawer renders nothing for either rather than inventing a distinction.
 */
function normaliseMustHaves(v: unknown): ScoreMustHaveRow[] {
  if (!Array.isArray(v)) return [];
  const out: ScoreMustHaveRow[] = [];
  for (const entry of v) {
    const e = entry as { item?: unknown; status?: unknown; quote?: unknown };
    const item = typeof e?.item === "string" ? e.item.trim() : "";
    if (!item) continue;
    out.push({
      item,
      status: e.status === "evidenced" ? "evidenced" : "not_found",
      quote: typeof e.quote === "string" ? e.quote.trim() : "",
    });
  }
  return out;
}

function jsonArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Evidence items, from either storage shape.
 *
 *   bare array                       — v1-v3, and v4 once the column landed
 *   { v, verdict, items: [...] }     — v4 rows written before the column
 *                                      existed, when the verdict had nowhere
 *                                      else to live
 *
 * The envelope branch is pure back-compat and can be deleted once no rows
 * carry it (`select count(*) from application_scores
 *  where jsonb_typeof(evidence) = 'object'` reaching zero).
 */
function evidenceItems(v: unknown): ScoreEvidenceRow[] {
  if (Array.isArray(v)) return v as ScoreEvidenceRow[];
  if (v && typeof v === "object") {
    const items = (v as Record<string, unknown>).items;
    return Array.isArray(items) ? (items as ScoreEvidenceRow[]) : [];
  }
  return [];
}

/**
 * The verdict, checked in write-recency order so no existing row loses it:
 *
 *   1. the `verdict` column      — everything written from now on
 *   2. the evidence envelope     — v4 rows written before the column existed
 *   3. ""                        — v1-v3, which predate the verdict entirely
 *
 * Column first matters: a row that is re-scored after the migration gets a
 * fresh column value while its old envelope may still sit in `evidence`
 * (the upsert overwrites `evidence` too, but ordering it this way means the
 * newer source always wins even if that ever stops being true).
 */
function resolveVerdict(column: unknown, evidence: unknown): string {
  if (typeof column === "string" && column.trim()) return column;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    const v = (evidence as Record<string, unknown>).verdict;
    if (typeof v === "string") return v;
  }
  return "";
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
    pipeline_stage: (r.pipeline_stage as PipelineStage) ?? "applied",
    score: toScore(score),
    has_cv: Boolean(r.cv_path || r.cv_url),
    // A retention date that has PASSED, with nothing left to open. A future
    // date on a row that never had a CV is not expiry, so it stays false.
    cv_expired:
      !r.cv_path &&
      !r.cv_url &&
      Boolean(r.cv_delete_after) &&
      new Date(r.cv_delete_after as string).getTime() <= Date.now(),
    // Passed through exactly as stored. Nothing here decides whether someone is
    // flagged — that is settled when a score lands, server-side.
    shortlist: {
      flaggedAt: r.shortlist_flagged_at,
      reason: r.shortlist_flag_reason,
    },
  };
}

/**
 * How many applicants currently carry the auto-shortlist flag.
 *
 * ── A real aggregate, not a count of what was rendered ───────
 *
 * The Flagged chip's badge has to be right about the whole workspace, and the
 * table shows a page. `count: "exact", head: true` returns the number in
 * Content-Range without transferring a row, so the badge cannot drift from the
 * list the way a client-side `rows.filter(...).length` would once the list is
 * genuinely paged.
 *
 * Scoped identically to the list: company first, then the caller's job scope,
 * then the same optional job filter. The stage predicate matches
 * WORTH_A_LOOK_STAGES exactly — a badge counting flags the list refuses to draw
 * is worse than no badge.
 */
export async function countFlaggedApplicants(
  query: CompanyApplicantQuery = {},
): Promise<Read<number>> {
  const ctx = await getCompanyContext();
  const scope = await getJobScope(ctx);
  // An answer: on no jobs, nothing can be flagged.
  if (scope.scoped && scope.jobIds.length === 0) return answered(0);

  const service = createServiceClient();
  let q = service
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .eq("company_id_snapshot", ctx.companyId)
    .not("shortlist_flagged_at", "is", null)
    .in("pipeline_stage", WORTH_A_LOOK_STAGES as unknown as string[]);

  if (scope.scoped) q = q.in("job_id", scope.jobIds);
  if (query.jobId) q = q.eq("job_id", query.jobId);

  const { count, error } = await q;
  // Zero is an answer — "nothing is flagged". A failed count is not that
  // answer, and returning 0 for it made the two identical at the boundary even
  // though the consumer happens to render them the same.
  if (error) {
    console.error("[applicants] countFlaggedApplicants failed:", error.message);
    return unavailable();
  }
  return answered(count ?? 0);
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
): Promise<Read<CompanyApplicantRow[]>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const search = (query.search ?? "").trim();

  /*
   * Per-job scoping, applied to the ROWS — and, because every count and stat
   * card on the Applicants page is derived from this same array client-side,
   * to those as well. That is why the filter lives here rather than at each
   * call site: there is one query, so there is one place to get it wrong.
   */
  const scope = await getJobScope(ctx);
  // An answer: assigned to no roles means no applicants to list.
  if (scope.scoped && scope.jobIds.length === 0) return answered([]);

  // Range-paged: job_applications has hit the PostgREST 1000-row cap before,
  // and an unbounded select silently truncates rather than erroring.
  const PAGE = 1000;
  const rows: ApplicantQueryRow[] = [];

  for (let from = 0; ; from += PAGE) {
    let q = service
      .from("job_applications")
      .select(APPLICANT_COLUMNS)
      .eq("company_id_snapshot", ctx.companyId);

    if (scope.scoped) q = q.in("job_id", scope.jobIds);
    // A client-supplied job filter narrows WITHIN the scope, never past it —
    // the .in() above still applies, so asking for an unassigned job returns
    // nothing rather than that job's applicants.
    if (query.jobId) q = q.eq("job_id", query.jobId);
    if (search) {
      const safe = sanitiseSearchTerm(search);
      q = q.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%`);
    }

    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) {
      /*
       * NOTE: fetchCompanyApplicants (PLURAL) — the list. Not
       * fetchCompanyApplicant (singular, the drawer detail) a few functions
       * below; they differ by one letter and sit in the same file.
       *
       * An empty list is a claim about their pipeline. A failed search that
       * returns [] renders `No applicants match "sarah"` and tells the reader
       * to try a different spelling — so the copy itself directs the retype,
       * and every retry fails identically.
       */
      console.error("[applicants] fetchCompanyApplicants failed:", error);
      return unavailable();
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
  return answered(rows.map((r) => toRow(r, scores.get(r.id))));
}

/**
 * One applicant plus their stage history, for the detail drawer. Same tenant
 * boundary as the list — a client-supplied id proves nothing about who owns
 * the row.
 */
export async function fetchCompanyApplicant(
  applicationId: string,
): Promise<Read<CompanyApplicantDetail | null>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data, error } = await service
    .from("job_applications")
    .select(APPLICANT_COLUMNS)
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  // `unavailable`, not null. Null is "no such applicant", and the drawer
  // renders that as an empty activity trail — an applicant with a week of
  // history looking like one who has done nothing.
  if (error) {
    console.error("[applicants] fetchCompanyApplicant failed:", error);
    return unavailable();
  }

  const row = data as unknown as ApplicantQueryRow | null;
  if (!row) return answered(null);

  // The drawer is a read of one applicant, so the list's .in() never ran.
  // Checked here against the job they applied to.
  if (!(await canAccessJob(ctx, row.job_id ?? ""))) return answered(null);

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
      `${SCORE_SUMMARY_COLUMNS}, verdict, dimension_scores, evidence, strengths, missing_requirements, must_haves, concerns, summary, screening_score, ai_model, scored_at, human_feedback, adjusted_by_name, adjusted_at, job_criteria_version`,
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  if (scoreErr) {
    console.error("[applicants] score detail query failed:", scoreErr);
  }

  const sRow = scoreData as (ScoreSummaryRow & Record<string, unknown>) | null;

  // Staleness: compare the criteria version stamped on the card against the
  // job's CURRENT one. Scoped by company like everything else — a job id alone
  // proves nothing, and this read must not become a way to probe another
  // tenant's jobs.
  //
  // The same read carries the job's CURRENT must-have count, which is what
  // tells an empty must_haves array on the card ("this job asks for none")
  // apart from a card written before the job named any. Same row, same scope,
  // no extra round-trip.
  let jobCriteriaVersion: number | null = null;
  let jobMustHaveCount = 0;
  if (row.job_id) {
    const { data: jobRow } = await service
      .from("jobs")
      .select("criteria_version, scoring_must_haves")
      .eq("id", row.job_id)
      .eq("company_id", ctx.companyId)
      .maybeSingle();
    const job = jobRow as {
      criteria_version?: number | null;
      scoring_must_haves?: unknown;
    } | null;
    jobCriteriaVersion = typeof job?.criteria_version === "number" ? job.criteria_version : null;
    jobMustHaveCount = Array.isArray(job?.scoring_must_haves) ? job.scoring_must_haves.length : 0;
  }
  // Both sides must be known before claiming staleness. A missing version on
  // either end means "we can't tell", and an unprovable warning beside a
  // money-costing button is worse than no warning.
  const scoredUnder = Number(sRow?.job_criteria_version ?? Number.NaN);
  const stale =
    Number.isFinite(scoredUnder) && jobCriteriaVersion !== null && scoredUnder < jobCriteriaVersion;
  const scoreDetail: ApplicantScoreDetail | null = sRow
    ? {
        ...toScore(sRow),
        verdict: resolveVerdict(sRow.verdict, sRow.evidence),
        dimensions: jsonArray(sRow.dimension_scores),
        evidence: evidenceItems(sRow.evidence),
        strengths: normaliseStrengths(sRow.strengths),
        missing_requirements: jsonArray(sRow.missing_requirements),
        must_haves: normaliseMustHaves(sRow.must_haves),
        job_must_have_count: jobMustHaveCount,
        concerns: jsonArray(sRow.concerns),
        summary: (sRow.summary as string | null) ?? null,
        screening_score: (sRow.screening_score as number | null) ?? null,
        ai_model: (sRow.ai_model as string | null) ?? null,
        scored_at: (sRow.scored_at as string | null) ?? null,
        stale,
        human_feedback: (sRow.human_feedback as string | null) ?? null,
        adjusted_by_name: (sRow.adjusted_by_name as string | null) ?? null,
        adjusted_at: (sRow.adjusted_at as string | null) ?? null,
      }
    : null;

  return answered({
    applicant: toRow(row, sRow ?? undefined),
    history: (histData ?? []) as StageHistoryRow[],
    scoreDetail,
    comments: await readComments(service, ctx.companyId, applicationId),
  });
}

// ── Mutations ────────────────────────────────────────────────

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

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
  const ctx = await requireCompanyRole("owner", "admin", "recruiter", "hiring_manager");

  // Validate against the union server-side — never trust a client string.
  if (!(PIPELINE_STAGES as readonly string[]).includes(toStage)) {
    return { success: false, error: "Invalid pipeline stage." };
  }

  const service = createServiceClient();

  // Re-fetch and verify ownership before writing. Not-found and not-yours
  // return the SAME message so a probe can't confirm another company's id.
  const { data: targetRow } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, pipeline_stage, job_id, first_name, last_name")
    .eq("id", applicationId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id_snapshot: string | null;
    pipeline_stage: string | null;
    job_id: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;

  if (!target || target.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: "Applicant not found in your workspace." };
  }
  if (!(await canAccessJob(ctx, target.job_id ?? ""))) {
    return { success: false, error: "Applicant not found in your workspace." };
  }

  const fromStage = (target.pipeline_stage as PipelineStage) ?? "applied";
  // No-op: don't write a history row for a stage that didn't change.
  if (fromStage === toStage) return { success: true, data: undefined };

  const applicantLabel =
    [target.first_name, target.last_name].filter(Boolean).join(" ").trim() || "An applicant";

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
  const { error: histErr } = await service.from("application_stage_history").insert({
    application_id: applicationId,
    company_id: ctx.companyId,
    from_stage: fromStage,
    to_stage: toStage,
    changed_by: ctx.user.id,
    changed_by_name: ctx.memberName,
    note: note?.trim() || null,
  });

  if (histErr) {
    console.error("[applicants] stage history insert failed for", applicationId, histErr);
  }

  // Candidate email. Same non-fatal contract as the audit row above: both
  // helpers swallow and log their own failures, because the stage move has
  // already committed and a messaging outage must not report it as failed.
  //
  // Moving OFF Rejected cancels a rejection that has not gone out yet — that
  // two-day window is the entire point of scheduling it rather than sending it
  // immediately. Done first so a rapid Rejected → Shortlisted → Rejected
  // sequence ends with the second rejection queued, not the first cancelled
  // after the second was written.
  // Fire-and-forget, exactly like the candidate-email triggers below it: the
  // stage has already committed, so a failed bell entry must not surface as a
  // rejected move.
  await notifyCompany({
    companyId: ctx.companyId,
    type: "stage_change",
    title: `${applicantLabel} moved to ${PIPELINE_STAGE_LABELS[toStage as PipelineStage]}`,
    body: `${ctx.memberName} moved them from ${PIPELINE_STAGE_LABELS[fromStage as PipelineStage]}.`,
    jobId: target.job_id,
    applicationId,
    actorMemberId: ctx.memberId,
  });

  if (toStage !== "rejected") {
    await cancelPendingRejection(applicationId, ctx.companyId);
  }
  await queueStageChange({
    applicationId,
    companyId: ctx.companyId,
    jobId: target.job_id,
    toStage,
  });

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

/**
 * Shared ownership check for the two score-adjustment actions.
 *
 * Verifies the application is the caller's AND that a score row already
 * exists. Not-found, not-yours and no-score-yet are three different failures
 * but the first two return the SAME message, so an id from another company
 * can't be confirmed by probing.
 */
async function assertAdjustableScore(
  service: ReturnType<typeof createServiceClient>,
  applicationId: string,
  ctx: CompanyContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const companyId = ctx.companyId;
  const { data } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, job_id")
    .eq("id", applicationId)
    .maybeSingle();

  const target = data as {
    company_id_snapshot: string | null;
    job_id: string | null;
  } | null;
  if (!target || target.company_id_snapshot !== companyId) {
    return { ok: false, error: "Applicant not found in your workspace." };
  }
  // Same message again: a scoped member probing another team's applicant id
  // learns nothing it didn't already know.
  if (!(await canAccessJob(ctx, target.job_id ?? ""))) {
    return { ok: false, error: "Applicant not found in your workspace." };
  }

  // Scoped by company_id too — the tenant boundary shouldn't rest on the
  // application lookup alone, same rule the stage history follows.
  const { data: scoreRow } = await service
    .from("application_scores")
    .select("application_id")
    .eq("application_id", applicationId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!scoreRow) {
    return {
      ok: false,
      error: "There's no AI score to correct yet. Score this CV first.",
    };
  }
  return { ok: true };
}

/**
 * Record a human's correction to an AI score.
 *
 * Open to hiring managers as well as the three senior roles: they review
 * candidates, so they are exactly the people who notice the model reading
 * someone wrong. Withholding it from them would throw away most of the signal.
 *
 * Writes ONLY the five override columns. overall_score and the scorecard jsonb
 * are left exactly as the model wrote them — the original has to survive for
 * the override to mean anything, and a re-score can still refresh the AI half
 * without disturbing this half (see writeScoreRow in lib/ai/cv-scoring.ts).
 */
export async function adjustScore(
  applicationId: string,
  score: number,
  feedback?: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter", "hiring_manager");

  // Validated server-side against a forged payload, not just by the input's
  // min/max. Integer, because a fractional human judgement is false precision.
  if (!Number.isFinite(score) || !Number.isInteger(score) || score < 0 || score > 100) {
    return { success: false, error: "Score must be a whole number from 0 to 100." };
  }

  const service = createServiceClient();
  const allowed = await assertAdjustableScore(service, applicationId, ctx);
  if (!allowed.ok) return { success: false, error: allowed.error };

  const note = (feedback ?? "").trim().slice(0, SCORE_FEEDBACK_MAX);

  const { error } = await service
    .from("application_scores")
    .update({
      human_adjusted_score: score,
      human_feedback: note || null,
      adjusted_by: ctx.user.id,
      // Cached, not looked up later: this is audit history and must keep
      // saying who made the call even after they leave the company.
      adjusted_by_name: ctx.memberName,
      adjusted_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

/**
 * Drop a correction and fall back to the model's own score.
 *
 * Nulls all five columns together — a half-cleared row (a score with no author,
 * or an author with no score) would read as corrupt in the calibration set.
 */
export async function clearScoreAdjustment(
  applicationId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter", "hiring_manager");

  const service = createServiceClient();
  const allowed = await assertAdjustableScore(service, applicationId, ctx);
  if (!allowed.ok) return { success: false, error: allowed.error };

  const { error } = await service
    .from("application_scores")
    .update({
      human_adjusted_score: null,
      human_feedback: null,
      adjusted_by: null,
      adjusted_by_name: null,
      adjusted_at: null,
    })
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

/**
 * Dismiss an auto-shortlist flag: mark it seen, not permanently silenced.
 *
 * ── What this does and does not decide ───────────────────────
 *
 * It clears the flag and records WHAT was turned down — the source and score
 * parsed out of the stored reason — so a later flag can tell whether it is
 * telling the recruiter something new. A dismissed CV flag never suppresses a
 * subsequent interview flag, and the same source re-surfaces only on a
 * materially higher score. The policy lives in lib/interviews/shortlist.ts;
 * this action is the guarded entry point to it.
 *
 * It does NOT touch pipeline_stage, the score, or anything the candidate sees.
 * Dismissing is "I have looked at this", not a hiring decision.
 *
 * ── Scoping ──────────────────────────────────────────────────
 *
 * Same gate as every other applicant mutation: a company role, then the
 * application re-fetched server-side and checked against the caller's company
 * AND the hiring team for its job. The id from the client proves nothing.
 * hiring_manager is included because dismissing a suggestion is exactly the
 * kind of triage that role exists to do.
 */
export async function dismissShortlistFlagAction(
  applicationId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter", "hiring_manager");

  const service = createServiceClient();

  const { data } = await service
    .from("job_applications")
    .select("id, job_id")
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  const target = data as { id: string; job_id: string | null } | null;
  // Missing and not-yours are deliberately the same message.
  if (!target || !(await canAccessJob(ctx, target.job_id ?? ""))) {
    return { success: false, error: "Applicant not found in your workspace." };
  }

  const outcome = await dismissShortlistFlag({
    applicationId,
    companyId: ctx.companyId,
  });
  if (!outcome.ok) return { success: false, error: outcome.error };

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
  if (!(await canAccessJob(ctx, target.job_id ?? ""))) {
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
export async function rescoreJob(jobId: string): Promise<MutationResult<{ queued: number }>> {
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
  if (!(await canAccessJob(ctx, jobId))) {
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

/**
 * Permanently delete one application.
 *
 * HARD delete, not soft, for three reasons:
 *
 *  1. Privacy is the usual motive. A company removing an applicant is most
 *     often acting on a deletion request or clearing a spam/test submission.
 *     A soft delete keeps the name, email, phone, cv_text and the CV file
 *     itself — i.e. it keeps exactly what the request asked to remove.
 *  2. A `deleted_at` column does not exist, and adding one is a migration.
 *  3. application_scores and application_stage_history are FK'd to
 *     application_id and cascade. That is correct: a scorecard about a deleted
 *     candidate is just their PII in another table.
 *
 * The cost is the audit trail — after this, nothing records that the applicant
 * existed. If that becomes a requirement, the right shape is a separate
 * deleted_applications table holding non-PII only (application id, job id,
 * deleted_by, deleted_at), NOT a flag on a row that still carries the person's
 * details.
 *
 * ORDER: storage object first, then the row. Deliberate — this order is
 * retry-safe. If the row delete fails, cv_path is still on the row so the
 * operation can simply be repeated (removing an already-gone object is a
 * no-op). Row-first would leave the PDF — the single largest piece of PII —
 * orphaned in the bucket with no record of its path outside the logs.
 */
export async function deleteApplication(applicationId: string): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");
  const service = createServiceClient();

  // Ownership recheck. Not-found and not-yours return the SAME message so a
  // probe can't confirm another company's id exists.
  const { data } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, cv_path, job_id, first_name, last_name")
    .eq("id", applicationId)
    .maybeSingle();

  const target = data as {
    id: string;
    company_id_snapshot: string | null;
    cv_path: string | null;
    job_id: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;

  if (!target || target.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: "Applicant not found in your workspace." };
  }
  if (!(await canAccessJob(ctx, target.job_id ?? ""))) {
    return { success: false, error: "Applicant not found in your workspace." };
  }

  // 1. The CV file. Best-effort: a storage failure must not block the row
  //    delete, but it IS logged with the grep tag the apply route uses so an
  //    orphaned object can be found and cleaned up.
  if (target.cv_path) {
    try {
      const { error: storageErr } = await service.storage.from(CV_BUCKET).remove([target.cv_path]);
      if (storageErr) {
        console.error("[CV_ORPHAN][applicants] CV delete failed", {
          applicationId,
          path: target.cv_path,
          error: storageErr.message,
        });
      }
    } catch (err) {
      console.error("[CV_ORPHAN][applicants] CV delete threw", {
        applicationId,
        path: target.cv_path,
        error: err,
      });
    }
  }

  // 2. The row. Scoped again on company_id_snapshot so the DELETE itself
  //    cannot touch another tenant even if the check above were bypassed.
  const { error: delErr } = await service
    .from("job_applications")
    .delete()
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  if (delErr) return { success: false, error: delErr.message };

  await notifyCompany({
    companyId: ctx.companyId,
    type: "applicant_deleted",
    title: `${[target.first_name, target.last_name].filter(Boolean).join(" ").trim() || "An applicant"} was deleted`,
    body: `${ctx.memberName} permanently removed them and their CV.`,
    jobId: target.job_id,
    // No application_id: the row it pointed at no longer exists, and a link to
    // a deleted applicant is a dead end. Without one, notifyCompany routes this
    // to the bare list rather than to a candidate who isn't there.
    actorMemberId: ctx.memberId,
  });

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

// ── Team comments ────────────────────────────────────────────
//
// The hiring team's thread on an applicant. Not application_comments, which is
// Remotiv's own internal note table keyed on admin_id — the two audiences must
// never cross, and nothing in this file reads that one.
//
// Every action re-gates through gateApplication, so a comment is readable and
// writable by exactly the people who can open the applicant: same company
// snapshot, same per-job hiring-team check. A recruiter who is not on the job
// cannot see the applicant and cannot see the thread.
//
// Every role may write. The precedent is stage changes and score adjustments,
// which hiring managers already make; a comments tab they could read but not
// answer would push the conversation into Slack, where it stops being part of
// the record.

const COMMENT_COLUMNS =
  "id, parent_id, author_member_id, author_name, body, deleted_at, created_at, updated_at";

type CommentQueryRow = {
  id: string;
  parent_id: string | null;
  author_member_id: string | null;
  author_name: string | null;
  body: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type CommentsResult = { ok: true; comments: ApplicantComment[] } | { ok: false; error: string };

/** Same text for not-found and not-yours, so a probe can't confirm an id. */
const NO_COMMENT = "That comment is no longer there.";

/**
 * Oldest-first, flat. The pane nests roots and replies; doing it here would
 * mean two shapes of the same data, since every mutation returns this list.
 *
 * Scoped by company_id as well as application_id for the same reason the stage
 * history is — the tenant boundary shouldn't rest on the id lookup alone.
 */
async function readComments(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  applicationId: string,
): Promise<ApplicantComment[]> {
  const { data, error } = await service
    .from("application_team_comments")
    .select(COMMENT_COLUMNS)
    .eq("application_id", applicationId)
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[applicants] comment read failed:", error.message);
    return [];
  }

  return ((data ?? []) as unknown as CommentQueryRow[]).map((c) => ({
    id: c.id,
    parentId: c.parent_id,
    authorMemberId: c.author_member_id,
    authorName: c.author_name ?? "Someone",
    body: c.body,
    deletedAt: c.deleted_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }));
}

/**
 * The panel's chain, reused verbatim for every comment mutation: the company
 * snapshot then the job. Returns the same not-found message on both failures.
 */
async function gateApplication(
  applicationId: string,
): Promise<{ ok: true; ctx: CompanyContext } | { ok: false; error: string }> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("job_applications")
    .select("id, job_id")
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  const row = data as { id: string; job_id: string | null } | null;
  if (!row) return { ok: false, error: "Applicant not found in your workspace." };
  if (!(await canAccessJob(ctx, row.job_id ?? ""))) {
    return { ok: false, error: "Applicant not found in your workspace." };
  }
  return { ok: true, ctx };
}

/** How many replies hang off a comment. Decides edit-lock and delete shape. */
async function replyCount(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  commentId: string,
): Promise<number> {
  const { count } = await service
    .from("application_team_comments")
    .select("id", { count: "exact", head: true })
    .eq("parent_id", commentId)
    .eq("company_id", companyId);
  return count ?? 0;
}

/**
 * Post a comment, or a reply to one.
 *
 * `parentId` is validated against this application rather than trusted: an id
 * from another applicant's thread would otherwise graft a reply across
 * candidates. Depth is not sent by the caller at all — it is derived here, and
 * the database rejects anything that disagrees (migration 023).
 */
export async function addApplicationComment(
  applicationId: string,
  body: string,
  parentId?: string | null,
): Promise<CommentsResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "Write something first." };
  if (trimmed.length > COMMENT_MAX) {
    return { ok: false, error: `Comments are limited to ${COMMENT_MAX} characters.` };
  }

  const gate = await gateApplication(applicationId);
  if (!gate.ok) return gate;
  const { ctx } = gate;
  const service = createServiceClient();

  // A reply's parent must be a root on THIS application. The database enforces
  // the one-level rule; this enforces that the thread belongs here.
  if (parentId) {
    const { data: parent } = await service
      .from("application_team_comments")
      .select("id, parent_id")
      .eq("id", parentId)
      .eq("application_id", applicationId)
      .eq("company_id", ctx.companyId)
      .maybeSingle();

    const p = parent as { id: string; parent_id: string | null } | null;
    if (!p) return { ok: false, error: NO_COMMENT };
    if (p.parent_id !== null) {
      return { ok: false, error: "You can only reply to a top-level comment." };
    }
  }

  const { error } = await service.from("application_team_comments").insert({
    application_id: applicationId,
    company_id: ctx.companyId,
    parent_id: parentId ?? null,
    depth: parentId ? 1 : 0,
    author_member_id: ctx.memberId,
    author_name: ctx.memberName,
    body: trimmed,
  });

  if (error) {
    console.error("[applicants] comment insert failed:", error.message);
    return { ok: false, error: "Couldn't save that comment. Please try again." };
  }

  return { ok: true, comments: await readComments(service, ctx.companyId, applicationId) };
}

/**
 * Edit your OWN comment, while it has no replies.
 *
 * The author predicate is on the UPDATE itself rather than a read-then-write:
 * two statements would leave a window where the row changed hands between the
 * check and the write. Someone else's comment simply matches no row.
 *
 * The reply-lock above it IS a read-then-write, deliberately — it is a product
 * rule, not a tenant boundary. The worst a race loses is an edit landing in the
 * same instant as the first reply. Editing words a colleague has already
 * answered is what the rule exists to prevent, and that is unaffected.
 */
export async function updateApplicationComment(
  applicationId: string,
  commentId: string,
  body: string,
): Promise<CommentsResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "A comment can't be empty." };
  if (trimmed.length > COMMENT_MAX) {
    return { ok: false, error: `Comments are limited to ${COMMENT_MAX} characters.` };
  }

  const gate = await gateApplication(applicationId);
  if (!gate.ok) return gate;
  const { ctx } = gate;
  const service = createServiceClient();

  if ((await replyCount(service, ctx.companyId, commentId)) > 0) {
    return { ok: false, error: "This comment has replies, so it can no longer be edited." };
  }

  const { data, error } = await service
    .from("application_team_comments")
    .update({ body: trimmed, updated_at: new Date().toISOString() })
    .eq("id", commentId)
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    // Own comments only. Editing a colleague's words would make the attribution
    // beneath them a lie.
    .eq("author_member_id", ctx.memberId)
    // A tombstone has no words to edit, and this stops an edit resurrecting one.
    .is("deleted_at", null)
    .select("id");

  if (error) {
    console.error("[applicants] comment update failed:", error.message);
    return { ok: false, error: "Couldn't save that edit. Please try again." };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "You can only edit your own comments." };
  }

  return { ok: true, comments: await readComments(service, ctx.companyId, applicationId) };
}

/**
 * Delete a comment. Yours always; anyone's if you own or administer the
 * company.
 *
 * That second case is not symmetry for its own sake. These are written opinions
 * about a named person, and a company needs a way to remove a remark that
 * should never have been made without going to a database console.
 *
 * A leaf is deleted outright. A comment with replies is tombstoned instead: the
 * row survives so the replies still have a parent, and the words do not. That
 * is the shape deleteApplication argues for a few functions above — never a
 * flag on a row that still carries what the deletion was meant to remove.
 */
export async function deleteApplicationComment(
  applicationId: string,
  commentId: string,
): Promise<CommentsResult> {
  const gate = await gateApplication(applicationId);
  if (!gate.ok) return gate;
  const { ctx } = gate;
  const service = createServiceClient();

  const moderator = ctx.role === "owner" || ctx.role === "admin";
  const hasReplies = (await replyCount(service, ctx.companyId, commentId)) > 0;

  /**
   * The scoping predicates, applied to whichever statement runs. Both branches
   * narrow identically so they cannot drift; a moderator dropping the author
   * predicate is the ONLY difference between them, and it is visible here
   * rather than duplicated across two query chains.
   */
  const scoped = <T extends { eq(column: string, value: string): T }>(q: T): T => {
    const s = q
      .eq("id", commentId)
      .eq("application_id", applicationId)
      .eq("company_id", ctx.companyId);
    return moderator ? s : s.eq("author_member_id", ctx.memberId);
  };

  const table = () => service.from("application_team_comments");

  const { data, error } = hasReplies
    ? await scoped(table().update({ body: null, deleted_at: new Date().toISOString() }))
        .is("deleted_at", null)
        .select("id")
    : await scoped(table().delete()).select("id");

  if (error) {
    console.error("[applicants] comment delete failed:", error.message);
    return { ok: false, error: "Couldn't delete that comment. Please try again." };
  }
  if ((data ?? []).length === 0) {
    return {
      ok: false,
      error: moderator ? NO_COMMENT : "You can only delete your own comments.",
    };
  }

  return { ok: true, comments: await readComments(service, ctx.companyId, applicationId) };
}
