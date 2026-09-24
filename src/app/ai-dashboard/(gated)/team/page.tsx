import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canManageTeam } from "@/app/ai-dashboard/lib/company-roles";
import { isTipDismissed } from "@/app/ai-dashboard/lib/tip-state";
import { fetchTeamMembers } from "./actions";
import { TeamClient } from "./_team-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team — Remotiv AI Interviews" };

export default async function TeamPage() {
  const [ctx, members] = await Promise.all([
    getCompanyContext(),
    fetchTeamMembers(),
  ]);

  /*
   * The role-access tip is for whoever assigns access, so it is gated on the
   * same helper the invite controls are — owner and admin. A recruiter has no
   * hiring team to change and would only be told why they cannot see things.
   *
   * Resolved here rather than in the client: the answer lives per member in the
   * database, and the read is tolerant of the table not existing yet.
   */
  const showRoleAccessTip =
    canManageTeam(ctx.role) && !(await isTipDismissed(ctx.memberId, "team_role_access"));

  return (
    <TeamClient
      companyName={ctx.company.name}
      viewerRole={ctx.role}
      members={members}
      showRoleAccessTip={showRoleAccessTip}
    />
  );
}
