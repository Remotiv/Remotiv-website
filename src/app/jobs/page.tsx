import { getInitialJobs } from "@/lib/jobs";
import { JobsClient } from "./_jobs-client";

// Without this, Next would statically prerender the page at BUILD TIME and
// freeze the jobs list until the next deploy. The prior implementation (full
// client fetch on every visit) always showed live data — keep that behavior
// by forcing the server component to re-render per request. The Supabase
// query in getInitialJobs() runs on each request.
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const initialJobs = await getInitialJobs();
  return <JobsClient initialJobs={initialJobs} />;
}
