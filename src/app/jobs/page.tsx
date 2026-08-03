import type { Metadata } from "next";
import { getInitialJobs } from "@/lib/jobs";
import { canonicalUrl } from "@/lib/seo";
import { JobsClient } from "./_jobs-client";
import { fetchCompanyJobs, resolveCompanySlug } from "./company-filter";

// Without this, Next would statically prerender the page at BUILD TIME and
// freeze the jobs list until the next deploy. The prior implementation (full
// client fetch on every visit) always showed live data — keep that behavior
// by forcing the server component to re-render per request. The Supabase
// query in getInitialJobs() runs on each request.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ company?: string }>;

/**
 * SEO for the filtered view: NOINDEX, follow — with a SELF canonical.
 *
 * `/jobs?company=acme` is a thin duplicate. It renders the same template and
 * the same job cards as /jobs, with no company logo, description or story of
 * its own; indexing it would put a near-copy of /jobs into the index competing
 * with both /jobs and each /jobs/[slug] detail page for the same content. When
 * the real /careers/[slug] page exists — brand, description, only their roles —
 * THAT is worth indexing, and this URL can redirect to it.
 *
 * `follow` is deliberate: this page shouldn't rank, but the job links on it
 * should still be crawled and the detail pages indexed as normal.
 *
 * The canonical stays SELF-referential rather than pointing at /jobs. Google
 * treats noindex plus a cross-URL canonical as contradictory signals ("don't
 * index this" and "credit this to that") and may honour either. noindex alone
 * expresses the intent exactly, so the canonical is left doing its ordinary job
 * of naming this URL's own preferred form.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { company: slug } = await searchParams;
  const company = await resolveCompanySlug(slug);

  // Unknown slug → this IS the full list, so it inherits the layout's
  // indexable metadata untouched.
  if (!company) return {};

  const path = `/jobs?company=${encodeURIComponent(company.slug)}`;
  const title = `Jobs at ${company.name} — Remotiv`;
  const description = `Open roles at ${company.name}, hiring through Remotiv. Apply directly.`;

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl(path) },
    robots: { index: false, follow: true },
    openGraph: { title, description, url: canonicalUrl(path), type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { company: slug } = await searchParams;
  const company = await resolveCompanySlug(slug);

  const initialJobs = company
    ? await fetchCompanyJobs(company.id)
    : await getInitialJobs();

  return <JobsClient initialJobs={initialJobs} company={company} />;
}
