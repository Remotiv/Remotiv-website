import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { isEmptyScope, readJobScope } from "@/app/ai-dashboard/lib/job-scope";
import { isTipDismissed } from "@/app/ai-dashboard/lib/tip-state";
import { fetchManualTemplates } from "@/app/ai-dashboard/(gated)/messages/actions";
import {
  fetchApplicantCounts,
  fetchAssignableJobs,
  fetchCompanyApplicants,
  fetchTopScoredApplicants,
} from "./actions";
import { ApplicantsClient } from "./_applicants-client";
import { decodeListUrl, listParamsFrom, listQueryFor } from "./list-state";
import { loadApplicantsUsage } from "@/app/ai-dashboard/lib/company-usage-view";
import { QuotaBanner } from "./_quota-banner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Applicants — Remotiv AI Interviews" };

export default async function ApplicantsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /*
   * The first paint answers the URL, not the defaults.
   *
   * Without this the server read page 1 of everybody and the client then
   * re-read whatever the query string actually asked for — so a refresh on
   * page 7 of a filtered list painted the unfiltered first page, and replaced
   * it a round trip later. Harmless when the browser held the whole
   * population and re-filtering was free; a visible wrong answer now that the
   * rows ARE the response.
   *
   * Decoded by the same codec the client uses, which is the point of its
   * living in list-state.ts: a second reading of the same query string here
   * would drift, and the drift would show up as a first paint that disagrees
   * with the URL that produced it, then silently corrects itself.
   *
   * `searchParams` is a plain object rather than a URLSearchParams, and
   * `listParamsFrom` is the wrapping — in list-state.ts with the codec, so the
   * whole refresh path is one tested function rather than a conversion here
   * and a decode there.
   */
  const served = decodeListUrl(listParamsFrom(await searchParams));
  const servedQuery = listQueryFor(served.request);

  const [ctx, applicants, topScored, manualTemplates, assignableJobs, quota, counts] =
    await Promise.all([
      getCompanyContext(),
      /*
       * ONE page, ordered in the database, for the filters the URL states.
       *
       * The whole population used to come down here and the browser did the
       * filtering, the sorting and the paging. It cannot: PostgREST caps a
       * response at 1,000 rows, measured, so past that size the page was
       * sorting a truncated set and presenting it as the best candidates.
       */
      fetchCompanyApplicants(servedQuery),
      /*
       * The ten best scored applicants, for "Review top 10" and the "Top
       * match" chips.
       *
       * Its own query rather than a slice of the list, because both are claims
       * about the whole population and the list is now one page of it. In the
       * server wave rather than on demand so the chips are right on first
       * paint instead of appearing a round trip later.
       */
      fetchTopScoredApplicants(servedQuery),
      fetchManualTemplates(),
      /*
       * The company's roles — what the Add candidate form files someone under,
       * and now also what the list's job filter offers.
       *
       * It used to be a separate read only because the filter was derived from
       * the loaded applicant rows and so could not name a job with no
       * applicants yet. That derivation is gone: the rows are one page, and a
       * filter built from them would offer whichever handful of jobs happened
       * to appear on it.
       */
      fetchAssignableJobs(),
      // Owner, admin and recruiter, at 80% and 100% of a capped metric; null otherwise.
      loadApplicantsUsage(),
      /*
       * Every population figure the page states, counted in the database.
       *
       * In this wave rather than after it, which is the whole of the
       * no-added-latency claim: the ten head-counts resolve alongside the list
       * instead of behind it, so the first paint carries true numbers and the
       * browser makes no round trip to get them. The client re-reads them only
       * when the job filter moves or a mutation changes the population.
       *
       * The job filter alone, not the whole query: these are figures about a
       * population, and the stage tab, the flag chip and the search are what
       * the reader narrows WITHIN it. Passing them would filter the stage
       * counts by stage. counts-state.ts's `countsKey` keys on the same one
       * field for the same reason.
       */
      fetchApplicantCounts(served.request.jobId ? { jobId: served.request.jobId } : {}),
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
  /*
   * Null, not [], on a failed read.
   *
   * The client seeds its list state from this, and `seedList` reads null as
   * "the read failed" rather than "there is nobody" — which an empty array
   * cannot distinguish, because a company with no applicants and a database
   * that did not answer render the same table. The empty copy branches on it.
   */
  const initialPage = applicants.ok ? applicants.value : null;
  // Same distinction, and the chips are the stake: [] would silently mean "no
  // one scored above 90" when in fact nothing was read.
  const initialTopScored = topScored.ok ? topScored.value : null;
  // A failed read gives [], which disables the Add button — the honest state,
  // since a form that cannot name a job cannot file anyone under one.
  const addableJobs = assignableJobs.ok ? assignableJobs.value : [];
  const now = Date.now();

  return (
    <ApplicantsClient
      viewerRole={ctx.role}
      viewerMemberId={ctx.memberId}
      initialPage={initialPage}
      /*
       * WHICH request `initialPage` answers.
       *
       * The client skips its mount fetch by comparing the request it renders
       * against this one, so a hardcoded "no filters, page 1" here would make
       * that comparison a lie the moment the URL carried a filter: the client
       * would conclude it already had the right rows and show page 1 of
       * everybody under a filled-in toolbar. Handing over what was actually
       * read keeps the skip correct for every URL, including the ones that
       * match the defaults.
       */
      servedRequest={served.request}
      initialTopScored={initialTopScored}
      assignableJobs={addableJobs}
      // No `loadFailed` prop: `initialPage === null` already carries it, the
      // client's `seedList` reads it as a failure, and every later filter move
      // is its own read that can fail on its own. One field, no drift.
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
