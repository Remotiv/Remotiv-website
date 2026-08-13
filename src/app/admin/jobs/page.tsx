import { createClient, createServiceClient } from "@/lib/supabase/server";
import { JobsDashboard } from "../_components/jobs-dashboard";
import type { Job } from "./actions";
import { type UserRole, isSuperAdminEmail } from "../lib/roles";

export const dynamic = "force-dynamic";

export default async function AdminJobsPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: jobs }, { data: roleRow }] = await Promise.all([
    service
      .from("jobs")
      .select("*")
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (isSuperAdminEmail(userEmail)) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <JobsDashboard
      email={userEmail}
      userRole={userRole}
      initialJobs={(jobs ?? []) as Job[]}
    />
  );
}
