import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TeamDashboard } from "../_components/team-dashboard";
import { fetchTeamMembersWithAuthStatus } from "./actions";
import { type UserRole, SUPER_ADMIN_EMAIL } from "../lib/roles";

export const dynamic = "force-dynamic";

export default async function AdminTeamPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [members, { data: roleRow }] = await Promise.all([
    fetchTeamMembersWithAuthStatus(),
    service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  let resolvedRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    resolvedRole = "super_admin";
  } else if (roleRow?.role) {
    resolvedRole = roleRow.role as UserRole;
  }

  return (
    <TeamDashboard
      email={userEmail}
      userRole={resolvedRole}
      initialMembers={members}
    />
  );
}
