import { createClient, createServiceClient } from "@/lib/supabase/server";
import { JobsDashboard } from "../_components/jobs-dashboard";
import type { Job } from "./actions";
import type { UserRole } from "../lib/roles";

export const dynamic = "force-dynamic";

export default async function AdminJobsPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";

  const [{ data: jobs }, { data: roleRow }] = await Promise.all([
    service
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  const userRole = (roleRow?.role ?? "viewer") as UserRole;

  return (
    <JobsDashboard
      email={user?.email ?? ""}
      userRole={userRole}
      initialJobs={(jobs ?? []) as Job[]}
    />
  );
}
