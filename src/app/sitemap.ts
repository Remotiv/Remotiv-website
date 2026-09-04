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
  let talentEntries: MetadataRoute.Sitemap = [];

  try {
    const [pakResult, remoteResult] = await Promise.all([
      supabase
        .from("talent_profiles")
        .select("id, claimed_at, approved_at")
        .not("approved_at", "is", null),
      supabase
        .from("hire_remote_profiles")
        .select("id, claimed_at, approved_at")
        .not("approved_at", "is", null),
    ]);

    const pakRows = (pakResult.data ?? []) as Array<{
      id: string;
      claimed_at: string | null;
      approved_at: string;
    }>;
    const remoteRows = (remoteResult.data ?? []) as Array<{
      id: string;
      claimed_at: string | null;
      approved_at: string;
    }>;

    talentEntries = [...pakRows, ...remoteRows].map((r) => ({
      url: `${BASE_URL}/talent/${r.id}`,
      lastModified: new Date(r.claimed_at ?? r.approved_at),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch (err) {
    // Graceful degradation: a transient Supabase outage must not 500 the
    // entire sitemap. Log and proceed with static-only entries — Google
    // still gets a valid sitemap covering the marketing pages.
    console.error("[sitemap] failed to fetch talent entries:", err);
  }

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
    ...talentEntries,
    ...jobEntries,
  ];
}
