import type { MetadataRoute } from "next";
import { listedOnRemotiv } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";

const BASE_URL = "https://remotiv.work";

// Re-generate the sitemap at most once per hour. The DB call below makes
// the function dynamic; this revalidate caps how often Google can re-trigger
// that work. Newly-approved profiles appear in the sitemap within an hour —
// plenty fresh for Google's crawl cadence.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const supabase = createServiceClient();

  // ── Talent profiles are NOT advertised here ─────────────────
  //
  // This block used to emit one URL per approved profile in both pools. It is
  // gone on purpose: the pages now carry `robots: { index: false }`, and a
  // sitemap that submits URLs we are asking not to be indexed works against
  // itself. Removing them here is the other half of that change.
  //
  // Two things this deliberately does NOT do. It does not add /talent/ to
  // robots.ts - a disallow would stop crawlers fetching the pages, so they
  // would never see the noindex and the already-indexed URLs would stay
  // indexed. And it does not touch the 1000-row page cap that was silently
  // limiting this list: with profiles removed the cap no longer affects them,
  // and fixing it now would be fixing the wrong thing first.

  let jobEntries: MetadataRoute.Sitemap = [];
  try {
    // A non-visible job 404s on /jobs/[slug], so leaving it in the sitemap
    // would submit a dead URL to every crawler that reads this file.
    // Only board-listed roles are indexed. An unlisted job still has a working
    // URL for the company to share — it is simply not advertised by us.
    const { data } = await listedOnRemotiv(supabase.from("jobs").select("id, slug, created_at"));
    const rows = (data ?? []) as Array<{
      id: string;
      slug: string | null;
      created_at: string;
    }>;
    jobEntries = rows.map((r) => ({
      url: `${BASE_URL}/jobs/${r.slug ?? r.id}`,
      lastModified: new Date(r.created_at),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch (err) {
    // Same graceful degradation as the talent block.
    console.error("[sitemap] failed to fetch job entries:", err);
  }

  return [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/ai-matching`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/join-as-talent`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/book-a-meeting`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/browse-talent`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/contact`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/find-freelancers`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/jobs`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/join-as-freelancer`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${BASE_URL}/services/recruitment`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/services/staff-augmentation`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/services/dedicated-team`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/services/payroll`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    ...jobEntries,
  ];
}
