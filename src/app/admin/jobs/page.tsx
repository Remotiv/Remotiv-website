import { createClient, createServiceClient } from "@/lib/supabase/server";
import { JobsDashboard } from "../_components/jobs-dashboard";
import type { Job } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminJobsPage() {
  const [supabase, service] = await Promise.all([
    createClient(),
    Promise.resolve(createServiceClient()),
  ]);

  const [{ data: { user } }, { data: jobs }] = await Promise.all([
    supabase.auth.getUser(),
    service
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  return (
    <JobsDashboard
      email={user?.email ?? ""}
      initialJobs={(jobs ?? []) as Job[]}
    />
  );
}
