import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { HireRequestsDashboard } from "@/app/admin/_components/hire-requests-dashboard";
import { type UserRole, isSuperAdminEmail } from "@/app/admin/lib/roles";
import { fetchHireRequests } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminHireRequestsPage() {
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

  if (userRole !== "super_admin" && userRole !== "admin") {
    redirect("/admin");
  }

  const requests = await fetchHireRequests();

  return (
    <HireRequestsDashboard
      email={userEmail}
      userRole={userRole}
      initialRequests={requests}
    />
  );
}
