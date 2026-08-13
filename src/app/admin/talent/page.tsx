import { createClient, createServiceClient } from "@/lib/supabase/server";
import { TalentDashboard } from "@/app/admin/_components/talent-dashboard";
import { type UserRole, isSuperAdminEmail } from "@/app/admin/lib/roles";
import { fetchTalentProfiles } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminTalentPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; search?: string }>;
}) {
  const { id: openId, search } = await searchParams;

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [profiles, { data: roleRow }] = await Promise.all([
    fetchTalentProfiles(),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (isSuperAdminEmail(userEmail)) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <TalentDashboard
      email={userEmail}
      userRole={userRole}
      initialProfiles={profiles}
      initialOpenId={openId ?? null}
      initialSearch={search ?? ""}
    />
  );
}
