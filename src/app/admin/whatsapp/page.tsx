import { redirect } from "next/navigation";
import { WhatsAppDashboard } from "@/app/admin/_components/whatsapp-dashboard";
import { isSuperAdminEmail, type UserRole } from "@/app/admin/lib/roles";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fetchInboundMessages } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminWhatsAppPage() {
  const supabase = await createClient();
  const service = createServiceClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  const inbound = await fetchInboundMessages();

  return (
    <WhatsAppDashboard
      email={userEmail}
      userRole={userRole}
      initialRows={inbound.ok ? inbound.value : []}
      loadFailed={!inbound.ok}
    />
  );
}
