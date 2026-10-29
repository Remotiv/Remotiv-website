"use server";

import { revalidatePath } from "next/cache";
import { CSV_EXPORT_MAX } from "@/app/ai-dashboard/(gated)/applicants/csv-export";
import { actionFailed, actionIncomplete, queueFailed } from "@/app/ai-dashboard/lib/action-errors";
import {
  type AddApplicantDuplicate,
  APPLICANT_PAGE_SIZE,
  type ApplicantComment,
  type ApplicantCounts,
  type ApplicantScore,
  type ApplicantScoreDetail,
  type ApplicantScoringFacts,
  type AssignableJob,
  COMMENT_MAX,
  type CompanyApplicantDetail,
  type CompanyApplicantPage,
  type CompanyApplicantQuery,
  type CompanyApplicantRow,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineStage,
  SCORE_FEEDBACK_MAX,
  type ScoreConfidence,
  type ScoreEvidenceRow,
  type ScoreMustHaveRow,
  type ScoreQueueState,
  type ScoreStatus,
  type ScoreStrengthRow,
  type StageHistoryRow,
  TOP_SCORED_LIMIT,
  WORTH_A_LOOK_STAGES,
} from "@/app/ai-dashboard/lib/applicant-types";
import { getCompanyContext, requireCompanyRole } from "@/app/ai-dashboard/lib/company-guards";
import { type CompanyContext, canChangeStage } from "@/app/ai-dashboard/lib/company-roles";
import {
  canAccessJob,
  getJobScope,
  type JobScope,
  readJobScope,
} from "@/app/ai-dashboard/lib/job-scope";
import { searchTokens } from "@/app/ai-dashboard/lib/search-query";
import { requestCvScore } from "@/lib/ai/cv-score-request";
import { MIN_CV_TEXT_CHARS } from "@/lib/ai/cv-scoring";
import { collectJobApplicationIds, collectScoredApplicationIds } from "@/lib/ai/rescore-collect";
import { removeApplicationFiles } from "@/lib/application-files";
import {
  RESCORE_NO_ALLOWANCE_MESSAGE,
  readCvCapacity,
  scoresToQueue,
  unscoredFirst,
} from "@/lib/cv-allowance";
import { capCvText, checkCvFile, cvRetentionDate } from "@/lib/cv-file";
import { cancelPendingRejection, queueStageChange } from "@/lib/email/candidate/triggers";
import { deleteApplicationInterviews } from "@/lib/interviews/application-deletion";
import { dismissShortlistFlag } from "@/lib/interviews/shortlist";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { normalizeEmail } from "@/lib/normalize";
import { notifyCompany } from "@/lib/notifications/company";
import { extractPdfTextServer, type PdfTextResult, stripInvalidPgChars } from "@/lib/pdf-text";
import { findSharedPaths } from "@/lib/shared-storage-refs";
import { removeObjects } from "@/lib/storage-objects";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidEmail } from "@/lib/validators";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Row/query types live in lib/applicant-types.ts.

/** Matches the bucket the apply route and the CV route both use. */
const CV_BUCKET = "cvs";

/**
 * `cv_path` is deliberately absent from what we return, but IS selected so we
 * can derive `has_cv`. `cv_url` is the legacy public-URL column kept for rows
 * that predate the private bucket. `cv_delete_after` is selected for the same
 * reason — it is what separates an expired CV from one never supplied.
 *
 * `screening_answers` is NOT here. It is a jsonb that measured 63.5% of this
 * projection's bytes and is read by the drawer and the CSV only, so it is
 * selected by APPLICANT_DETAIL_COLUMNS instead. The rule this restores is the
 * one already written over the scorecard read below: the jsonb columns are
 * drawer-only, never in the list.
 */
const APPLICANT_LIST_COLUMNS =
  "id, first_name, last_name, email, phone, linkedin_url, job_id, job_title_snapshot, city, country, years_experience, notice_period, availability, created_at, pipeline_stage, source, cv_path, cv_url, cv_delete_after, shortlist_flagged_at, shortlist_flag_reason, jobs(title)";

/**
 * The list's columns plus the drawer's jsonb. Derived by concatenation rather
 * than written out again: two hand-maintained lists drift the first time a
 * column is added to one of them, and the drift is invisible because both
 * queries still succeed.
 */
const APPLICANT_DETAIL_COLUMNS = `${APPLICANT_LIST_COLUMNS}, screening_answers`;

type ApplicantQueryRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  city: string | null;
  country: string | null;
  years_experience: number | null;
  notice_period: string | null;
  availability: string | null;
  created_at: string | null;
  pipeline_stage: string | null;
  source: string | null;
  cv_path: string | null;
  cv_url: string | null;
  cv_delete_after: string | null;
  shortlist_flagged_at: string | null;
  shortlist_flag_reason: string | null;
  jobs: { title: string | null } | null;
};

/** What APPLICANT_DETAIL_COLUMNS returns: the list row plus the drawer's jsonb. */
type ApplicantDetailQueryRow = ApplicantQueryRow & { screening_answers: unknown };

/**
 * A stored screening_answers jsonb, shaped.
 *
 * A non-array — a missing key, or a row written before the column existed —
 * reads as "no questions", which is the same value a job that asked none
 * stores. Both mean nothing to show.
 */
function toScreeningAnswers(v: unknown): ScreeningAnswerSnapshot[] {
  return Array.isArray(v) ? (v as ScreeningAnswerSnapshot[]) : [];
}

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
  effective_score: number | null;
};

/**
 * The score fields as an EMBED on job_applications, rather than a second query
 * joined in JavaScript.
 *
 * `effective_score` is in the list because PostgREST will only order a parent by
 * an embedded column if that column is in the embed's own select list — leaving
 * it out answers 42703 rather than quietly ordering by something else.
 *
 * Concatenated from SCORE_SUMMARY_COLUMNS for the reason APPLICANT_DETAIL_COLUMNS
 * is: two hand-maintained field lists drift the first time a column is added to
 * one of them, and the drift is invisible because both queries still succeed.
 */
const SCORE_EMBED_FIELDS = `${SCORE_SUMMARY_COLUMNS}, effective_score`;

/**
 * The list's projection.
 *
 * The embed is `!left` and must stay `!left`. `!inner` returns only applications
 * that have a score row — measured at 146 of 3,788 in production — so it would
 * hide 96.1% of applicants from the view the page opens on. Nothing in the
 * scanner catches that substitution; the unscored-visibility test is the guard.
 */
const APPLICANT_LIST_SELECT = `${APPLICANT_LIST_COLUMNS}, application_scores!left(${SCORE_EMBED_FIELDS})`;

/**
 * "Review top 10" and the top-match chips, which are claims about the score and
 * so may only contain scored candidates.
 *
 * `!inner` is deliberate HERE, and it is what restricts the result to
 * applications that have a score row at all. It is NOT sufficient on its own: it
 * says nothing about whether that row holds a number, and a skipped or failed
 * card is a row. The caller adds `effective_score IS NOT NULL`, which restricts
 * the parent precisely because this join is INNER rather than LEFT.
 */
const TOP_SCORED_SELECT = `${APPLICANT_LIST_COLUMNS}, application_scores!inner(${SCORE_EMBED_FIELDS})`;

/** An applicant with no score row at all reads as pending, not as an error. */
const NO_SCORE: ApplicantScore = {
  status: "pending",
  ai_status: "pending",
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
 *
 * ── `overall` here and `effective_score` in the database are one rule ───────
 *
 * The list is ORDERED by application_scores.effective_score and DISPLAYS this
 * `overall`. They must agree on every row or the page is ranked by a number it
 * does not show. Both are
 *
 *   status = 'scored' OR human_adjusted_score IS NOT NULL
 *     ? (human_adjusted ?? overall)
 *     : null
 *
 * one in SQL and one here. The second disjunct is what makes a recruiter's
 * correction to a CV the model SKIPPED rank where it displays: gating on
 * `status` alone would show their number and sort the row last, which is the
 * original defect inverted. The first disjunct is what keeps a FAILED re-score
 * from ranking on the stale overall_score it still carries. See test category 8.
 *
 * `!= null` and not a truthiness test: an adjustment to 0 is a real judgement —
 * "I looked, and no" — and must rank at the bottom rather than read as absent.
 *
 * A LEFT embed with no match arrives as `null`, which is the same absence as the
 * `undefined` the old JavaScript join produced for a missing map entry.
 */
function toScore(r: ScoreSummaryRow | null | undefined): ApplicantScore {
  if (!r) return NO_SCORE;
  const aiStatus = (r.status ?? "pending") as ScoreStatus;
  const adjusted = r.human_adjusted_score != null;
  const status: ScoreStatus = adjusted ? "scored" : aiStatus;
  const overall = status === "scored" ? (r.human_adjusted_score ?? r.overall_score) : null;
  return {
    status,
    ai_status: aiStatus,
    overall,
    // The model's number travels alongside the override rather than being
    // replaced by it — the UI shows both, and the difference IS the signal.
    // On the AI's OWN status: a failed attempt's leftover number is not a
    // comparison, it is a number nobody is standing behind.
    ai_overall: aiStatus === "scored" ? r.overall_score : null,
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
    /*
     * ── 'manual_upload' means more than one thing ──────────────
     *
     * The badge this feeds says "Added by team", and for a row created by the
     * applicants panel that is exactly true. But `source` does not only mark
     * those. Remotiv's own admin uploads and the bulk candidate imports carry
     * 'manual_upload' as well, and for an imported row "your team added this
     * person" is false — Remotiv did, in bulk, from a spreadsheet.
     *
     * This is harmless TODAY and only because of an unrelated fact: the
     * importer writes no company_id_snapshot, and every read here filters on
     * it, so imported rows never reach this mapper. The badge is correct by
     * accident of another bug, not by construction.
     *
     * So: if imported rows are ever backfilled with a company — which is the
     * obvious fix for their invisibility — they become visible AND acquire a
     * badge claiming the company's own team added them. Backfilling the
     * snapshot without settling this is the thing to watch. The durable fix is
     * a column recording WHO added the row; `source` cannot answer it, because
     * it describes the mechanism and three different actors share it.
     */
    added_manually: r.source === "manual_upload",
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
  /*
   * readJobScope, not getJobScope. getJobScope collapses an unreadable
   * hiring-team row into the empty scope, which the line below would then turn
   * into `answered(0)` — a confident zero produced by a read that FAILED, and
   * the badge would show it with nothing anywhere indicating a problem. The
   * empty list still returns 0, because that one is a true answer.
   */
  const scopeRead = await readJobScope(ctx);
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;
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
  const flagged = countOf(count);
  if (flagged === null) {
    console.error("[applicants] countFlaggedApplicants: no count on a successful response");
    return unavailable();
  }
  return answered(flagged);
}

/**
 * A count header, or null when the response did not carry one.
 *
 * `count ?? 0` was wrong, and not in a theoretical way. postgrest-js derives
 * the count from the `content-range` response header and only when the request
 * carried a matching `Prefer: count=` — see postgrest-js
 * `processResponse`, which initialises `count = null` and assigns it ONLY if
 * both are present:
 *
 *     if (countHeader && contentRange && contentRange.length > 1)
 *       count = parseInt(contentRange[1]);
 *
 * `error` is set only on a non-2xx. So a 200 whose `content-range` was stripped
 * or rewritten — by a proxy, a gateway, a CDN — yields `count: null` with
 * `error: null`, and `?? 0` published that as a hard zero over a company with
 * two thousand applicants. Nothing on the page would have looked broken.
 *
 * `parseInt` is the second half: PostgREST answers `*\/*` when it cannot supply
 * a total, and `parseInt("*")` is NaN, not a number. NaN would reach the
 * surface and render the literal string "NaN", so it is folded in here rather
 * than guarded at the one call site that happens to format.
 *
 * A real 0 is a real answer and passes through untouched.
 */
function countOf(count: number | null | undefined): number | null {
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/** Seven days, the window the "+N this week" chip has always described. */
const COUNT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every population figure the Applicants page states, counted in the database.
 *
 * ── What this replaces, and why it is not an optimisation ────
 *
 * The page loaded every applicant and took `.length` of client-side filtered
 * arrays. That is exact while the array IS the population and silently wrong
 * the moment it is a page of it. This adds round trips and makes the page no
 * faster; its job is to make the numbers true over the whole population.
 *
 * ── Ten queries, fixed, parallel ────────────────────────────
 *
 * Seven per-stage counts, "new this week", "open roles", and the unfiltered
 * grand total. The number of requests is a function of
 * `PIPELINE_STAGES.length` — it does not grow with the applicant count, and
 * nothing here is per-row or per-job, so the `Promise.all` is bounded by
 * construction and needs no limiter.
 *
 * Every one is `count: "exact", head: true`: the number arrives in
 * Content-Range and not one row is transferred.
 *
 * ── The funnel total is a SUM, not another query ────────────
 *
 * `pipeline_stage` is NOT NULL with a CHECK constraint over exactly these
 * seven values, so the seven counts partition the filtered population and
 * their sum is the total. Verified against production: the seven sum to the
 * table's own row count exactly.
 *
 * `grandTotal` is a separate read and not a contradiction of that: it is a
 * different number, counted without the job filter, so it cannot be a sum of
 * these seven. See ApplicantCounts.grandTotal.
 *
 * That matters because the funnel prints "% of total". A separately fetched
 * total would be read at a different moment from the stage it is divided by,
 * so an application inserted between the two responses makes the page print
 * 101%. Deriving it removes the skew rather than tolerating it: the parts and
 * the whole now come from one set of responses and always agree.
 *
 * If ANY stage is unavailable the total is unavailable too — never a partial
 * sum, which would be a plausible number quietly short by one stage's worth of
 * people. The visible consequence is intended: six stage cells showing numbers
 * above a dashed total and dashed percentages. That is a page reporting what
 * it knows and what it does not, not a half-rendered one.
 *
 * ── Scope ───────────────────────────────────────────────────
 *
 * `readJobScope` is resolved ONCE and the resolved value reused by all ten,
 * so a batch cannot be built from two different answers to the same permission
 * question and the hiring-team row is read once rather than ten times. An
 * unreadable scope short-circuits before any query is issued — see
 * countFlaggedApplicants for why that is not `0`.
 *
 * Each query carries the company filter in its OWN builder chain. The open
 * roles count is the one read here that is not on job_applications, and it
 * carries BOTH `jobs.company_id` and `job_applications.company_id_snapshot`
 * across the `!inner` join — the embed is what makes it a count of parent
 * rows, and the snapshot filter is what makes it a tenant boundary rather than
 * a filter on a LEFT join.
 */
export async function fetchApplicantCounts(
  query: CompanyApplicantQuery = {},
): Promise<Read<ApplicantCounts>> {
  const ctx = await getCompanyContext();
  const scopeRead = await readJobScope(ctx);
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;

  // An answer, and the discriminating case for every "unavailable is not zero"
  // test here: assigned to no roles means there is genuinely nobody, so every
  // figure is a true 0 rather than an unknown.
  if (scope.scoped && scope.jobIds.length === 0) {
    return answered({
      stages: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0])) as Record<
        PipelineStage,
        number
      >,
      total: 0,
      newThisWeek: 0,
      openRoles: 0,
      grandTotal: 0,
    });
  }

  const service = createServiceClient();

  /**
   * The two scope layers every count below shares, applied per chain.
   *
   * Scope only — never the tab, the flag or the search term. Those are the
   * list's filters; these counts describe the population the list is drawn
   * FROM, which is what makes "12 of 300" a meaningful sentence.
   */
  const scoped = () => {
    let q = service
      .from("job_applications")
      .select("id", { count: "exact", head: true })
      .eq("company_id_snapshot", ctx.companyId);
    if (scope.scoped) q = q.in("job_id", scope.jobIds);
    return q;
  };

  /** Scope plus the job filter — what the stage counts and the funnel describe. */
  const applications = () => {
    const q = scoped();
    // Narrows WITHIN the scope, never past it: the .in() above still applies,
    // so asking for an unassigned job counts nothing rather than its rows.
    return query.jobId ? q.eq("job_id", query.jobId) : q;
  };

  const since = new Date(Date.now() - COUNT_WEEK_MS).toISOString();

  const openRolesQuery = () => {
    let q = service
      .from("jobs")
      /*
       * `job_applications!inner(id)` counts PARENT rows that have at least one
       * application — PostgREST has no DISTINCT, and this is the shape that
       * answers "how many roles have someone in them" without one.
       *
       * No `deleted_at` filter, deliberately. It preserves today's figure
       * exactly: the number came from the distinct job_ids on the loaded
       * applications, which includes a job since deleted as long as the
       * application still points at it. `status` and `archived_at` are ignored
       * for the same reason. Whether this should mean live roles only is a
       * product decision, not this change — and measured against production
       * today both readings give the same number.
       */
      .select("id, job_applications!inner(id)", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      // The tenant boundary. `jobs.company_id` above is the parent's own
      // filter; this one restricts the joined child, and it is on the snapshot
      // rather than a second company_id for the same reason the list is.
      .eq("job_applications.company_id_snapshot", ctx.companyId);
    if (scope.scoped) q = q.in("id", scope.jobIds);
    if (query.jobId) q = q.eq("id", query.jobId);
    return q;
  };

  /**
   * One head-count, resolved to a number or to null. It cannot reject.
   *
   * The containment is the point. These ten were a `Promise.all` holding a
   * `Promise.all`, so a single rejection rejected the inner array, which
   * rejected the outer, which threw out of this action — ten figures lost to
   * one, and the nine that answered fine discarded with them. Catching per
   * count means the level above is a `Promise.all` over promises that cannot
   * reject, which is itself a promise that cannot reject, at both levels.
   *
   * How likely is a rejection? Rarer than it sounds, and in this client's
   * configuration I could not find a reachable path. supabase-js answers
   * `{ data, error }` rather than throwing, and postgrest-js goes further: with
   * `shouldThrowOnError` false — which is the shipped config, since
   * createServiceClient passes no custom fetch and never calls `.throwOnError()`
   * — it attaches its own `res.catch` and converts fetch failure, DNS failure,
   * an AbortError and a malformed JSON body into ordinary
   * `{ error, count: null, status: 0 }` results. So this catch guards against a
   * future `.throwOnError()`, a client-level option or a fetch wrapper, not
   * against something that happens today. The live failure mode is the one
   * below it: a 200 that carries no count.
   */
  const countOnce = async (
    label: string,
    build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  ): Promise<number | null> => {
    try {
      const { count, error } = await build();
      if (error) {
        console.error(`[applicants] count ${label} failed:`, error.message);
        return null;
      }
      const n = countOf(count);
      if (n === null) {
        console.error(`[applicants] count ${label}: no count on a successful response`);
      }
      return n;
    } catch (cause) {
      console.error(
        `[applicants] count ${label} threw:`,
        cause instanceof Error ? cause.message : cause,
      );
      return null;
    }
  };

  // All ten are issued before the first await: countOnce runs synchronously
  // into `build()`, so wrapping them costs no round trip.
  const [stageResults, weekCount, rolesCount, grandTotal] = await Promise.all([
    Promise.all(
      PIPELINE_STAGES.map((stage) =>
        countOnce(`stage ${stage}`, () => applications().eq("pipeline_stage", stage)),
      ),
    ),
    countOnce("new this week", () => applications().gte("created_at", since)),
    countOnce("open roles", () => openRolesQuery()),
    // `scoped()`, not `applications()` — this one deliberately ignores the job
    // filter. See ApplicantCounts.grandTotal.
    countOnce("grand total", () => scoped()),
  ]);

  const stages = Object.fromEntries(
    PIPELINE_STAGES.map((stage, i) => [stage, stageResults[i]]),
  ) as Record<PipelineStage, number | null>;

  const stageValues = PIPELINE_STAGES.map((s) => stages[s]);
  const total = stageValues.some((n) => n === null)
    ? null
    : stageValues.reduce((a, b) => (a ?? 0) + (b ?? 0), 0);

  return answered({
    stages,
    total,
    newThisWeek: weekCount,
    openRoles: rolesCount,
    grandTotal,
  });
}

/**
 * A list row with its embedded score. To-ONE, so an object or null — never an
 * array.
 *
 * Measured against production rather than read off the dump: `application_id`
 * carries a UNIQUE constraint, so PostgREST resolves the embed as to-one and a
 * row with no score answers `null`. A to-many embed would answer `[]`, and the
 * two need different mapping, so the shape was probed both ways — unscored rows
 * returned `null`, scored rows returned an object.
 */
type ApplicantListQueryRow = ApplicantQueryRow & {
  application_scores: ScoreSummaryRow | null;
};

/**
 * One read of `job_applications` carrying company scope, job scope and every
 * page filter — all on the PARENT.
 *
 * ── Why the select string is a parameter ─────────────────────
 *
 * Because there are two of these reads, the list and "Review top 10", and they
 * differ ONLY in their projection — the list embeds scores `!left`, the top
 * query `!inner`. Their filters have to be identical: "Review top 10" is a
 * claim about the list the reader is looking at, so a filter the list applies
 * and the top query does not would make the chip name someone the page is not
 * showing. Sharing the chain is what makes that true by construction instead of
 * by two developers remembering.
 *
 * ── Why the filters are on the parent ───────────────────────
 *
 * That placement is the tenant boundary, not a style choice. Across a LEFT
 * embed a filter on an embedded column does not restrict the parent at all, so
 * company scope on `application_scores.company_id` would read as scoping while
 * returning every company's rows. It stays on `company_id_snapshot`, which also
 * survives job deletion — `job_id` is ON DELETE SET NULL, so a scope joined
 * through `jobs.company_id` would silently drop those applicants.
 */
function listQuery(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  scope: JobScope,
  query: CompanyApplicantQuery,
  select: string,
  options: { count?: "exact"; head?: boolean } = {},
) {
  let out = service
    .from("job_applications")
    .select(select, options)
    .eq("company_id_snapshot", companyId);

  if (scope.scoped) out = out.in("job_id", scope.jobIds);
  // A client-supplied job filter narrows WITHIN the scope, never past it — the
  // .in() above still applies, so asking for an unassigned job returns nothing
  // rather than that job's applicants.
  if (query.jobId) out = out.eq("job_id", query.jobId);

  /*
   * The Applied tab also has to claim the NULLs. `toRow` coalesces a null stage
   * to 'applied', so those rows render under Applied and the tab has to select
   * them or its own rows go missing from it.
   */
  if (query.stage) {
    out =
      query.stage === "applied"
        ? out.or("pipeline_stage.eq.applied,pipeline_stage.is.null")
        : out.eq("pipeline_stage", query.stage);
  }

  // Both halves of showsWorthALook: the mark is KEPT on a row that moved on, so
  // the stage gate is what stops the chip counting rows the list won't mark.
  if (query.flaggedOnly) {
    out = out
      .not("shortlist_flagged_at", "is", null)
      .in("pipeline_stage", WORTH_A_LOOK_STAGES as unknown as string[]);
  }

  /*
   * One `.or()` per word, so the words are ANDed and their order stops
   * mattering. postgrest-js appends each as its own `or=` parameter and
   * PostgREST ANDs them — a single `.or()` holding every word would OR them
   * instead, widening the search to anyone matching any one word.
   */
  for (const token of searchTokens(query.search ?? "")) {
    out = out.or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%,email.ilike.%${token}%`);
  }

  return out;
}

/**
 * PostgREST's "Requested range not satisfiable".
 *
 * Measured boundary: an offset EQUAL to the total answers 206 with zero rows,
 * and only an offset strictly GREATER than the total fails this way. So page 1
 * of an empty result is a normal empty response, and this code means the page
 * number has outrun a population that shrank — a stale `?page=`, or rows
 * filtered away while the number stayed put.
 */
const RANGE_NOT_SATISFIABLE = "PGRST103";

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
): Promise<Read<CompanyApplicantPage>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /*
   * Per-job scoping, applied to the ROWS. The filter lives here rather than at
   * each call site: there is one query, so there is one place to get it wrong.
   */
  const scopeRead = await readJobScope(ctx);
  // Unreadable scope is not "assigned to no roles": that renders the empty
  // state, whose copy tells the reader they are on no jobs yet. Same shape,
  // different claim — so the unknown travels and `loadFailed` speaks instead.
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;
  // An answer: assigned to no roles means no applicants to list.
  if (scope.scoped && scope.jobIds.length === 0) return answered({ rows: [], total: 0 });

  /*
   * A factory, because the out-of-range path below re-issues the same filters
   * as a head count. Two hand-copied filter chains are how a count ends up
   * describing a different population from the rows it is printed beside.
   */
  const build = (head: boolean) =>
    listQuery(service, ctx.companyId, scope, query, APPLICANT_LIST_SELECT, {
      count: "exact",
      head,
    });

  /*
   * ── Why the ordered column is a string with parentheses ──────
   *
   * `order("effective_score", { referencedTable: "application_scores" })` is
   * the wrong tool and fails SILENTLY. It emits
   * `application_scores.order=…`, which orders rows *within* the embed — for a
   * to-one embed that is a no-op — and leaves the parent unordered. Measured:
   * 200 OK, ten unscored rows, no error anywhere. The parent form is
   * `order=application_scores(effective_score)…`, which postgrest-js produces
   * only when the parentheses are in the column string.
   *
   * `nullslast` is explicit and mandatory: DESC defaults to NULLS FIRST, which
   * would stack every unscored applicant above every scored one — and roughly
   * two-thirds of this company's applicants are unscored.
   *
   * `id.asc` last is not a tidiness tiebreaker. Without a unique final term
   * Postgres may order ties differently between the two requests that fetch two
   * adjacent pages, and it was measured in production doing exactly that: 2
   * applicants returned twice and 2 dropped entirely. It failed at 1 boundary
   * in 5, which is worse than failing at all of them.
   */
  const ordered = <T extends ReturnType<typeof build>>(q: T) =>
    query.sort === "newest"
      ? q.order("created_at", { ascending: false, nullsFirst: false }).order("id")
      : q
          .order("application_scores(effective_score)", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false, nullsFirst: false })
          .order("id");

  const page = Math.max(1, Math.trunc(query.page ?? 1) || 1);
  const from = (page - 1) * APPLICANT_PAGE_SIZE;

  const { data, error, count } = await ordered(build(false)).range(
    from,
    from + APPLICANT_PAGE_SIZE - 1,
  );

  if (error) {
    /*
     * A page past the end of a population that shrank. Zero rows IS the honest
     * answer for that window, so it must not read as a failed load — but the
     * total has to come back, because the total is what lets the caller clamp
     * to a page that exists. postgrest-js discards the count on a non-2xx, so
     * it is re-read with one head request. Bounded at one: the retry carries no
     * range and so cannot miss again.
     */
    if (error.code === RANGE_NOT_SATISFIABLE) {
      const { count: total, error: countError } = await build(true);
      if (countError) {
        console.error("[applicants] out-of-range page: count failed:", countError.message);
        return unavailable();
      }
      return answered({ rows: [], total: countOf(total) });
    }
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

  const rows = (data ?? []) as unknown as ApplicantListQueryRow[];
  return answered({
    rows: rows.map((r) => toRow(r, r.application_scores ?? undefined)),
    // countOf, not `count ?? 0`: a 200 whose content-range was stripped would
    // otherwise publish a hard zero over a populated pipeline.
    total: countOf(count),
  });
}

/**
 * The best TOP_SCORED_LIMIT scored applicants in the current view — "Review top
 * 10", and the rows the "Top match" chips are drawn from.
 *
 * ── Why this is a second query and not a slice of the page ───
 *
 * Because it is a claim about the whole filtered population, not about page 1.
 * The client used to rank every loaded applicant and take the first ten, which
 * was correct only because it held everyone. A slice of a 20-row page would
 * silently become "the best of the twenty we happen to be showing" — and on
 * page 3 it would mean nothing at all.
 *
 * ── Two gates, and why neither alone would do ────────────────
 *
 * `!inner` restricts the parent to applications that HAVE a score row, and the
 * embed filter restricts it further — which it can only do because this join is
 * INNER. Across the list's LEFT embed the very same filter would not restrict
 * the parent at all.
 *
 *   !inner                       a candidate with no score row has no number by
 *                                definition, and under a LEFT join would come
 *                                back with a null embed and sort into the view.
 *   effective_score IS NOT NULL  having a row is not having a number. A pending
 *                                card, or a scored one the model returned no
 *                                number for, is a row — and it would take a
 *                                place from someone who has a score.
 *
 * There is no longer a third gate on `status`, and that is deliberate: see the
 * comment at the filter for why adding one back is a defect under (B), not
 * belt-and-braces.
 *
 * ── Three-state, like every other read here ──────────────────
 *
 * `unavailable()` for a failed read, `answered([])` for "nobody is scored yet".
 * The difference is visible: an empty answer hides the "Review top" button,
 * while a failed read must not, because hiding it would tell the reader there
 * is nothing to review.
 */
export async function fetchTopScoredApplicants(
  query: CompanyApplicantQuery = {},
): Promise<Read<CompanyApplicantRow[]>> {
  const ctx = await getCompanyContext();

  const scopeRead = await readJobScope(ctx);
  if (!scopeRead.ok) return unavailable();
  const scope = scopeRead.value;
  // An answer: assigned to no roles means nobody to rank.
  if (scope.scoped && scope.jobIds.length === 0) return answered([]);

  const service = createServiceClient();

  const { data, error } = await listQuery(service, ctx.companyId, scope, query, TOP_SCORED_SELECT)
    // ONE gate, not two. `effective_score IS NOT NULL` is now the whole
    // question: the widened generated column already answers null unless
    // status='scored' OR a human put a number on the row, so this filter is
    // exactly the set that has a number to rank by.
    //
    // A second `.eq("status","scored")` beside it used to be belt-and-braces and
    // under (B) is a defect: it would refuse a reviewer's correction to a CV the
    // model skipped, so the list would rank that candidate first and show their
    // score while the "Top match" chip and "Review top 10" denied they were
    // scored at all — the divergence this column was widened to close, moved
    // from the list to the chips.
    .not("application_scores.effective_score", "is", null)
    // The same three terms as the list's Best Match, for the same reasons — and
    // the tiebreaker matters here too: without it two readers can be shown
    // different "top 10"s from the same data.
    .order("application_scores(effective_score)", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("id")
    .limit(TOP_SCORED_LIMIT);

  if (error) {
    console.error("[applicants] fetchTopScoredApplicants failed:", error);
    return unavailable();
  }

  const rows = (data ?? []) as unknown as ApplicantListQueryRow[];
  return answered(rows.map((r) => toRow(r, r.application_scores ?? undefined)));
}

/**
 * Screening answers for the applicants on one page, for the CSV export.
 *
 * The export's screening column used to come free, because the list carried
 * the jsonb for every applicant to serve a column read on twenty of them. It
 * no longer does, so the export fetches what it needs — and only what it
 * needs.
 *
 * Capped at one page rather than chunked. Chunking is what the score summaries
 * do, and it is right there because that read covers the whole list; here the
 * only caller is one page of a paginated table, so a version that accepted
 * thousands of ids would be a new way to pull this jsonb for the entire table
 * through an export button. Over the cap is a refusal, and no query is issued.
 *
 * Scoped exactly like the list: company first, then the caller's job scope. An
 * id outside either simply does not come back, and the caller writes no file
 * when an id it asked for is missing — so an out-of-scope id cannot be
 * exported as a blank cell.
 */
export async function fetchScreeningAnswers(
  ids: string[],
): Promise<Read<Record<string, ScreeningAnswerSnapshot[]>>> {
  if (ids.length === 0) return answered({});
  if (ids.length > CSV_EXPORT_MAX) {
    console.error(
      `[applicants] fetchScreeningAnswers refused ${ids.length} ids, cap is ${CSV_EXPORT_MAX}`,
    );
    return unavailable();
  }

  const ctx = await getCompanyContext();
  const scope = await getJobScope(ctx);
  // An answer: assigned to no roles means none of these ids are readable.
  if (scope.scoped && scope.jobIds.length === 0) return answered({});

  const service = createServiceClient();
  let q = service
    .from("job_applications")
    .select("id, screening_answers")
    .eq("company_id_snapshot", ctx.companyId)
    .in("id", ids);

  if (scope.scoped) q = q.in("job_id", scope.jobIds);

  const { data, error } = await q;
  if (error) {
    console.error("[applicants] fetchScreeningAnswers failed:", error);
    return unavailable();
  }

  const out: Record<string, ScreeningAnswerSnapshot[]> = {};
  for (const r of (data ?? []) as { id: string; screening_answers: unknown }[]) {
    out[r.id] = toScreeningAnswers(r.screening_answers);
  }
  return answered(out);
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
    .select(APPLICANT_DETAIL_COLUMNS)
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

  const row = data as unknown as ApplicantDetailQueryRow | null;
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
  // Null until a job row is found: the card reads null as "the job is gone",
  // which is also what the scorer does (it skips with "no longer exists").
  let jobScoringEnabled: boolean | null = null;
  if (row.job_id) {
    const { data: jobRow } = await service
      .from("jobs")
      .select("criteria_version, scoring_must_haves, ai_cv_scoring_enabled")
      .eq("id", row.job_id)
      .eq("company_id", ctx.companyId)
      .maybeSingle();
    const job = jobRow as {
      criteria_version?: number | null;
      scoring_must_haves?: unknown;
      ai_cv_scoring_enabled?: boolean | null;
    } | null;
    jobCriteriaVersion = typeof job?.criteria_version === "number" ? job.criteria_version : null;
    jobMustHaveCount = Array.isArray(job?.scoring_must_haves) ? job.scoring_must_haves.length : 0;
    // `!== false`, the scorer's own polarity: a row predating the column still scores.
    if (job) jobScoringEnabled = job.ai_cv_scoring_enabled !== false;
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
    screening_answers: toScreeningAnswers(row.screening_answers),
    history: (histData ?? []) as StageHistoryRow[],
    scoreDetail,
    scoring: await readScoringFacts(service, ctx.companyId, applicationId, {
      jobScoringEnabled,
      scored: sRow?.status === "scored",
    }),
    comments: await readComments(service, ctx.companyId, applicationId),
  });
}

/**
 * The structural facts behind the drawer's unscored card. Drawer-only: the
 * list never pays for these.
 *
 * cv_text is read here and NOT returned - only its length matters, and the
 * comparison is the scorer's own (MIN_CV_TEXT_CHARS on the trimmed text), so
 * "unreadable" here means exactly what it means to handleAiCvScore.
 *
 * The queue is consulted only when there is no scored card: with one, nothing
 * about the queue changes what the drawer shows, and a `dead` row left behind
 * by a later-successful re-score would only mislead. Scoped on the job row's
 * own company_id as well as the payload, so this is never a cross-tenant read.
 * Newest row wins. The queue never writes `failed` (a retry goes back to
 * `queued` with attempts incremented; exhaustion is `dead`), so a `failed` row
 * would be one nothing will ever claim - read as dead, not as retrying.
 */
async function readScoringFacts(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  applicationId: string,
  input: { jobScoringEnabled: boolean | null; scored: boolean },
): Promise<ApplicantScoringFacts> {
  const [{ data: textRow }, { data: jobRows }] = await Promise.all([
    service
      .from("job_applications")
      .select("cv_text")
      .eq("id", applicationId)
      .eq("company_id_snapshot", companyId)
      .maybeSingle(),
    input.scored
      ? Promise.resolve({ data: [] as unknown[] })
      : service
          .from("background_jobs")
          .select("status, attempts")
          .eq("company_id", companyId)
          .eq("type", "ai_cv_score")
          .contains("payload", { applicationId })
          .in("status", ["queued", "running", "failed", "dead"])
          .order("created_at", { ascending: false })
          .limit(1),
  ]);

  const text = ((textRow as { cv_text: string | null } | null)?.cv_text ?? "").trim();
  const job = ((jobRows ?? []) as { status: string; attempts: number | null }[])[0];

  let queue: ScoreQueueState = null;
  if (job) {
    if (job.status === "running") queue = "running";
    else if (job.status === "queued") queue = (job.attempts ?? 0) > 0 ? "retrying" : "queued";
    else queue = "dead";
  }

  return {
    jobScoringEnabled: input.jobScoringEnabled,
    cvReadable: text.length >= MIN_CV_TEXT_CHARS,
    queue,
  };
}

/**
 * The jobs this viewer may add a candidate to.
 *
 * Scoped company-first then by job scope, the same two layers every other read
 * here uses — an unassigned recruiter gets an empty list rather than the
 * company's whole board.
 *
 * ── No status filter, on purpose ─────────────────────────────
 *
 * Closed and archived jobs stay listable. The apply route gates PUBLIC
 * applications on visibility but exempts manual_upload from it, because
 * somebody backfilling a candidate onto a role that has already come down is a
 * real thing people do — a CV that arrived by email the day the role closed
 * still belongs on that role. A recruiter adding one by hand is the same case,
 * so the same exemption applies. This is a decision, not an omission.
 */
export async function fetchAssignableJobs(): Promise<Read<AssignableJob[]>> {
  const ctx = await getCompanyContext();
  const scope = await getJobScope(ctx);
  // An answer: assigned to no roles means nowhere to put a candidate.
  if (scope.scoped && scope.jobIds.length === 0) return answered([]);

  const service = createServiceClient();
  // Deleted IS filtered, unlike status and archived_at above: a closed role is
  // one you can still defensibly file a late CV against, a deleted one is not
  // supposed to exist. Assigning to it would put the candidate somewhere the
  // recruiter can no longer open.
  let q = service
    .from("jobs")
    .select("id, title")
    .eq("company_id", ctx.companyId)
    .is("deleted_at", null);
  if (scope.scoped) q = q.in("id", scope.jobIds);

  const { data, error } = await q.order("created_at", { ascending: false });

  if (error) {
    // Not an empty board. Returning [] would disable the Add button and tell a
    // company with live roles that it has none to add to.
    console.error("[applicants] fetchAssignableJobs failed:", error);
    return unavailable();
  }

  return answered(
    ((data ?? []) as { id: string; title: string | null }[]).map((j) => ({
      id: j.id,
      title: j.title?.trim() || "Untitled role",
    })),
  );
}

// ── Mutations ────────────────────────────────────────────────

type MutationResult<T = undefined> = { success: true; data: T } | { success: false; error: string };

/**
 * Move an applicant through the hiring pipeline.
 *
 * Every active member may move a candidate between the reviewing stages,
 * including hiring managers: reviewing and advancing candidates is their core
 * job. The DECISION is different. Moving into Hired or Rejected, or back out
 * of either, is reserved to owner, admin and recruiter (canChangeStage, in
 * company-roles.ts), and the check reads the stage the database holds now,
 * never one the browser sent. A refused move writes nothing: no stage, no
 * history row.
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

  // The decision guard, BEFORE the stage update and the history insert below.
  // `fromStage` is the row as it stands, read a moment ago, so a client cannot
  // disguise a reversal as a routine move.
  if (!canChangeStage(ctx.role, fromStage, toStage)) {
    return {
      success: false,
      error: "Only an owner, admin or recruiter can hire, reject, or change a hiring decision.",
    };
  }

  // No-op: don't write a history row for a stage that didn't change.
  if (fromStage === toStage) return { success: true, data: undefined };

  const applicantLabel =
    [target.first_name, target.last_name].filter(Boolean).join(" ").trim() || "An applicant";

  const { error: updateErr } = await service
    .from("job_applications")
    .update({ pipeline_stage: toStage })
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  if (updateErr) {
    return { success: false, error: actionFailed("save that stage change", updateErr) };
  }

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
 *
 * Returns the job it cleared so the write can re-assert it instead of
 * inheriting authorization from a check several statements earlier — the same
 * argument the `company_id` filter beside it already makes. No shipped path
 * reassigns `job_applications.job_id`, so this is not closing a live race; it
 * makes the write's scope legible at the write, and would catch a future
 * reassignment feature rather than silently honouring a stale clearance.
 */
async function assertAdjustableScore(
  service: ReturnType<typeof createServiceClient>,
  applicationId: string,
  ctx: CompanyContext,
): Promise<{ ok: true; jobId: string | null } | { ok: false; error: string }> {
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
  return { ok: true, jobId: target.job_id };
}

/**
 * Message for a correction whose row no longer matches the clearance.
 *
 * Deliberately not actionFailed(): nothing failed. The write was refused
 * because the row moved out from under the check, and the only useful
 * instruction is to look again.
 */
const SCORE_MOVED = "This applicant moved while you were editing. Reopen them and try again.";

/**
 * Re-assert `job_id` on a score write.
 *
 * Split out because the column is NULLABLE and PostgREST spells `= NULL` as
 * `is`, not `eq` — `.eq("job_id", null)` matches no row, which would turn every
 * correction on an unassigned application into a silent no-op. Live right now
 * all 148 score rows carry a non-null job_id matching their application's, so
 * the null arm is unreachable in production and exists so that staying correct
 * does not depend on that remaining true.
 */
function atJob<T extends { eq(c: string, v: string): T; is(c: string, v: null): T }>(
  write: T,
  jobId: string | null,
): T {
  return jobId === null ? write.is("job_id", null) : write.eq("job_id", jobId);
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

  const write = service
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

  const { data: written, error } = await atJob(write, allowed.jobId).select("application_id");

  if (error) return { success: false, error: actionFailed("save your adjustment", error) };
  if (!written?.length) return { success: false, error: SCORE_MOVED };

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: undefined };
}

/**
 * Drop a correction and fall back to the model's own score.
 *
 * Nulls all five columns together — a half-cleared row (a score with no author,
 * or an author with no score) would read as corrupt in the calibration set.
 *
 * Gated on a score row EXISTING and nothing more: clearing must work from any
 * status, because the statuses one might be tempted to exclude are exactly the
 * ones a correction most needs removing from. A reviewer who typed a number on
 * a failed or skipped CV and then thought better of it has to be able to take
 * it back, and under (B) that is more true, not less — an adjustment is now the
 * only thing making such a row rank and display at all, so refusing to clear it
 * would strand a number nobody stands behind at the top of Best Match with no
 * way down.
 */
export async function clearScoreAdjustment(
  applicationId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter", "hiring_manager");

  const service = createServiceClient();
  const allowed = await assertAdjustableScore(service, applicationId, ctx);
  if (!allowed.ok) return { success: false, error: allowed.error };

  const write = service
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

  const { data: written, error } = await atJob(write, allowed.jobId).select("application_id");

  if (error) return { success: false, error: actionFailed("revert to the AI score", error) };
  if (!written?.length) return { success: false, error: SCORE_MOVED };

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
 *
 * The allowance check here is advisory: it saves queueing a job the worker
 * would only refuse. The worker's consume_allowance is what decides, and a
 * failed read here lets the request through to it.
 */
export async function rescoreApplication(
  applicationId: string,
): Promise<MutationResult<{ outcome: "queued" | "already_queued" }>> {
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

  if (scoresToQueue(await readCvCapacity(service, ctx.companyId), 1) === 0) {
    return { success: false, error: RESCORE_NO_ALLOWANCE_MESSAGE };
  }

  // One live scoring job per application (migration 030). A second click, or a
  // colleague's, is reported as already queued rather than as a second run.
  const queued = await requestCvScore(applicationId, ctx.companyId);
  if (!queued.ok) return { success: false, error: queueFailed("a re-score", queued.error) };

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { outcome: queued.outcome } };
}

/**
 * Attach a CV to an applicant who is already here.
 *
 * ── Why this attaches rather than creating a row ─────────────
 *
 * A second job_applications row for the same person forks everything keyed on
 * application_id: the stage history, the scorecard, the team's comments and
 * any interview session. The panel would show two of them and the pipeline
 * would count two candidates. So the CV moves onto the existing row.
 *
 * ── The one line that makes this worth building ──────────────
 *
 * `enqueue` at the bottom. A CV that is only stored is a file nobody reads:
 * cv-scoring.ts never looks at cv_path, only at cv_text, and it only ever runs
 * because something queued it. Uploading without queueing would produce a
 * feature that looks identical to a working one from the outside.
 *
 * Queued UNCONDITIONALLY — including when extraction found nothing. The
 * handler's own guards write a `skipped` scorecard with a reason, and the
 * panel renders it, so a scanned-image PDF says "couldn't read this" instead
 * of going quiet. Those guards run before the model call, so a skip is free.
 *
 * ── cv_delete_after is deliberately NOT touched ──────────────
 *
 * The 24 months was set when the candidate applied and is a promise about the
 * APPLICATION, not about whichever file is currently attached to it. Resetting
 * the clock would hold someone's document longer because the company chose to
 * upload something, which the candidate was never party to. Inheriting can
 * delete a new file early; resetting keeps it past the promise. Early is the
 * direction that errs toward the person.
 *
 * Every company-scoped row has a date today, so the inherited value is never
 * null and a newly attached CV is never left outside the purge. The visible
 * cost is that attaching to a nearly-expired application shows "CV expired"
 * soon after — correct, and surprising exactly once. Past the date, the upload
 * is refused outright; see the guard below.
 *
 * ── Currently called by nothing ──────────────────────────────
 *
 * The drawer's Replace / Add CV button was its only caller and was removed on
 * purpose — see the note where it stood, in _applicants-client's Application
 * card. This is KEPT, not orphaned: the decision was about the button, not
 * about whether attaching is the right operation, and the cost of bringing it
 * back should be a button rather than this whole action. Do not delete it as
 * dead code without re-reading that note.
 */
export async function attachApplicationCv(
  applicationId: string,
  form: FormData,
): Promise<
  MutationResult<{
    cvTextStatus: PdfTextResult["status"];
    scoreQueued: boolean;
    /**
     * How much text the new file yielded, against the scorer's floor - so the
     * drawer can say "this one is unreadable too" at once, rather than after
     * a queue round-trip that ends in the same skipped card.
     */
    cvTextChars: number;
    cvReadable: boolean;
    minCvTextChars: number;
  }>
> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const file = form.get("cv");
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: "Choose a PDF to upload." };
  }

  const check = await checkCvFile(file);
  if (!check.ok) return { success: false, error: check.message };

  const service = createServiceClient();

  // Ownership recheck, worded and scoped exactly as rescoreApplication and
  // deleteApplication do: not-found and not-yours share one message so a
  // caller cannot probe another company's ids.
  const { data } = await service
    .from("job_applications")
    .select("id, company_id_snapshot, job_id, cv_path, cv_delete_after")
    .eq("id", applicationId)
    .maybeSingle();

  const target = data as {
    id: string;
    company_id_snapshot: string | null;
    job_id: string | null;
    cv_path: string | null;
    cv_delete_after: string | null;
  } | null;

  if (!target || target.company_id_snapshot !== ctx.companyId) {
    return { success: false, error: "Applicant not found in your workspace." };
  }
  if (!(await canAccessJob(ctx, target.job_id ?? ""))) {
    return { success: false, error: "Applicant not found in your workspace." };
  }

  /*
   * The direct consequence of inheriting the date: once it has passed, cv-purge
   * selects this row on its next daily run — its filter is the date plus a
   * non-null cv_path or cv_text — and deletes whatever is attached. Accepting
   * the file would store it, score it, and lose it inside 24 hours while the
   * panel said it worked. If the promise to the candidate has run out, the
   * answer is no, not "yes for a day".
   */
  if (target.cv_delete_after !== null && new Date(target.cv_delete_after) <= new Date()) {
    return {
      success: false,
      error: "This application's CV retention period has ended, so a new CV can't be attached.",
    };
  }

  const previousPath = target.cv_path;

  /*
   * Same layout the apply route writes: the job's folder, a fresh uuid. Never
   * the old key — overwriting in place would leave the signed URLs already
   * handed out pointing at a different person's document, and would make the
   * upload unrecoverable if the row update below failed.
   */
  const folder = target.job_id ?? "manual";
  const path = `${folder}/${crypto.randomUUID()}.pdf`;

  const { error: uploadErr } = await service.storage
    .from(CV_BUCKET)
    .upload(path, check.bytes, { contentType: "application/pdf", upsert: false });
  // Nothing has been written yet: the row is untouched and no object landed.
  if (uploadErr) return { success: false, error: actionFailed("attach that CV", uploadErr) };

  /*
   * Never throws by contract; wrapped anyway because a module-load failure in
   * unpdf must degrade to "stored but unreadable" rather than lose the upload.
   * Hence the failure values are the DEFAULTS and the try overwrites them —
   * there is no third state where the file is attached and the status is
   * unset. Sanitise before capping, so the cap still holds afterwards.
   */
  let text: string | null = null;
  let status: PdfTextResult["status"] = "failed";
  let extractError: string | null = "extract_call_failed";
  try {
    const result = await extractPdfTextServer(check.bytes);
    text = capCvText(result.text === null ? null : stripInvalidPgChars(result.text));
    status = result.status;
    extractError = result.error;
  } catch (err) {
    console.error("[applicants] cv extraction call failed:", err);
  }

  /*
   * cv_url is cleared, not left alone. It is the legacy public-URL column, and
   * 145 rows still carry one: leaving it would point at the file being
   * replaced, and /api/cv/company-application prefers it when present.
   */
  const { error: updateErr } = await service
    .from("job_applications")
    .update({
      cv_path: path,
      cv_url: null,
      cv_text: text,
      cv_text_status: status,
      cv_text_error: extractError,
    })
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  if (updateErr) {
    // Roll the object back: nothing points at it, so leaving it would strand a
    // CV in the bucket with no record of its path outside this log line.
    try {
      await service.storage.from(CV_BUCKET).remove([path]);
    } catch (err) {
      console.error("[CV_ORPHAN][applicants] rollback of attached CV failed", {
        applicationId,
        path,
        error: err,
      });
    }
    return { success: false, error: actionFailed("attach that CV", updateErr) };
  }

  /*
   * A failure here is NOT a failure of the upload: the CV is attached and the
   * row is correct. So it rolls nothing back and returns no error — it is
   * REPORTED instead, because "attached but never scored" is the precise
   * outcome this action exists to stop happening silently. The panel's
   * existing Re-score button is the retry.
   */
  const queued = await requestCvScore(applicationId, ctx.companyId);
  if (!queued.ok) {
    console.error("[applicants] CV attached but scoring could not be queued", {
      applicationId,
      error: queueFailed("scoring for that CV", queued.error),
    });
  }

  /*
   * The old object goes LAST, and only after asking who else holds the key.
   *
   * A cv_path is COPIED, never re-uploaded, into talent_profiles and onward
   * into client_batch_candidates (see lib/shared-storage-refs.ts). Deleting
   * the previous file because this row stopped naming it would blank a CV
   * another record still advertises. Last, because a failure here leaves a
   * stranded object — the recoverable outcome — whereas deleting before the
   * row was updated would leave the applicant with no CV at all.
   */
  if (previousPath && previousPath !== path) {
    try {
      const shared = await findSharedPaths(service, "cv_path", [previousPath], {
        table: "job_applications",
        ids: new Set([applicationId]),
      });
      if (!shared.has(previousPath)) {
        const outcome = await removeObjects(service, CV_BUCKET, [previousPath]);
        if (!outcome.complete) {
          console.error("[CV_ORPHAN][applicants] replaced CV not confirmed deleted", {
            applicationId,
            path: previousPath,
            error: outcome.error,
          });
        }
      }
    } catch (err) {
      console.error("[CV_ORPHAN][applicants] replaced-CV cleanup threw", {
        applicationId,
        path: previousPath,
        error: err,
      });
    }
  }

  revalidatePath("/ai-dashboard/applicants");
  const cvTextChars = (text ?? "").trim().length;
  return {
    success: true,
    data: {
      cvTextStatus: status,
      scoreQueued: queued.ok,
      cvTextChars,
      cvReadable: cvTextChars >= MIN_CV_TEXT_CHARS,
      minCvTextChars: MIN_CV_TEXT_CHARS,
    },
  };
}

/** Matches /api/apply's MAX_NAME_LENGTH. Restated, not imported: a server
 *  action reaching into an API route module is the wrong dependency direction. */
const NAME_MAX = 100;

/** FormData's string fields, trimmed, with blank collapsing to null. */
function text(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type AddApplicantResult =
  | {
      success: true;
      data: {
        applicationId: string;
        cvTextStatus: PdfTextResult["status"];
        scoreQueued: boolean;
      };
    }
  | { success: false; error: string; duplicate?: AddApplicantDuplicate };

/**
 * Create an applicant who never applied — a CV that reached a recruiter some
 * other way, put into the pipeline by hand.
 *
 * ── Why this is not /api/apply ───────────────────────────────
 *
 * That route already does this shape for Remotiv's own admins, and reusing it
 * was the obvious move. It is wrong for two reasons that are not stylistic.
 *
 * Its manual_upload branch is gated on requireAdmin, and that gate is what
 * makes the branch's exemptions — skipping dedup, skipping the visibility
 * check — safe to expose at all. Widening it to accept a company session would
 * put those exemptions behind a much larger door, on a public endpoint.
 *
 * And it derives company_id_snapshot from jobs.company_id without checking
 * that the CALLER owns the job. Harmless for an admin; for a recruiter it
 * means a forged job_id files a candidate into somebody else's workspace.
 *
 * The route also writes a null company_id_snapshot whenever the job has none —
 * which is exactly how the bulk import put 1,200+ candidates into a table
 * where no company's Applicants page can see them. That is the defect this
 * action exists to not repeat, so the snapshot here comes from the session.
 *
 * ── Insert, upload, update — and why not upload first ────────
 *
 * The obvious order is upload-then-insert, so a row never exists without its
 * file. It is the wrong one. When the insert fails, the rollback is a storage
 * delete, and when THAT fails the residue is a PDF in the bucket that nothing
 * references — a stranger's CV, with no row naming it, discoverable only by
 * grepping logs for its uuid. Nobody finds it and nobody can tell whose it is.
 *
 * Inserting first inverts the residue. A failed upload rolls back a row we can
 * name, scoped and deleted by primary key; if even that fails, what survives
 * is an applicant with no CV — visible in the list, attributable to a person,
 * and fixable with the Add CV button already in the drawer.
 *
 * The cost is honest and small: between the insert and the update the row
 * truthfully carries no cv_path, so it renders as "no CV" for the moment it
 * takes to upload. That beats pointing at a file that isn't there yet, which
 * is what setting cv_path up front would do.
 *
 * DO NOT "fix" this back to upload-first. It reads like a bug and is not one.
 *
 * ── No email ────────────────────────────────────────────────
 *
 * queueApplicationReceived is deliberately not called. The wording would be
 * false — they did not apply — but the real reason is consent: the apply form
 * is where a candidate is shown the privacy terms and accepts them, and
 * someone a recruiter entered by hand never saw that screen. There is no basis
 * to open a messaging relationship with them, so rewording it would not make
 * sending one correct.
 */
export async function addCompanyApplicant(form: FormData): Promise<AddApplicantResult> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");

  const firstName = text(form.get("first_name"));
  const lastName = text(form.get("last_name"));
  const rawEmail = text(form.get("email"));
  const jobId = text(form.get("job_id"));
  const file = form.get("cv");

  if (!firstName || !lastName) {
    return { success: false, error: "Enter the candidate's first and last name." };
  }
  if (firstName.length > NAME_MAX || lastName.length > NAME_MAX) {
    return { success: false, error: "That name is too long." };
  }
  // Required here, unlike on /apply where an application may be anonymised.
  // It is the only identifier the duplicate check has, and a manual add with
  // no email is a row nobody can ever match against.
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (!email || !isValidEmail(email)) {
    return { success: false, error: "Enter a valid email address." };
  }
  if (!jobId) {
    return { success: false, error: "Choose the role to add them to." };
  }
  /*
   * The CV is required, and that is a product decision worth stating. A
   * manual add without one is a name in a list: cv-scoring reads cv_text and
   * would write a skipped scorecard, so the candidate would sit there unread
   * until somebody came back with the Add CV button. Better to ask for it now
   * than to create the row that needs fixing later.
   */
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: "Attach the candidate's CV as a PDF." };
  }

  const check = await checkCvFile(file);
  if (!check.ok) return { success: false, error: check.message };

  const service = createServiceClient();

  /*
   * The job, by BOTH id and company — then the per-job team check. Same two
   * steps as rescoreJob, and both are needed: the first stops a job id from
   * another tenant, the second stops a scoped recruiter reaching a job inside
   * their own company that they are not on.
   *
   * The title is read here rather than in a second query because the row needs
   * job_title_snapshot, which is what the list falls back to once a job is
   * deleted and job_id goes null.
   */
  const { data: jobData } = await service
    .from("jobs")
    .select("id, title")
    .eq("id", jobId)
    .eq("company_id", ctx.companyId)
    // A deleted job accepts no new applications, by this route either. The
    // public apply route already 404s; this is the same rule for the recruiter
    // who adds a candidate by hand.
    .is("deleted_at", null)
    .maybeSingle();

  const job = jobData as { id: string; title: string | null } | null;
  // Not-found and not-yours share one message, the rule every action here
  // follows, so a job id cannot be confirmed by probing.
  if (!job || !(await canAccessJob(ctx, jobId))) {
    return { success: false, error: "That role isn't in your workspace." };
  }

  /*
   * Refuse a second row for the same person on the same role.
   *
   * There is no unique constraint behind this — it is a product rule, and the
   * reason it is a rule is that a duplicate row forks everything keyed on
   * application_id: the scorecard, the stage history, the team's comments, any
   * interview session. The pipeline would then count one candidate twice.
   *
   * `.ilike` rather than `.eq` because rows written before email normalisation
   * may differ only in case. Scoped on company_id_snapshot as well as job_id,
   * since the tenant boundary must not rest on a job id alone. `.limit(1)`
   * rather than `.maybeSingle()` because nothing stops two matching rows
   * existing today, and maybeSingle would turn that into a 406 — reporting a
   * duplicate as a server error. Oldest first, so the message names the
   * original rather than a later copy.
   *
   * No branch on `source`: a real applicant and an earlier manual add are the
   * same answer to the recruiter, and both refuse identically.
   */
  const { data: dupData } = await service
    .from("job_applications")
    .select("id, first_name, last_name, created_at")
    .eq("company_id_snapshot", ctx.companyId)
    .eq("job_id", jobId)
    .ilike("email", email)
    .order("created_at", { ascending: true })
    .limit(1);

  const dup = (
    (dupData ?? []) as unknown as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      created_at: string | null;
    }[]
  )[0];

  if (dup) {
    // The name comes off the EXISTING row, not from what was just typed. If
    // they are in as "Sana Riaz" and the recruiter typed "Sanaa", the useful
    // fact is who is already there.
    const name = [dup.first_name, dup.last_name].filter(Boolean).join(" ").trim() || "Someone";
    return {
      success: false,
      // Dateless on purpose — the caller renders the date in the reader's
      // timezone from `duplicate`. This string is the honest fallback for a
      // caller that ignores the structured half.
      error: `${name} has already applied to this role.`,
      duplicate: { applicationId: dup.id, name, appliedAt: dup.created_at },
    };
  }

  /*
   * Extraction runs BEFORE the insert so the row carries its real text status
   * from the first write — no row ever claims 'pending' for text we already
   * have. Never throws by contract; wrapped anyway, with the failure values as
   * the defaults, so a module-load failure in unpdf degrades to "stored but
   * unreadable" instead of losing the candidate. Sanitise before capping, so
   * the cap still holds afterwards.
   */
  let cvText: string | null = null;
  let status: PdfTextResult["status"] = "failed";
  let extractError: string | null = "extract_call_failed";
  try {
    const result = await extractPdfTextServer(check.bytes);
    cvText = capCvText(result.text === null ? null : stripInvalidPgChars(result.text));
    status = result.status;
    extractError = result.error;
  } catch (err) {
    console.error("[applicants] cv extraction call failed:", err);
  }

  /*
   * 1. The row, with cv_path still null. See the banner for why this comes
   *    first.
   *
   * pipeline_stage and screening_answers are OMITTED rather than set: both are
   * NOT NULL with defaults ('applied', '[]'), so the database supplies them.
   * Applied is right — a manual add is an application arriving through a
   * different door, and Screening would claim a step nobody took. The empty
   * answers are an absence, not an assertion: screening answers are the
   * candidate's own statements and nobody else can make them.
   *
   * Everything else the table holds — phone, LinkedIn, location, skills,
   * employment history, the whole wizard half — is left null. The recruiter
   * has a CV, not a filled-in profile, and those facts are IN the CV for the
   * scorer to read. Asking them to retype what they are already uploading
   * would be the wrong trade.
   */
  const { data: insertedRow, error: insertErr } = await service
    .from("job_applications")
    .insert({
      job_id: jobId,
      first_name: stripInvalidPgChars(firstName),
      last_name: stripInvalidPgChars(lastName),
      email: stripInvalidPgChars(email),
      cv_path: null,
      cv_url: null,
      cv_text: cvText,
      cv_text_status: status,
      cv_text_error: extractError,
      status: "new",
      source: "manual_upload",
      job_title_snapshot: job.title?.trim() || null,
      // From the SESSION, never from the job row. Same value today, but this
      // is the field the import got wrong, and the session is the fact the
      // caller cannot influence.
      company_id_snapshot: ctx.companyId,
      // The same 24 months every company application gets. Shared with
      // /api/apply via lib/cv-file.ts so the promise cannot depend on which
      // door the candidate came through.
      cv_delete_after: cvRetentionDate(),
    })
    .select("id")
    .single();

  if (insertErr || !insertedRow) {
    console.error("[applicants] addCompanyApplicant insert failed:", insertErr);
    return { success: false, error: "Couldn't add that candidate. Please try again." };
  }

  const applicationId = (insertedRow as { id: string }).id;

  /**
   * Drop the half-made applicant. Scoped by company like every other write.
   * Returns whether the rollback landed: when it did, the caller may truthfully
   * say nothing was changed; when it did not, an applicant without a CV is
   * left behind and the caller must say so instead.
   */
  const removeRow = async (reason: string): Promise<boolean> => {
    const { error: delErr } = await service
      .from("job_applications")
      .delete()
      .eq("id", applicationId)
      .eq("company_id_snapshot", ctx.companyId);
    if (delErr) {
      // The residue this order chooses: an applicant with no CV. Named, in
      // the list, and fixable with the drawer's Add CV button — which is why
      // it is the acceptable one.
      console.error(`[applicants] ${reason}; rollback of the new applicant failed`, {
        applicationId,
        error: delErr.message,
      });
      return false;
    }
    return true;
  };

  // 2. The file. Same layout the apply route writes: the job's folder, a fresh
  //    uuid, so nothing in the path is guessable or personal.
  const path = `${jobId}/${crypto.randomUUID()}.pdf`;
  const { error: uploadErr } = await service.storage
    .from(CV_BUCKET)
    .upload(path, check.bytes, { contentType: "application/pdf", upsert: false });

  if (uploadErr) {
    const rolledBack = await removeRow("CV upload failed");
    return {
      success: false,
      error: rolledBack
        ? actionFailed("add that candidate", uploadErr)
        : actionIncomplete("add that candidate", uploadErr),
    };
  }

  // 3. Point the row at the file.
  const { error: updateErr } = await service
    .from("job_applications")
    .update({ cv_path: path })
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  if (updateErr) {
    // Object first, then the row: the row is what makes the object findable,
    // so dropping it first would strand the file. Mirrors deleteApplication.
    try {
      await service.storage.from(CV_BUCKET).remove([path]);
    } catch (err) {
      console.error("[CV_ORPHAN][applicants] rollback of added CV failed", {
        applicationId,
        path,
        error: err,
      });
    }
    const rolledBack = await removeRow("CV path update failed");
    return {
      success: false,
      error: rolledBack
        ? actionFailed("add that candidate", updateErr)
        : actionIncomplete("add that candidate", updateErr),
    };
  }

  /*
   * The line that makes this a feature rather than a filing cabinet. A failure
   * is NOT a failure of the add — the candidate is in, correctly — so it rolls
   * nothing back and is REPORTED instead, because "added but never scored" is
   * precisely the silent outcome worth naming. The drawer's Re-score button is
   * the retry.
   */
  const queued = await requestCvScore(applicationId, ctx.companyId);
  if (!queued.ok) {
    console.error("[applicants] candidate added but scoring could not be queued", {
      applicationId,
      error: queueFailed("scoring for that candidate", queued.error),
    });
  }

  revalidatePath("/ai-dashboard/applicants");
  return {
    success: true,
    data: { applicationId, cvTextStatus: status, scoreQueued: queued.ok },
  };
}

/**
 * Re-queue scoring for every application on one job — the after-you-changed-
 * the-criteria path.
 *
 * The job's own ownership is checked once, then applications are selected by
 * BOTH job_id and company_id_snapshot, so a mismatched snapshot can never be
 * swept in. Paged BY KEY (rescore-collect.ts): the inline `.range()` loops
 * this used to carry had no `.order()`, and the #56 reproduction showed one
 * concurrent update skipping an applicant while the count stayed exact.
 *
 * At most the month's remaining CV-scoring allowance is queued, applicants
 * without a saved card first, and the rest are reported as held. The count is
 * advisory: the worker gates every queued application, because capacity can
 * change before it runs. Held applicants are never queued later on their own.
 */
export async function rescoreJob(
  jobId: string,
): Promise<MutationResult<{ queued: number; alreadyQueued: number; held: number }>> {
  const ctx = await requireCompanyRole("owner", "admin", "recruiter");
  const service = createServiceClient();

  const { data: jobData } = await service
    .from("jobs")
    .select("id, company_id")
    .eq("id", jobId)
    .is("deleted_at", null)
    .maybeSingle();

  const job = jobData as { company_id: string | null } | null;
  if (!job || job.company_id !== ctx.companyId) {
    return { success: false, error: "Job not found in your workspace." };
  }
  if (!(await canAccessJob(ctx, jobId))) {
    return { success: false, error: "Job not found in your workspace." };
  }

  let ids: string[];
  try {
    ids = await collectJobApplicationIds(service, jobId, ctx.companyId);
  } catch (err) {
    const cause = err instanceof Error && err.cause ? err.cause : err;
    return {
      success: false,
      error: actionFailed("start that re-score", cause as { message?: string }),
    };
  }

  const room = scoresToQueue(await readCvCapacity(service, ctx.companyId), ids.length);
  let toQueue = ids;
  if (room < ids.length) {
    // Only the ORDER depends on this read, never the count: a failed read
    // queues in list order, as before, rather than failing the re-score.
    let scored = new Set<string>();
    try {
      scored = await collectScoredApplicationIds(service, jobId, ctx.companyId);
    } catch (err) {
      console.error("[rescoreJob] scored-card read failed; queueing in list order:", err);
    }
    toQueue = unscoredFirst(ids, scored).slice(0, room);
  }
  const held = ids.length - toQueue.length;

  // One job row per application. Enqueued sequentially in small waves so a
  // 500-applicant job doesn't open 500 concurrent inserts. An applicant whose
  // scoring is already in flight (migration 030) is counted separately so the
  // toast can say so instead of claiming a run that did not start.
  let queued = 0;
  let alreadyQueued = 0;
  const WAVE = 25;
  for (let i = 0; i < toQueue.length; i += WAVE) {
    const results = await Promise.all(
      toQueue
        .slice(i, i + WAVE)
        .map((applicationId) => requestCvScore(applicationId, ctx.companyId)),
    );
    for (const r of results) {
      if (!r.ok) continue;
      if (r.outcome === "queued") queued += 1;
      else alreadyQueued += 1;
    }
  }

  revalidatePath("/ai-dashboard/applicants");
  return { success: true, data: { queued, alreadyQueued, held } };
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

  // 0. Their AI interviews and recordings (B7), first: if a file is left, the
  //    delete stops here with nothing else removed, and a retry finishes it.
  const interviews = await deleteApplicationInterviews(service, ctx.companyId, applicationId);
  if (!interviews.ok) return { success: false, error: interviews.error };

  // 1. Its final-interview recordings and its CV file (application-files.ts).
  //    A file left stops here, before the row: nothing finds it once the row
  //    is gone, and a retry finishes the job.
  const files = await removeApplicationFiles(service, ctx.companyId, applicationId, target.cv_path);
  if (!files.ok) return { success: false, error: files.error };

  // 2. The row. Scoped again on company_id_snapshot so the DELETE itself
  //    cannot touch another tenant even if the check above were bypassed.
  const { error: delErr } = await service
    .from("job_applications")
    .delete()
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId);

  // The files above are already gone when this fails, so this is not a
  // "nothing was changed" case; a retry finds them gone and deletes the row.
  if (delErr) return { success: false, error: actionIncomplete("delete that applicant", delErr) };

  await notifyCompany({
    companyId: ctx.companyId,
    type: "applicant_deleted",
    title: `${[target.first_name, target.last_name].filter(Boolean).join(" ").trim() || "An applicant"} was deleted`,
    body: `${ctx.memberName} permanently removed them, their CV, and their interviews and recordings.`,
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
