/**
 * The two reads rescoreJob pages over, by KEY.
 *
 * ── Why this is its own module ───────────────────────────────
 *
 * rescoreJob lives in a "use server" file, where nothing can be exported for
 * a test without becoming a POST endpoint. Its collection used to be two
 * inline `.range()` loops with NO `.order()`, and the #56 reproduction
 * (2026-10-28, staging, the 2,500-row job) showed what that costs: one
 * concurrent update to an indexed column moved a tuple, one applicant was
 * read twice and another never, and the count still said 2,500 of 2,500. A
 * skipped id here is an applicant a recruiter asked to re-score and who was
 * silently not. Both reads now go through `pageAllByKey`, which cannot be
 * shifted by an insert, a delete or a moved tuple, and both are exercised by
 * rescore-collect.test.ts against a fake table that mutates between pages.
 *
 * Nothing here writes. The enqueue stays in rescoreJob, after both reads.
 */

import { pageAllByKey } from "@/lib/supabase/paging";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The real service client's type, not a structural slice of it: matching
 * supabase-js's builder against a hand-written shape sent tsc into an
 * excessively deep instantiation at the call site. The tests pass a fake
 * table under @ts-nocheck, which is where that looseness belongs.
 */
export type CollectClient = ReturnType<typeof createServiceClient>;

/**
 * Whether an application's CV has passed its retention date (#91).
 *
 * Expired means a date is set AND it has passed: the CV purge's own test
 * (cv-purge.ts, `.lte("cv_delete_after", now)`). Such an application must
 * never be scored again: with no text the scorer writes a "skipped" card over
 * the one it has, and a skipped card has no effective_score, so the score the
 * purge deliberately kept would drop out of every ranking. A missing text
 * alone is NOT expiry: a future-dated CV whose extraction is pending or failed
 * is still live. A null date is Remotiv's own pool, which never expires.
 */
export function cvExpired(row: { cv_delete_after: string | null }, nowMs: number): boolean {
  if (row.cv_delete_after === null) return false;
  return new Date(row.cv_delete_after).getTime() <= nowMs;
}

/**
 * Every application on one job, selected by BOTH job_id and the company
 * snapshot so a mismatched snapshot can never be swept in, less those whose
 * CV has expired (cvExpired). Throws on a failed page; the caller turns that
 * into its own failure.
 *
 * The expired set is a second keyed read rather than a filter on the first,
 * so the first stays the plain job-and-snapshot read the #57 drift tests and
 * negative control exercise. Its predicate is cvExpired's, in PostgREST.
 */
export async function collectJobApplicationIds(
  service: CollectClient,
  jobId: string,
  companyId: string,
  nowIso: string = new Date().toISOString(),
): Promise<string[]> {
  const rows = await pageAllByKey<{ id: string }>(
    () =>
      service
        .from("job_applications")
        .select("id")
        .eq("job_id", jobId)
        .eq("company_id_snapshot", companyId),
    { scope: "rescore", label: "applications on the job" },
  );
  const expired = await pageAllByKey<{ id: string }>(
    () =>
      service
        .from("job_applications")
        .select("id")
        .eq("job_id", jobId)
        .eq("company_id_snapshot", companyId)
        .lte("cv_delete_after", nowIso),
    { scope: "rescore", label: "expired CVs on the job" },
  );
  const skip = new Set(expired.map((r) => r.id));
  return rows.map((r) => r.id).filter((id) => !skip.has(id));
}

/**
 * The applications on one job that already hold a SCORED card. Only the
 * queueing ORDER depends on this (unscoredFirst), never the count.
 */
export async function collectScoredApplicationIds(
  service: CollectClient,
  jobId: string,
  companyId: string,
): Promise<Set<string>> {
  const rows = await pageAllByKey<{ id: string; application_id: string }>(
    () =>
      service
        .from("application_scores")
        .select("id, application_id")
        .eq("job_id", jobId)
        .eq("company_id", companyId)
        .eq("status", "scored"),
    { scope: "rescore", label: "scored cards on the job" },
  );
  return new Set(rows.map((r) => r.application_id));
}
