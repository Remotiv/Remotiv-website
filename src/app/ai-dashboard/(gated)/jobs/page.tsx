import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { JobsClient } from "./_jobs-client";
import { fetchCompanyJobs } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs — Remotiv AI Interviews" };

export default async function JobsPage() {
  const [ctx, jobs] = await Promise.all([getCompanyContext(), fetchCompanyJobs()]);

  // `loadFailed` rather than an empty list: "No jobs yet — post your first
  // role" over a workspace that has roles invites a duplicate posting.
  return (
    <JobsClient viewerRole={ctx.role} jobs={jobs.ok ? jobs.value : []} loadFailed={!jobs.ok} />
  );
}
