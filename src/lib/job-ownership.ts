/**
 * Is Remotiv the employer on this job?
 *
 * ── Why this is its own module ───────────────────────────────
 *
 * It belongs in lib/jobs.ts beside the data it reads, and it cannot live there.
 * That module pulls in `next/headers` through createServiceClient, so a client
 * component importing a VALUE from it fails the build — the same constraint
 * that put resolveNumericMode in lib/screening.ts, and the reason lib/jobs.ts
 * carries a comment saying so. One of the two callers here is the /jobs list,
 * which is `"use client"`.
 *
 * So: the rule lives in a module with no runtime imports, and lib/jobs.ts
 * re-exports it, exactly as it re-exports resolveNumericMode. Server callers
 * keep one import site; the client imports it directly from here.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 * THE one predicate. The /jobs list and the editorial detail page both gate the
 * star rating on it, and they used to disagree: the detail page asked whether
 * the company was internal, the list asked only whether there was a company at
 * all. Remotiv's dashboard-posted roles showed a star on one surface and not
 * the other. Both now read the same derived field from the same batch query.
 *
 * Two ways to be Remotiv's, and both count:
 *
 *   company_id === null     posted through admin. No company row exists, so it
 *                           takes no part in the company batch fetch and
 *                           `company_is_internal` is false — this disjunct is
 *                           the whole answer for those.
 *   company_is_internal     posted through /ai-dashboard on Remotiv's own
 *                           account, which is a companies row like any other.
 *
 * A CLIENT's job is neither, including when its company row could not be read:
 * attachCompanyData swallows that failure and leaves the flag false, so the
 * rating stays hidden rather than being fabricated for someone else's company.
 * That direction matters — the number is hand-entered about Remotiv, and
 * showing it on a client's card would be a claim about them that nothing
 * supports.
 */
export function isRemotivOwned(job: {
  company_id: string | null;
  company_is_internal?: boolean;
}): boolean {
  return job.company_id === null || job.company_is_internal === true;
}
