import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { isEmptyScope, readJobScope } from "@/app/ai-dashboard/lib/job-scope";
import { isTipDismissed } from "@/app/ai-dashboard/lib/tip-state";
import { fetchManualTemplates } from "@/app/ai-dashboard/(gated)/messages/actions";
import { fetchApplicantCounts, fetchAssignableJobs, fetchCompanyApplicants } from "./actions";
import { ApplicantsClient } from "./_applicants-client";
import { loadApplicantsUsage } from "@/app/ai-dashboard/lib/company-usage-view";
import { QuotaBanner } from "./_quota-banner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Applicants — Remotiv AI Interviews" };

export default async function ApplicantsPage() {
  const [ctx, applicants, manualTemplates, assignableJobs, quota, counts] = await Promise.all([
    getCompanyContext(),
    fetchCompanyApplicants(),
    fetchManualTemplates(),
    // The roles the Add candidate form can file someone under. A separate read
    // because the list's own job filter is derived from the applicant rows, so
    // it cannot offer a job that has no applicants yet — which is exactly the
    // job you would be adding a first candidate to.
    fetchAssignableJobs(),
    // Owner, admin and recruiter, at 80% and 100% of a capped metric; null otherwise.
    loadApplicantsUsage(),
    /*
     * Every population figure the page states, counted in the database.
     *
     * In this wave rather than after it, which is the whole of the
     * no-added-latency claim: the nine head-counts resolve alongside the list
     * instead of behind it, so the first paint carries true numbers and the
     * browser makes no round trip to get them. The client re-reads them only
     * when the job filter moves or a mutation changes the population.
     */
    fetchApplicantCounts(),
  ]);

  /*
   * Distinguishes "this company has no applicants" from "you are on no jobs",
   * which look identical on screen and need opposite copy.
   *
   * readJobScope, not getJobScope: an unreadable hiring-team row would
   * otherwise collapse to the empty scope and this page would state, in the
   * table's own empty copy, that the reader is assigned to no roles — on
   * evidence it does not have. An unknown scope is NOT unassigned, so the flag
   * is false and `loadFailed` wins the empty-state chain instead, because the
   * same failure has already made the list unavailable.
   */
  const scopeRead = await readJobScope(ctx);
  const unassigned = scopeRead.ok && isEmptyScope(scopeRead.value);

  /*
   * Below the Promise.all rather than inside it: the read is keyed on
   * ctx.memberId, which that call is what produces. Every role sees it — the
   * score belongs to whoever reviews the applicant, not to a permission — and
   * a failed read answers "not dismissed", which shows the tip.
   */
  const showScoringTip = !(await isTipDismissed(ctx.memberId, "cv_scoring"));

  // The address the drawer's composer quotes back to the sender.
  const { data: replyRow } = await createServiceClient()
    .from("companies")
    .select("candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const replyToAddress =
    ((replyRow as { candidate_reply_email: string | null } | null)
      ?.candidate_reply_email ?? "").trim() || null;

  // `now` is handed to the client so its date formatters can render "2d ago"
  // identically on this pass and on the hydrating one. Reading the clock
  // independently in both places is what made every applicant row a hydration
  // mismatch.
  const applicantRows = applicants.ok ? applicants.value : [];
  // A failed read gives [], which disables the Add button — the honest state,
  // since a form that cannot name a job cannot file anyone under one.
  const addableJobs = assignableJobs.ok ? assignableJobs.value : [];
  const now = Date.now();

  return (
    <ApplicantsClient
      viewerRole={ctx.role}
      viewerMemberId={ctx.memberId}
      applicants={applicantRows}
      assignableJobs={addableJobs}
      loadFailed={!applicants.ok}
      // Null, not zeros: "0 applicants" over a company with two thousand of
      // them is believed instantly, because nothing about it looks broken.
      initialCounts={counts.ok ? counts.value : null}
      companyName={ctx.company.name}
      replyToAddress={replyToAddress}
      manualTemplates={manualTemplates}
      unassigned={unassigned}
      showScoringTip={showScoringTip}
      renderedAt={now}
      quotaBanner={quota && <QuotaBanner view={quota} />}
    />
  );
}
