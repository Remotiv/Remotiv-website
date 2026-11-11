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

  // The same rule as fetchInboundMessages: a failed lookup, or a paused or
  // archived row, refuses even an allowlisted email (the layout skips the
  // status check for the allowlist); an allowlisted email with no row passes.
  const { data: roleRow, error: roleError } = await service
    .from("admin_users")
    .select("role, status")
    .eq("user_id", userId)
    .maybeSingle();
  const row = roleRow as { role: UserRole | null; status: string | null } | null;
  const refused = Boolean(roleError) || Boolean(row?.status && row.status !== "active");

  let userRole: UserRole = "viewer";
  if (!refused) {
    if (isSuperAdminEmail(userEmail)) userRole = "super_admin";
    else if (row?.role) userRole = row.role;
  }

  // Super admins only (#66). fetchInboundMessages enforces the same rule on
  // its own; this redirect only spares everyone else a thrown error.
  if (userRole !== "super_admin") {
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
