import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/server";
import { TeamDashboard } from "../_components/team-dashboard";
import type { TeamMember } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminTeamPage() {
  const [supabase, service] = await Promise.all([
    createClient(),
    Promise.resolve(createServiceClient()),
  ]);

  const [{ data: { user } }, { data: members }] = await Promise.all([
    supabase.auth.getUser(),
    service
      .from("team_members")
      .select("*")
      .order("joined_at", { ascending: false }),
  ]);

  return (
    <TeamDashboard
      email={user?.email ?? ""}
      initialMembers={(members ?? []) as TeamMember[]}
    />
  );
}
