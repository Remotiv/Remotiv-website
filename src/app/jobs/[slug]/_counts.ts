import { unstable_cache } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The public job page's two applicant counts (#82).
 *
 * The page is force-dynamic, so these ran on every view: two head counts on a
 * column with no index of its own. They are now cached per job for five
 * minutes. A five-minute-old "N so far" is fine on a public ad.
 *
 * Null means unknown, never zero: the page hides a figure it could not read
 * rather than telling a visitor nobody has applied.
 */
export type PublicJobCounts = { total: number | null; thisWeek: number | null };

export const PUBLIC_COUNTS_REVALIDATE_SECONDS = 300;

const UNKNOWN: PublicJobCounts = { total: null, thisWeek: null };

/**
 * Throws on any failure, so a failed read never returns a value for the cache
 * to keep: the next view asks again instead of showing a cached wrong number.
 */
async function readCounts(jobId: string): Promise<{ total: number; thisWeek: number }> {
  const supabase = createServiceClient();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [totalRes, weekRes] = await Promise.all([
    supabase
      .from("job_applications")
      .select("*", { count: "exact", head: true })
      .eq("job_id", jobId),
    supabase
      .from("job_applications")
      .select("*", { count: "exact", head: true })
      .eq("job_id", jobId)
      .gte("created_at", weekAgo),
  ]);
  if (totalRes.error || weekRes.error || totalRes.count === null || weekRes.count === null) {
    throw new Error(
      `public job counts: ${totalRes.error?.code ?? weekRes.error?.code ?? "no count"}`,
    );
  }
  return { total: totalRes.count, thisWeek: weekRes.count };
}

// The job id is the argument, so it is part of the cache key (unstable_cache
// keys on its arguments); the key part names this cache among the others.
const cachedCounts = unstable_cache(readCounts, ["public-job-counts"], {
  revalidate: PUBLIC_COUNTS_REVALIDATE_SECONDS,
});

export async function fetchPublicJobCounts(jobId: string): Promise<PublicJobCounts> {
  try {
    return await cachedCounts(jobId);
  } catch (err) {
    console.error(
      "[jobs] public counts unavailable:",
      err instanceof Error ? err.message : "error",
    );
    return UNKNOWN;
  }
}
