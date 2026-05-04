import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ClientBatchesDashboard } from "@/app/admin/_components/client-batches-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { fetchActiveClients, fetchBatches } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminClientBatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ client_id?: string }>;
}) {
  const { client_id } = await searchParams;

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/admin/login");

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

  if (userRole !== "super_admin" && userRole !== "admin") {
    redirect("/admin");
  }

  const [batches, activeClients] = await Promise.all([
    fetchBatches(client_id),
    fetchActiveClients(),
  ]);

  // Resolve company name when filtering by client_id (for breadcrumb).
  let filterClientName: string | null = null;
  if (client_id) {
    const { data: clientRow } = await service
      .from("clients")
      .select("company_name")
      .eq("id", client_id)
      .maybeSingle();
    filterClientName = (clientRow as { company_name: string } | null)?.company_name ?? null;
  }

  return (
    <ClientBatchesDashboard
      email={userEmail}
      userRole={userRole}
      initialBatches={batches}
      activeClients={activeClients}
      filterClientId={client_id ?? null}
      filterClientName={filterClientName}
    />
  );
}
