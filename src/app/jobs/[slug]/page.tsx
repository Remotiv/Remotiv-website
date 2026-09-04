import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getJobBySlug, type Job } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";
import { getJobCompany, isInternalCompany } from "./_company-data";
import { CompanyJobDetail } from "./_company-detail";
import { RemotivJobDetail } from "./_remotiv-detail";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const read = await getJobBySlug(slug);

  // A failed lookup must not be titled "not found" — that is a claim about the
  // role, and we do not know anything about the role. Both stay out of the
  // index: one because it is gone, one because it is a transient error page.
  if (!read.ok) {
    return { title: "Role couldn't be loaded", robots: { index: false, follow: false } };
  }
  const job = read.value;
  if (!job) {
    return { title: "Job not found — Remotiv", robots: { index: false, follow: false } };
  }

  const title = `${job.title} — ${job.company} | Remotiv`;
  const description = job.description
    ? `${job.description.slice(0, 150).replace(/\s+/g, " ").trim()}…`
    : `${job.title} at ${job.company}. Apply on Remotiv — remote roles for Pakistan's top vetted talent, hired by companies worldwide.`;
  const url = `/jobs/${slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Remotiv", locale: "en_US", type: "website" },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

async function fetchCounts(jobId: string): Promise<{ total: number; thisWeek: number }> {
  try {
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
    return { total: totalRes.count ?? 0, thisWeek: weekRes.count ?? 0 };
  } catch {
    // Counts are decorative — never crash the page on a transient error.
    return { total: 0, thisWeek: 0 };
  }
}

/**
 * One route, two designs — chosen by who owns the job.
 *
 * `company_id` is the tenant column: non-null means a company posted this
 * through /ai-dashboard, null means it is Remotiv's own. A company's job gets
 * the approved white-label page, branded to that company. Remotiv's keeps the
 * editorial page it has always had, unchanged.
 *
 * The branch falls back to the Remotiv rendering whenever the company cannot be
 * resolved — missing, paused or archived, or a transient lookup failure. That
 * is the safe direction: the job posting itself is still valid and public, and
 * rendering it without white-label chrome is a smaller wrong than 500ing a live
 * job ad or dressing it in a paused customer's branding.
 *
 * `client_id` jobs (the client portal) are not company jobs and take the
 * Remotiv path too — the white-label design is bound to the companies table.
 */
/**
 * Shown when the role could not be READ, never when it is missing.
 *
 * Deliberately unbranded. This renders before the Remotiv/white-label branch,
 * so it cannot know whose page it is standing in for — anything naming a
 * company here would be wrong half the time.
 */
function RoleUnavailable() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-24 text-center">
      <h1 className="font-heading text-2xl font-bold text-gray-900">This role didn't load</h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        Something went wrong fetching it — the role itself is fine. Refresh the page, or try again
        in a moment.
      </p>
    </main>
  );
}

export default async function JobDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const read = await getJobBySlug(slug);

  /*
   * Three answers, not two.
   *
   * `notFound()` used to serve a database failure as well as a deleted job, so
   * a live role told the reader it no longer existed — and nobody refreshes a
   * 404. The copy below names no company, because at this point we do not know
   * whose role it is: the white-label branch happens further down.
   */
  if (!read.ok) return <RoleUnavailable />;

  const job: Job | null = read.value;
  if (!job) notFound();

  const { total, thisWeek } = await fetchCounts(job.id);

  const company = job.company_id ? await getJobCompany(job.company_id, job.id) : null;

  if (company) {
    return <CompanyJobDetail job={job} company={company} total={total} />;
  }

  /*
   * Reaching the editorial page does NOT by itself mean the role is Remotiv's.
   *
   * getJobCompany returns null for four different reasons (see its note), and
   * only two of them — no company at all, or an internal one — mean Remotiv is
   * the employer. The other two are a client whose company row is paused,
   * archived or unreadable, and that client's job must not be handed Remotiv's
   * hand-entered star rating on the way past.
   *
   * So the fact is computed HERE, where both halves are in scope, and passed
   * down. The renderer has only the job, and `company_id === null` is no longer
   * the whole answer to "is this ours?".
   */
  const remotivOwned = job.company_id === null || (await isInternalCompany(job.company_id));

  return (
    <RemotivJobDetail job={job} total={total} thisWeek={thisWeek} remotivOwned={remotivOwned} />
  );
}
