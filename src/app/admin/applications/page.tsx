import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ApplicationsDashboard } from "@/app/admin/_components/applications-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import type { JobApplication, OpenJob } from "./actions";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const { search: initialSearch } = await searchParams;

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: apps }, { data: jobs }, { data: roleRow }] = await Promise.all([
    service
      .from("job_applications")
      .select("*, jobs(title)")
      .order("created_at", { ascending: false }),
    service
      .from("jobs")
      .select("id, title")
      .eq("status", "open")
      .order("title", { ascending: true }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  const applications: JobApplication[] = (apps ?? []).map((a: Record<string, unknown>) => ({
    id: a.id as string,
    job_id: a.job_id as string | null,
    first_name: a.first_name as string,
    last_name: a.last_name as string,
    email: a.email as string,
    phone: a.phone as string,
    linkedin_url: (a.linkedin_url as string | null) ?? null,
    cv_url: a.cv_url as string,
    status: a.status as JobApplication["status"],
    source: ((a.source as JobApplication["source"]) ?? "job_application"),
    notes: (a.notes as string | null) ?? null,
    created_at: a.created_at as string,
    job_title: (a.jobs as { title?: string } | null)?.title ?? null,
  }));

  const openJobs: OpenJob[] = (jobs ?? []) as OpenJob[];

  return (
    <ApplicationsDashboard
      email={userEmail}
      userRole={userRole}
      initialApplications={applications}
      openJobs={openJobs}
      initialSearch={initialSearch ?? ""}
    />
  );
}
