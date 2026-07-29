import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { fetchTeamMembers } from "./actions";
import { TeamClient } from "./_team-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team — Remotiv AI Interviews" };

export default async function TeamPage() {
  const [ctx, members] = await Promise.all([
    getCompanyContext(),
    fetchTeamMembers(),
  ]);

  return (
    <TeamClient
      companyName={ctx.company.name}
      viewerRole={ctx.role}
      members={members}
    />
  );
}
