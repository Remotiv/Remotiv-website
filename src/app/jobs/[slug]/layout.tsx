import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getJobBySlug } from "@/lib/jobs";
import { RoleUnavailable } from "./_unavailable";

/**
 * Exists for one reason: a real 404 for a role that is gone.
 *
 * ── Why the page could not do this ───────────────────────────
 *
 * This segment has a loading.tsx, and a loading boundary starts streaming the
 * response — which commits `200 OK` before the page runs. A notFound() from
 * the page after that point cannot change the status; Next injects a
 * `noindex` into the streamed body instead. Google honours the noindex, but
 * every CLOSED role — the URLs that were actually shared — kept answering 200
 * to aggregators and to anything that keys on status. Next's own docs: settle
 * existence "before those boundaries and before any await that may suspend".
 *
 * A layout renders OUTSIDE its segment's loading boundary, so a notFound()
 * here is a genuine 404 and the skeleton still covers the page's remaining
 * work (counts, the company lookup) exactly as before. Yesterday's footer
 * fix is unaffected: while this awaits, nothing paints at all — no skeleton,
 * and no footer to show first.
 *
 * ── Three answers, and the middle one must not become a 404 ──
 *
 * getJobBySlug returns a Read: the role, no role, or "could not ask". Only
 * the second is a 404. The third renders the unavailable state and stops —
 * a database blip must not tell the world a live role is gone, and must not
 * be indexed as one either (generateMetadata marks it noindex from the same
 * memoised answer, so the two cannot disagree).
 *
 * The status for that third case is still 200. There is no `unavailable()`
 * counterpart to notFound() that a layout could throw for a 503, and lying
 * with a 404 would be the exact harm this file exists to prevent. A 200 with
 * noindex is the least wrong status a render can produce for "try again".
 *
 * ── Cost ─────────────────────────────────────────────────────
 *
 * None net. getJobBySlug is cache()-memoised per request, and generateMetadata
 * and the page were already fetching it twice; the layout's call is the same
 * single query, now shared three ways.
 */
/**
 * Titles for the two answers that never reach the page.
 *
 * When this layout throws notFound() — or renders the unavailable state — the
 * page below it never renders, and neither does ITS generateMetadata. Without
 * this, a dead role's 404 was titled by /jobs/layout.tsx: "Jobs at Remotiv —
 * Find Your Next Remote Role", which is a claim the page is simultaneously
 * denying. Same cache()'d read, so the title and the status cannot disagree.
 *
 * A live role returns nothing here on purpose: the page's own generateMetadata
 * runs in that case and owns title, description, OG and canonical.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const read = await getJobBySlug(slug);
  if (!read.ok)
    return { title: "Role couldn't be loaded", robots: { index: false, follow: false } };
  if (read.value === null) {
    return { title: "Job not found — Remotiv", robots: { index: false, follow: false } };
  }
  return {};
}

export default async function JobSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const read = await getJobBySlug(slug);

  if (!read.ok) return <RoleUnavailable />;
  if (read.value === null) notFound();

  return children;
}
