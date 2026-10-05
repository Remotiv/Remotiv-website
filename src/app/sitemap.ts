import type { MetadataRoute } from "next";
import { listedOnRemotiv } from "@/lib/jobs";
import { pageAll } from "@/lib/supabase/paging";
import { createServiceClient } from "@/lib/supabase/server";
import { publicRemote, publicTalent } from "@/lib/talent-visibility";

const BASE_URL = "https://remotiv.work";

// Re-generate the sitemap at most once per hour. The DB call below makes
// the function dynamic; this revalidate caps how often Google can re-trigger
// that work. Newly-approved profiles appear in the sitemap within an hour —
// plenty fresh for Google's crawl cadence.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const supabase = createServiceClient();

  // ── Public talent and freelancer profiles ──────────────────
  //
  // Exactly the set /talent/[id] serves as public, because both read the same
  // predicate: publicTalent() and publicRemote() from lib/talent-visibility.
  // A paused, archived, unapproved or non-public-status profile can never be
  // advertised here, and those pages are noindex besides.
  //
  // Paged with pageAll. The previous version read each table in one request
  // and PostgREST returned the first 1,000 rows, so most profiles were silently
  // never advertised. A failed page throws rather than returning what it has,
  // and the whole profile block is then skipped and logged: a sitemap missing
  // profiles for an hour is honest, one missing an arbitrary slice of them is
  // not. Ordered by id so the pages tile the table without gaps or repeats.
  let profileEntries: MetadataRoute.Sitemap = [];
  try {
    type ProfileRow = { id: string; claimed_at: string | null; approved_at: string };
    const [talentRows, remoteRows] = await Promise.all([
      pageAll<ProfileRow>(
        (from, to) =>
          publicTalent(supabase.from("talent_profiles").select("id, claimed_at, approved_at"))
            .order("id")
            .range(from, to),
        { scope: "sitemap", label: "public talent profiles" },
      ),
      pageAll<ProfileRow>(
        (from, to) =>
          publicRemote(supabase.from("hire_remote_profiles").select("id, claimed_at, approved_at"))
            .order("id")
            .range(from, to),
        { scope: "sitemap", label: "public freelancer profiles" },
      ),
    ]);
    profileEntries = [...talentRows, ...remoteRows].map((r) => ({
      url: `${BASE_URL}/talent/${r.id}`,
      lastModified: new Date(r.claimed_at ?? r.approved_at),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch (err) {
    // A transient outage must not 500 the whole sitemap: the static pages and
    // jobs still go out, and the profiles return on the next regeneration.
    console.error("[sitemap] failed to fetch profile entries:", err);
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
    // Same graceful degradation as the profile block.
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
    ...profileEntries,
  ];
}
