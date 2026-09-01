"use server";

import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { PROMPT_VERSION as CV_PROMPT_VERSION } from "@/lib/ai/cv-scoring";
import { PROMPT_VERSION as INTERVIEW_PROMPT_VERSION } from "@/lib/ai/interview-scoring";
import { pageAll } from "@/lib/supabase/paging";
import { createServiceClient } from "@/lib/supabase/server";
import {
  buildCalibration,
  buildCompanyRow,
  buildStats,
  type CompanyInput,
  minutesFromSeconds,
  reconcile,
  type ScoreRow,
  type UsageRow,
} from "./rollup";
import { type AnalyticsRange, type AnalyticsResult, RANGE_DAYS } from "./types";

/**
 * Platform analytics — the reads.
 *
 * ── Cross-company by design, super-admin only ────────────────
 *
 * Every other analytics surface in this codebase is scoped to one company;
 * this one deliberately is not, which makes it the single place where a
 * mis-scoped query leaks one customer's figures to another. The gate is
 * `requireSuperAdmin()` at the top of the only exported entry point, and it
 * throws rather than returning an empty result — hiding the nav item is not
 * access control and this file must never be the thing relied upon to hide.
 *
 * ── "use server" exports only async functions ────────────────
 *
 * Types and the range table live in ./types.ts and the arithmetic in
 * ./rollup.ts for exactly that reason. Only `npm run build` catches a
 * violation, so the split is structural rather than stylistic.
 *
 * ── Two different windows, on purpose ────────────────────────
 *
 * Cost is a period; calibration is a corpus. The stat cards and the company
 * table honour the selected range. Calibration ignores it entirely and reads
 * all time — category means need volume before they mean anything, and a month
 * of this platform's traffic is nowhere near enough. Mixing the two is the bug
 * the handoff describes: four denominators, none of which reconcile.
 */

/** PostgREST caps a response at 1000 rows and offers no aggregates. */

/** Only ever count what an admin might plausibly read. Beyond this, stop. */
const MAX_ROWS = 50_000;

/**
 * Read a whole table through the row cap.
 *
 * Offset paging is safe here because every caller reads a settled historical
 * window ordered by a stable key — nothing in these queries mutates its own
 * filter predicate while the loop runs.
 */
/**
 * The shared pager, bound to this page's scope and its row cap.
 *
 * A binding, not an implementation — no loop, no error handling, nothing that
 * can drift from src/lib/supabase/paging.ts. It exists so `cap: MAX_ROWS`
 * cannot be forgotten at one of nine call sites, which is the same
 * consistency-by-hand failure the consolidation removed.
 */
function pagePlatform<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  label: string,
): Promise<T[]> {
  return pageAll<T>(build, { scope: "platform-analytics", label, cap: MAX_ROWS });
}

/** Range start as an ISO instant, or null for all time. */
function rangeStart(range: AnalyticsRange, now: Date): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * When each usage type started being recorded.
 *
 * Derived at runtime from the earliest row of each type rather than hardcoded.
 * A constant would be wrong the first time anyone backfills, and it would have
 * to be updated by hand every time a new metered event ships — which is
 * exactly the sort of maintenance nobody remembers to do, leaving the page
 * quietly lying about its own coverage.
 *
 * Per TYPE, not one date for the table: CV scoring, interview scoring and
 * WhatsApp were instrumented weeks apart, so a single cutoff would mark a
 * range as trustworthy while two of its three cost lines were still empty.
 */
async function usageCutoffs(): Promise<Record<string, string>> {
  const service = createServiceClient();
  const types = ["cv_scored", "interview_scored", "whatsapp_sent"];
  const out: Record<string, string> = {};

  await Promise.all(
    types.map(async (type) => {
      const { data } = await service
        .from("usage_events")
        .select("created_at")
        .eq("type", type)
        .order("created_at", { ascending: true })
        .limit(1);
      const first = (data ?? [])[0] as { created_at: string } | undefined;
      if (first?.created_at) out[type] = first.created_at;
    }),
  );

  return out;
}

/**
 * The whole page, in one server round trip.
 *
 * THROWS for anyone who is not a super admin. The caller is a server component
 * that lets it propagate — a cross-company surface that degraded to an empty
 * state on an authorisation failure would be indistinguishable from a quiet
 * platform, which is the worst of both.
 */
export async function fetchPlatformAnalytics(range: AnalyticsRange): Promise<AnalyticsResult> {
  await requireSuperAdmin();

  const service = createServiceClient();
  const now = new Date();
  const since = rangeStart(range, now);

  /* ── Companies and jobs ─────────────────────────────────── */

  const companies = await pagePlatform<{
    id: string;
    name: string | null;
    is_internal: boolean | null;
    created_at: string | null;
  }>(
    (from, to) =>
      service.from("companies").select("id, name, is_internal, created_at").range(from, to),
    "companies",
  );

  const jobs = await pagePlatform<{
    id: string;
    company_id: string | null;
    category: string | null;
    status: string | null;
    ai_cv_scoring_enabled: boolean | null;
    created_at: string | null;
    archived_at: string | null;
  }>(
    (from, to) =>
      service
        .from("jobs")
        .select("id, company_id, category, status, ai_cv_scoring_enabled, created_at, archived_at")
        .range(from, to),
    "jobs",
  );

  const categoryByJob = new Map(jobs.map((j) => [j.id, j.category]));
  /*
   * "Published" is `status = 'open'`, NOT `'published'`.
   *
   * jobs.status is the three-value set ["open", "on_hold", "closed"], and the
   * UI relabels them: `open` reads as "Published" and `on_hold` as "Draft".
   * Filtering on the label rather than the value is a silent-zero bug — every
   * job count on this page would read 0 and look like a quiet platform rather
   * than a broken query. Archived jobs keep their status, so they are excluded
   * separately.
   */
  const publishedJobs = jobs.filter((j) => j.status === "open" && !j.archived_at);

  /* ── Calibration: ALL TIME, both scorers ────────────────── */

  const cvScores = await pagePlatform<{
    company_id: string | null;
    job_id: string | null;
    overall_score: number | null;
    human_adjusted_score: number | null;
    adjusted_by_name: string | null;
    prompt_version: string | null;
    status: string | null;
    error: string | null;
    scored_at: string | null;
  }>(
    (from, to) =>
      service
        .from("application_scores")
        .select(
          "company_id, job_id, overall_score, human_adjusted_score, adjusted_by_name, prompt_version, status, error, scored_at",
        )
        .order("scored_at", { ascending: true, nullsFirst: true })
        .range(from, to),
    "cv scores",
  );

  /*
   * Sessions are read ONCE and indexed twice. Calibration needs job_id (to
   * reach jobs.category); the transcription line needs company_id. Two passes
   * over the same table would double a read that is already the largest one on
   * the page.
   */
  const sessions = await pagePlatform<{
    id: string;
    job_id: string | null;
    company_id: string | null;
    submitted_at: string | null;
  }>(
    (from, to) =>
      service
        .from("interview_sessions")
        .select("id, job_id, company_id, submitted_at")
        .range(from, to),
    "interview sessions",
  );
  const jobBySession = new Map(sessions.map((s) => [s.id, s.job_id]));
  const companyBySession = new Map<string, string>();
  for (const s of sessions) {
    if (s.company_id) companyBySession.set(s.id, s.company_id);
  }

  const interviewScores = await pagePlatform<{
    session_id: string | null;
    company_id: string | null;
    overall_score: number | null;
    human_adjusted_score: number | null;
    adjusted_by_name: string | null;
    prompt_version: string | null;
    status: string | null;
  }>(
    (from, to) =>
      service
        .from("interview_session_scores")
        .select(
          "session_id, company_id, overall_score, human_adjusted_score, adjusted_by_name, prompt_version, status",
        )
        .range(from, to),
    "interview scores",
  );

  /*
   * Only rows that actually produced a score enter the corpus. A failed run
   * has no model opinion to disagree with, so counting it as "scored" would
   * inflate the denominator and depress the override rate for a reason that
   * has nothing to do with calibration.
   */
  const scoreRows: ScoreRow[] = [
    ...cvScores
      .filter((r) => r.status === "scored")
      .map((r) => ({
        kind: "cv" as const,
        companyId: r.company_id,
        category: r.job_id ? (categoryByJob.get(r.job_id) ?? null) : null,
        promptVersion: r.prompt_version,
        overall: r.overall_score,
        adjusted: r.human_adjusted_score,
        reviewer: r.adjusted_by_name,
      })),
    ...interviewScores
      .filter((r) => r.status === "scored")
      .map((r) => {
        const jobId = r.session_id ? (jobBySession.get(r.session_id) ?? null) : null;
        return {
          kind: "interview" as const,
          companyId: r.company_id,
          category: jobId ? (categoryByJob.get(jobId) ?? null) : null,
          promptVersion: r.prompt_version,
          overall: r.overall_score,
          adjusted: r.human_adjusted_score,
          reviewer: r.adjusted_by_name,
        };
      }),
  ];

  const calibration = buildCalibration(scoreRows);

  /* ── Cost: the SELECTED range ───────────────────────────── */

  const usageRows = await pagePlatform<{
    company_id: string;
    type: string;
    quantity: number | null;
    created_at: string;
  }>((from, to) => {
    let q = service.from("usage_events").select("company_id, type, quantity, created_at");
    if (since) q = q.gte("created_at", since);
    return q.order("created_at", { ascending: true }).range(from, to);
  }, "usage events");

  const usage: UsageRow[] = usageRows.map((u) => ({
    companyId: u.company_id,
    type: u.type,
    quantity: u.quantity ?? 1,
  }));

  /* ── Transcription minutes ──────────────────────────────── */

  /*
   * NOT from usage_events — transcription is the one cost line with no metered
   * event behind it. `interview_answers.duration_seconds` is still recorded
   * fact rather than an estimate, so the line is honest; the footer says which
   * lines come from which source rather than implying one basis for all four.
   */
  const answers = await pagePlatform<{
    session_id: string | null;
    duration_seconds: number | null;
    recorded_at: string | null;
  }>((from, to) => {
    let q = service
      .from("interview_answers")
      .select("session_id, duration_seconds, recorded_at")
      .eq("transcript_status", "done");
    if (since) q = q.gte("recorded_at", since);
    return q.order("recorded_at", { ascending: true, nullsFirst: true }).range(from, to);
  }, "interview answers");

  /*
   * Interviews SUBMITTED in the range, which is a different population from
   * the interviews the AI scored. Taken from interview_sessions.submitted_at
   * rather than usage_events: submission has been recorded since the feature
   * shipped, whereas the `interview_scored` meter only exists from 10 Aug and
   * only fires on a successful scoring run.
   */
  const submittedByCompany = new Map<string, number>();
  for (const session of sessions) {
    if (!session.company_id || !session.submitted_at) continue;
    if (since && session.submitted_at < since) continue;
    submittedByCompany.set(
      session.company_id,
      (submittedByCompany.get(session.company_id) ?? 0) + 1,
    );
  }

  const secondsByCompany = new Map<string, number>();
  for (const a of answers) {
    const companyId = a.session_id ? companyBySession.get(a.session_id) : undefined;
    if (!companyId) continue;
    secondsByCompany.set(
      companyId,
      (secondsByCompany.get(companyId) ?? 0) + (a.duration_seconds ?? 0),
    );
  }

  /* ── Emails ─────────────────────────────────────────────── */

  const emailLogs = await pagePlatform<{ company_id: string | null }>((from, to) => {
    let q = service
      .from("communication_logs")
      .select("company_id, created_at")
      .eq("channel", "email");
    if (since) q = q.gte("created_at", since);
    return q.order("created_at", { ascending: true }).range(from, to);
  }, "communication logs");

  const emailsByCompany = new Map<string, number>();
  for (const log of emailLogs) {
    if (!log.company_id) continue;
    emailsByCompany.set(log.company_id, (emailsByCompany.get(log.company_id) ?? 0) + 1);
  }

  /* ── Health: failures, in the selected range ────────────── */

  const rangedCvScores = since ? cvScores.filter((r) => (r.scored_at ?? "") >= since) : cvScores;

  const failedByCompany = new Map<string, number>();
  const fabricationByCompany = new Map<string, number>();
  for (const row of rangedCvScores) {
    if (row.status !== "failed" || !row.company_id) continue;
    failedByCompany.set(row.company_id, (failedByCompany.get(row.company_id) ?? 0) + 1);
    // The verifier's refusal is the only failure that means the model invented
    // evidence; everything else is an extraction or transport error.
    if ((row.error ?? "").startsWith("Evidence verification failed")) {
      fabricationByCompany.set(row.company_id, (fabricationByCompany.get(row.company_id) ?? 0) + 1);
    }
  }

  /* ── Scoring switched off while they pay for it ─────────── */

  const scoringOffJobs = publishedJobs.filter((j) => j.ai_cv_scoring_enabled === false);
  const scoringOffByCompany = new Map<string, number>();
  for (const job of scoringOffJobs) {
    if (!job.company_id) continue;
    scoringOffByCompany.set(job.company_id, (scoringOffByCompany.get(job.company_id) ?? 0) + 1);
  }

  const unscoredByCompany = new Map<string, number>();
  if (scoringOffJobs.length > 0) {
    // `.in()` travels in the URL, so the id list is chunked rather than sent
    // whole — a company with hundreds of jobs would otherwise 414.
    const ids = scoringOffJobs.map((j) => j.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const apps = await pagePlatform<{ company_id_snapshot: string | null }>(
        (from, to) =>
          service
            .from("job_applications")
            .select("company_id_snapshot, created_at")
            .in("job_id", chunk)
            .order("created_at", { ascending: true })
            .range(from, to),
        "job applications",
      );
      for (const app of apps) {
        if (!app.company_id_snapshot) continue;
        unscoredByCompany.set(
          app.company_id_snapshot,
          (unscoredByCompany.get(app.company_id_snapshot) ?? 0) + 1,
        );
      }
    }
  }

  /* ── Last activity, for the dormancy signal ─────────────── */

  const lastActivity = new Map<string, string>();
  const touch = (companyId: string | null | undefined, at: string | null | undefined) => {
    if (!companyId || !at) return;
    const current = lastActivity.get(companyId);
    if (!current || at > current) lastActivity.set(companyId, at);
  };
  for (const u of usageRows) touch(u.company_id, u.created_at);
  for (const j of jobs) touch(j.company_id, j.created_at);
  for (const r of cvScores) touch(r.company_id, r.scored_at);

  /* ── Assemble ───────────────────────────────────────────── */

  const jobsByCompany = new Map<string, number>();
  for (const job of publishedJobs) {
    if (!job.company_id) continue;
    jobsByCompany.set(job.company_id, (jobsByCompany.get(job.company_id) ?? 0) + 1);
  }

  const inputs: CompanyInput[] = companies.map((c) => ({
    id: c.id,
    name: c.name?.trim() || "Untitled company",
    isInternal: c.is_internal === true,
    lastActivityAt: lastActivity.get(c.id) ?? c.created_at ?? null,
    jobs: jobsByCompany.get(c.id) ?? 0,
    emails: emailsByCompany.get(c.id) ?? 0,
    transcribedMinutes: minutesFromSeconds(secondsByCompany.get(c.id) ?? 0),
    interviewsSubmitted: submittedByCompany.get(c.id) ?? 0,
    failedScores: failedByCompany.get(c.id) ?? 0,
    fabricationRejections: fabricationByCompany.get(c.id) ?? 0,
    unscoredByChoice: unscoredByCompany.get(c.id) ?? 0,
    jobsWithScoringOff: scoringOffByCompany.get(c.id) ?? 0,
  }));

  const companyRows = inputs
    .map((input) => buildCompanyRow(input, usage, now))
    // Biggest spend first, then the quiet ones. Internal sorts with the rest:
    // Remotiv's own costs are real costs and hiding them at the bottom would
    // make the platform total look like it came from customers alone.
    .sort((a, b) => b.costMicro - a.costMicro || b.cvs - a.cvs || a.name.localeCompare(b.name));

  const stats = buildStats(companyRows, publishedJobs.length);

  /*
   * The reconciliation runs on every request, not only in tests. A violation
   * here means a figure on the page contradicts the table under it, which is
   * the one defect this page cannot absorb — so it is logged loudly and
   * returned, and the client renders a visible notice rather than pretending.
   */
  const violations = reconcile(calibration, companyRows, stats);
  if (violations.length > 0) {
    console.error("[platform-analytics] RECONCILIATION FAILED", violations);
  }

  const cutoffs = await usageCutoffs();
  const earliest = Object.values(cutoffs).sort()[0] ?? null;

  return {
    range,
    generatedAt: now.toISOString(),
    rangeStartsAt: since,
    stats,
    calibration,
    /*
     * Read from the scorers' own constants, so the chip cannot drift from what
     * is actually running. The previous version marked row 0 of the table,
     * which is positional and was wrong the moment the sort stopped working.
     */
    liveVersions: { cv: CV_PROMPT_VERSION, interview: INTERVIEW_PROMPT_VERSION },
    companies: companyRows,
    health: {
      scoringFailures: rangedCvScores.filter((r) => r.status === "failed").length,
      fabricationRejections: [...fabricationByCompany.values()].reduce((a, b) => a + b, 0),
      interviewScoringFailures: interviewScores.filter((r) => r.status === "failed").length,
    },
    /*
     * Per-type coverage, so the note can name what is actually missing rather
     * than issuing one blanket warning. Null `earliest` means nothing has ever
     * been metered, which is a different statement from "your range predates
     * the cutoff" and reads differently on the page.
     */
    usage: {
      earliestRecordedAt: earliest,
      byType: cutoffs,
      /** True when the selected range reaches back past a type's first row. */
      incompleteTypes: Object.entries(cutoffs)
        .filter(([, first]) => (since === null ? true : since < first))
        .map(([type]) => type),
      neverRecorded: Object.keys(cutoffs).length === 0,
    },
    violations,
  };
}
