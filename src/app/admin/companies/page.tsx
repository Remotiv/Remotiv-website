import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { CompaniesDashboard } from "@/app/admin/_components/companies-dashboard";
import { TopNav } from "@/app/admin/_components/top-nav";
import { type UserRole, isSuperAdminEmail } from "@/app/admin/lib/roles";
import { fetchCompanies, fetchPlansUsage, fetchQueueHealth } from "./actions";
import { CompaniesTabs, parseCompaniesTab } from "./_companies-tabs";
import { QueuePanel } from "./_queue-panel";
import { UsagePanel } from "./_usage-panel";

export const dynamic = "force-dynamic";

export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const tab = parseCompaniesTab((await searchParams).tab);
  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const userId = user.id;
  const userEmail = user.email ?? "";

  let userRole: UserRole = "viewer";
  if (isSuperAdminEmail(userEmail)) {
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

  // Every read below is already behind requireSuperAdmin(); the redirect above
  // is navigation polish, not the gate. Each tab fetches only what it shows.
  if (tab === "usage") {
    const usage = await fetchPlansUsage();
    return (
      <div className="min-h-screen bg-remotiv-bg">
        <TopNav email={userEmail} userRole={userRole} />
        <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
          <CompaniesTabs active="usage" />
          <UsagePanel result={usage} />
        </main>
      </div>
    );
  }

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
        tabs={<CompaniesTabs active="companies" />}
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
