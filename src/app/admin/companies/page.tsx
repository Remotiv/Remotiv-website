import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { CompaniesDashboard } from "@/app/admin/_components/companies-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { fetchCompanies, fetchQueueHealth } from "./actions";
import { QueuePanel } from "./_queue-panel";

export const dynamic = "force-dynamic";

export default async function AdminCompaniesPage() {
  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const userId = user.id;
  const userEmail = user.email ?? "";

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else {
    const { data: roleRow } = await service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleRow?.role) userRole = roleRow.role as UserRole;
  }

  if (userRole !== "super_admin") {
    redirect("/admin");
  }

  // Both reads are already behind requireSuperAdmin(); the redirect above is
  // navigation polish, not the gate.
  const [companies, queue] = await Promise.all([
    fetchCompanies(),
    fetchQueueHealth(),
  ]);

  return (
    <>
      <CompaniesDashboard
        email={userEmail}
        userRole={userRole}
        initialCompanies={companies}
      />
      {/* Rendered outside the dashboard component so this stays inside
          companies/**. Matches its main container so the panel reads as part
          of the same page rather than something appended to it. */}
      <div className="bg-remotiv-bg">
        <div className="mx-auto max-w-screen-2xl px-4 pb-10 lg:px-8">
          <QueuePanel health={queue} />
        </div>
      </div>
    </>
  );
}
