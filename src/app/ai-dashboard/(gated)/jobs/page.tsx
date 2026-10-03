import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { JobsClient } from "./_jobs-client";
import { fetchCompanyJobs, fetchDeletedCompanyJobs } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs — Remotiv AI Interviews" };

export default async function JobsPage() {
  // Tombstones are fetched here rather than on demand so the Deleted button can
  // carry a count without a round trip, and they stay in their own prop so no
  // tab count can ever see one.
  const [ctx, jobs, deletedJobs] = await Promise.all([
    getCompanyContext(),
    fetchCompanyJobs(),
    fetchDeletedCompanyJobs(),
  ]);

  // `loadFailed` rather than an empty list: "No jobs yet — post your first
  // role" over a workspace that has roles invites a duplicate posting.
  return (
    <JobsClient
      viewerRole={ctx.role}
      jobs={jobs.ok ? jobs.value : []}
      deletedJobs={deletedJobs.ok ? deletedJobs.value : []}
      loadFailed={!jobs.ok}
    />
  );
}
