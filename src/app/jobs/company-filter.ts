import "server-only";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { attachCompanyLogos, LIST_SELECT, publiclyVisible, type Job } from "@/lib/jobs";

/**
 * The company behind `/jobs?company=<slug>`.
 *
 * Slug rather than id on purpose: the link is handed to a company to share, so
 * it has to be readable, and a UUID in a shareable URL leaks an internal
 * identifier for no benefit. companies.slug already exists and is unique.
 */
export type CompanyFilter = {
  id: string;
  name: string;
  slug: string;
};

/**
 * Resolve a slug to a company, or null.
 *
 * Returns null for a missing, empty, unknown or non-active slug — the caller
 * then renders the FULL list rather than an error or an empty state.
 *
 * That fallback is deliberate. This URL is meant to be pasted into emails and
 * job ads, where it will be truncated, re-typed and eventually left pointing at
 * a renamed or deleted company. A dead careers link that quietly shows every
 * open role is a mildly wrong page; a 404 or a blank "no jobs" screen is a lost
 * candidate. The page is a jobs board either way, so degrading to the superset
 * is both safe and useful.
 */
export async function resolveCompanySlug(
  slug: string | undefined,
): Promise<Read<CompanyFilter | null>> {
  const trimmed = (slug ?? "").trim();
  // Answers, both: no slug asked for, and a slug too long to be one.
  if (!trimmed || trimmed.length > 200) return answered(null);

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, slug, status")
    .eq("slug", trimmed)
    // A suspended company's roles should not get a branded landing page. Their
    // individual jobs are already gated by status='open' further down, so this
    // only decides whether the page is BRANDED, never what is visible.
    .eq("status", "active")
    .maybeSingle();

  /*
   * A failed lookup must NOT degrade to "no filter".
   *
   * Returning null here sent the page down the getInitialJobs branch — the
   * UNFILTERED board — so a visitor who asked for one company's roles was
   * silently shown every company's, with ?company=… still in the address bar.
   * Every other read in this family under-reports on failure; this one
   * over-reports, which is the harder one to notice.
   */
  if (error) {
    console.error("[jobs] resolveCompanySlug failed:", error.message);
    return unavailable();
  }

  // Asked and answered: no such company, or one with no slug to brand with.
  const row = data as { id: string; name: string | null; slug: string | null } | null;
  if (!row?.slug) return answered(null);
  return answered({
    id: row.id,
    name: (row.name ?? "").trim() || "This company",
    slug: row.slug,
  });
}

/**
 * That company's published jobs.
 *
 * publiclyVisible (status = 'open' AND archived_at IS NULL) is the only thing
 * standing between a shareable slug and a company's drafts. 'on_hold' is the
 * product's Draft and 'closed' is a retired role — neither may ever be
 * reachable through this URL, and archived roles are records, not listings.
 *
 * Ordering matches getInitialJobs so a filtered list and the full list present
 * the same job in the same relative position.
 */
export async function fetchCompanyJobs(companyId: string): Promise<Read<Job[]>> {
  const supabase = createServiceClient();
  const { data, error } = await publiclyVisible(
    supabase.from("jobs").select(LIST_SELECT).eq("company_id", companyId),
  )
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  // Same contract as getInitialJobs, which now means the same THREE answers:
  // these roles, no roles, or we could not look.
  if (error) {
    console.error("[jobs] fetchCompanyJobs failed:", error.message);
    return unavailable();
  }
  return answered(await attachCompanyLogos((data ?? []) as unknown as Job[]));
}
