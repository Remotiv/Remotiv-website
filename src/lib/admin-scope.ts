import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * What Remotiv admin is allowed to see in job_applications.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 *   company_id_snapshot IS NULL          Remotiv-owned. Always ours.
 *   company_id_snapshot = internal co.   Remotiv's OWN company account. Ours.
 *   company_id_snapshot = customer co.   Theirs. NEVER visible in admin.
 *
 * Before this, admin filtered on `IS NULL` alone, which was right for customers
 * and wrong for Remotiv's own company account — its applications were invisible
 * to the very team that owns them, while still (correctly) showing in its
 * /ai-dashboard. This widens admin by exactly the internal set and nothing else.
 *
 * ── Why a lookup rather than a column ────────────────────────
 *
 * The alternative was denormalising `is_internal` onto job_applications at
 * apply time, mirroring company_id_snapshot. Rejected:
 *
 *   - It needs a column AND a backfill, and the backfill has to be re-run every
 *     time a company's is_internal flips. A snapshot is correct for things that
 *     are TRUE AT APPLY TIME and must never move (which company owned this
 *     application). "Is this company ours?" is not that — it is current truth
 *     about the company, and freezing it is the same denormalised-identity bug
 *     as company_members.name and jobs.company.
 *   - Marking a company internal would silently fail to reveal its existing
 *     applications until someone remembered to backfill.
 *
 * The lookup has none of that and costs one tiny indexed query per request,
 * memoised below. The internal set is expected to hold exactly one row forever.
 */

/** Applications whose company is internal are admin-visible; customers are not. */
const SCOPE_COLUMN = "company_id_snapshot";

/** Remotiv-owned only. The value this returns when anything goes wrong. */
const REMOTIV_OWNED_ONLY = `${SCOPE_COLUMN}.is.null`;

/**
 * Internal-company ids change approximately never, so a short process-level
 * memo removes the per-query round trip without risking a stale flag outliving
 * a deploy. Deliberately NOT React `cache()` — half these call sites are API
 * routes, which have no React request scope.
 */
const MEMO_TTL_MS = 60_000;
let memo: { ids: string[]; at: number } | null = null;

async function internalCompanyIds(): Promise<string[]> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.ids;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .eq("is_internal", true);

  if (error) {
    // FAIL CLOSED. A failed lookup must never widen what admin can see, so we
    // fall back to the old Remotiv-only rule rather than to "no filter".
    console.error("[admin-scope] internal company lookup failed — falling back to Remotiv-owned only", error.message);
    return [];
  }

  const ids = (data ?? []).map((r) => (r as { id: string }).id).filter(Boolean);
  memo = { ids, at: Date.now() };
  return ids;
}

/**
 * The PostgREST `or=` filter for every admin read/write of job_applications.
 *
 * Always applied through `.or(...)` so all 18 call sites take the identical
 * shape — `.or("company_id_snapshot.is.null")` is valid on its own, so the
 * no-internal-companies case needs no branch at the call site.
 *
 * A customer application matches NEITHER disjunct: its snapshot is non-null, and
 * its company id is not in the internal set. That is the whole safety argument,
 * and it degrades safely — an empty internal set collapses to exactly the
 * pre-existing behaviour.
 */
export async function adminApplicationScope(): Promise<string> {
  const ids = await internalCompanyIds();
  if (ids.length === 0) return REMOTIV_OWNED_ONLY;
  return `${REMOTIV_OWNED_ONLY},${SCOPE_COLUMN}.in.(${ids.join(",")})`;
}

/** Test seam: drop the memo so a flag change is picked up immediately. */
export async function resetAdminScopeMemo(): Promise<void> {
  memo = null;
}
