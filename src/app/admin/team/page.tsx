import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TeamDashboard } from "../_components/team-dashboard";
import type { TeamMember } from "./actions";
import type { UserRole } from "../lib/roles";

export const dynamic = "force-dynamic";

const SUPER_ADMIN_EMAIL = "waleednzm@gmail.com";

export default async function AdminTeamPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: members }, { data: roleRow, error: roleError }] = await Promise.all([
    service
      .from("team_members")
      .select("*")
      .order("joined_at", { ascending: false }),
    service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  // ── DEBUG: log everything so we can see exactly what Supabase returns ──
  console.log("[team/page] userEmail:", JSON.stringify(userEmail));
  console.log("[team/page] SUPER_ADMIN_EMAIL:", JSON.stringify(SUPER_ADMIN_EMAIL));
  console.log("[team/page] emailsMatch:", userEmail === SUPER_ADMIN_EMAIL);
  console.log("[team/page] userId:", userId);
  console.log("[team/page] roleRow:", roleRow);
  console.log("[team/page] roleError:", roleError);

  // TEMPORARY HARDCODE — proves the display layer works independently of the fetch
  const resolvedRole: UserRole = "super_admin";

  console.log("[team/page] resolvedRole (hardcoded):", resolvedRole);

  return (
    <TeamDashboard
      email={userEmail}
      userRole={resolvedRole}
      initialMembers={(members ?? []) as TeamMember[]}
    />
  );
}
