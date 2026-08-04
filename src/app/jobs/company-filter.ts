import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { attachCompanyLogos, LIST_SELECT, type Job } from "@/lib/jobs";

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
): Promise<CompanyFilter | null> {
  const trimmed = (slug ?? "").trim();
  if (!trimmed || trimmed.length > 200) return null;

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

  if (error || !data) return null;

  const row = data as { id: string; name: string | null; slug: string | null };
  if (!row.slug) return null;
  return { id: row.id, name: (row.name ?? "").trim() || "This company", slug: row.slug };
}

/**
 * That company's published jobs.
 *
 * `status = 'open'` is repeated here rather than inherited from anywhere: it is
 * the only thing standing between a shareable slug and a company's drafts.
 * 'on_hold' is the product's Draft and 'closed' is a retired role — neither may
 * ever be reachable through this URL.
 *
 * Ordering matches getInitialJobs so a filtered list and the full list present
 * the same job in the same relative position.
 */
export async function fetchCompanyJobs(companyId: string): Promise<Job[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(LIST_SELECT)
    .eq("company_id", companyId)
    .eq("status", "open")
    // Same rule as the full list: archived roles are records, not listings.
    .is("archived_at", null)
    .order("display_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  // Same contract as getInitialJobs: never crash the page on a transient
  // Supabase error, fall back to an empty list.
  if (error) return [];
  return attachCompanyLogos((data ?? []) as unknown as Job[]);
}
