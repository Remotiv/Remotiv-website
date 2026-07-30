import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { fetchCompanyJobs } from "./actions";
import { JobsClient } from "./_jobs-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs — Remotiv AI Interviews" };

export default async function JobsPage() {
  const [ctx, jobs] = await Promise.all([getCompanyContext(), fetchCompanyJobs()]);

  return <JobsClient viewerRole={ctx.role} jobs={jobs} />;
}
