import { createClient, createServiceClient } from "@/lib/supabase/server";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { SearchClient } from "./_search-client";

export const dynamic = "force-dynamic";

export default async function AdminSearchPage() {
  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const { data: roleRow } = await service
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return <SearchClient email={userEmail} userRole={userRole} />;
}
