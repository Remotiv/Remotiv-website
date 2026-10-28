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
 * Every application on one job, selected by BOTH job_id and the company
 * snapshot so a mismatched snapshot can never be swept in. Throws on a
 * failed page; the caller turns that into its own failure.
 */
export async function collectJobApplicationIds(
  service: CollectClient,
  jobId: string,
  companyId: string,
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
  return rows.map((r) => r.id);
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
