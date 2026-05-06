import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ClientsDashboard } from "@/app/admin/_components/clients-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { fetchClients } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminClientsPage() {
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

  const clients = await fetchClients();

  return (
    <ClientsDashboard
      email={userEmail}
      userRole={userRole}
      initialClients={clients}
    />
  );
}
