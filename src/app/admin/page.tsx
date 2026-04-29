import { createClient, createServiceClient } from "@/lib/supabase/server";
import { OverviewDashboard } from "./_components/overview-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "./lib/roles";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [
    { count: totalApplications },
    { count: totalContacts },
    { count: totalBookings },
    { count: pendingReview },
    { data: roleRow },
  ] = await Promise.all([
    service.from("profiles").select("*", { count: "exact", head: true }),
    service.from("contact_submissions").select("*", { count: "exact", head: true }),
    service.from("bookings").select("*", { count: "exact", head: true }),
    service.from("profiles").select("*", { count: "exact", head: true }).eq("status", "pending"),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <OverviewDashboard
      email={userEmail}
      userRole={userRole}
      stats={{
        totalApplications: totalApplications ?? 0,
        totalContacts: totalContacts ?? 0,
        totalBookings: totalBookings ?? 0,
        pendingReview: pendingReview ?? 0,
      }}
    />
  );
}
