"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  canManageHiringTeam,
  COMPANY_ROLE_LABELS,
  type CompanyRole,
  isJobScopedRole,
  type JobTeamRole,
  TEAM_ROLES,
} from "@/app/ai-dashboard/lib/company-roles";
import { canAccessJob, type HiringTeamMember } from "@/app/ai-dashboard/lib/job-scope";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in lib/job-scope.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

/** Same message for not-found and not-yours, as everywhere else in the product. */
const NOT_YOURS = "That job isn't in your workspace.";

/**
 * May the caller change THIS job's hiring team?
 *
 * Two gates, both required. The account role must be one that manages teams at
 * all, and — for a scoped role — they must already be on this job's team.
 * A recruiter can run the team of a job they are on; they cannot add themselves
 * to one they are not, which would make the whole scope self-serve.
 */
async function assertCanManage(
  jobId: string,
): Promise<
  | { ok: true; ctx: Awaited<ReturnType<typeof getCompanyContext>> }
  | { ok: false; error: string }
> {
  const ctx = await getCompanyContext();
  if (!canManageHiringTeam(ctx.role)) {
    return { ok: false, error: "You don't have permission to change this job's team." };
  }

  const service = createServiceClient();
  const { data } = await service
    .from("jobs")
    .select("id, company_id")
    .eq("id", jobId)
    .maybeSingle();
  const job = data as { company_id: string | null } | null;
  if (!job || job.company_id !== ctx.companyId) {
    return { ok: false, error: NOT_YOURS };
  }
  if (!(await canAccessJob(ctx, jobId))) return { ok: false, error: NOT_YOURS };

  return { ok: true, ctx };
}

/**
 * Everyone who can see this job, and why.
 *
 * Returns the assigned team AND the site-wide members (owner/admin), because
 * "who can see this job" is the question the section exists to answer — a list
 * that showed only assignments would leave a company wondering why an admin
 * they never added is commenting on candidates.
 */
export async function fetchHiringTeam(jobId: string): Promise<{
  assigned: HiringTeamMember[];
  siteWide: { name: string; accountRole: string }[];
  canManage: boolean;
}> {
  const ctx = await getCompanyContext();
  const empty = { assigned: [], siteWide: [], canManage: false };
  if (!jobId) return empty;

  const service = createServiceClient();
  const { data: jobRow } = await service
    .from("jobs")
    .select("id, company_id")
    .eq("id", jobId)
    .maybeSingle();
  const job = jobRow as { company_id: string | null } | null;
  if (!job || job.company_id !== ctx.companyId) return empty;
  if (!(await canAccessJob(ctx, jobId))) return empty;

  const [{ data: teamRows }, { data: memberRows }] = await Promise.all([
    service
      .from("job_hiring_team")
      .select("id, member_id, team_role")
      .eq("company_id", ctx.companyId)
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
    service
      .from("company_members")
      .select("id, name, email, role")
      .eq("company_id", ctx.companyId)
      .eq("status", "active"),
  ]);

  type Member = { id: string; name: string | null; email: string | null; role: CompanyRole };
  const members = new Map(
    ((memberRows ?? []) as Member[]).map((m) => [m.id, m]),
  );

  const assigned: HiringTeamMember[] = [];
  for (const row of (teamRows ?? []) as {
    id: string;
    member_id: string;
    team_role: string;
  }[]) {
    const m = members.get(row.member_id);
    // A membership whose member row is gone is skipped rather than rendered
    // as a blank line — removing someone from the company should not leave a
    // ghost on every job they touched.
    if (!m) continue;
    assigned.push({
      id: row.id,
      memberId: row.member_id,
      name: (m.name ?? "").trim() || (m.email ?? "").trim() || "Member",
      email: (m.email ?? "").trim(),
      teamRole: (TEAM_ROLES as readonly string[]).includes(row.team_role)
        ? (row.team_role as JobTeamRole)
        : "coordinator",
      accountRole: COMPANY_ROLE_LABELS[m.role] ?? m.role,
    });
  }

  const siteWide = [...members.values()]
    .filter((m) => !isJobScopedRole(m.role))
    .map((m) => ({
      name: (m.name ?? "").trim() || (m.email ?? "").trim() || "Member",
      accountRole: COMPANY_ROLE_LABELS[m.role] ?? m.role,
    }));

  return { assigned, siteWide, canManage: canManageHiringTeam(ctx.role) };
}

/** Company members who could be added to a job's team. */
export async function fetchAssignableMembers(): Promise<
  { id: string; name: string; email: string; accountRole: string }[]
> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("company_members")
    .select("id, name, email, role")
    .eq("company_id", ctx.companyId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(500);

  return ((data ?? []) as {
    id: string;
    name: string | null;
    email: string | null;
    role: CompanyRole;
  }[]).map((m) => ({
    id: m.id,
    name: (m.name ?? "").trim() || (m.email ?? "").trim() || "Member",
    email: (m.email ?? "").trim(),
    accountRole: COMPANY_ROLE_LABELS[m.role] ?? m.role,
  }));
}

/** Add a member to a job's hiring team. */
export async function addToHiringTeam(input: {
  jobId: string;
  memberId: string;
  teamRole: string;
}): Promise<MutationResult<undefined>> {
  const gate = await assertCanManage(input.jobId);
  if (!gate.ok) return { success: false, error: gate.error };
  const ctx = gate.ctx;

  const teamRole = (TEAM_ROLES as readonly string[]).includes(input.teamRole)
    ? input.teamRole
    : null;
  if (!teamRole) return { success: false, error: "Pick a role for this person." };

  const service = createServiceClient();

  // The member must belong to THIS company. Without the re-read a caller could
  // post another tenant's member id and attach them to a job here.
  const { data: memberRow } = await service
    .from("company_members")
    .select("id")
    .eq("id", input.memberId)
    .eq("company_id", ctx.companyId)
    .eq("status", "active")
    .maybeSingle();
  if (!memberRow) {
    return { success: false, error: "That person isn't on your team." };
  }

  const { error } = await service.from("job_hiring_team").insert({
    job_id: input.jobId,
    company_id: ctx.companyId,
    member_id: input.memberId,
    team_role: teamRole,
    added_by: ctx.memberId,
  });

  // unique(job_id, member_id) — adding someone twice is a no-op, not an error
  // the user needs to see.
  if (error && error.code !== "23505") {
    return { success: false, error: error.message };
  }

  revalidateJobTeamSurfaces();
  return { success: true, data: undefined };
}

/** Change someone's label on a job. Access is unaffected — presence grants it. */
export async function updateHiringTeamRole(input: {
  jobId: string;
  memberId: string;
  teamRole: string;
}): Promise<MutationResult<undefined>> {
  const gate = await assertCanManage(input.jobId);
  if (!gate.ok) return { success: false, error: gate.error };

  const teamRole = (TEAM_ROLES as readonly string[]).includes(input.teamRole)
    ? input.teamRole
    : null;
  if (!teamRole) return { success: false, error: "Pick a role for this person." };

  const { error } = await createServiceClient()
    .from("job_hiring_team")
    .update({ team_role: teamRole })
    .eq("company_id", gate.ctx.companyId)
    .eq("job_id", input.jobId)
    .eq("member_id", input.memberId);

  if (error) return { success: false, error: error.message };

  revalidateJobTeamSurfaces();
  return { success: true, data: undefined };
}

/**
 * Remove someone from a job's hiring team.
 *
 * A scoped member removing THEMSELVES loses the job immediately, including the
 * ability to undo it. That is allowed — it is their own call and an owner can
 * always put them back — but the UI asks first.
 */
export async function removeFromHiringTeam(input: {
  jobId: string;
  memberId: string;
}): Promise<MutationResult<undefined>> {
  const gate = await assertCanManage(input.jobId);
  if (!gate.ok) return { success: false, error: gate.error };

  const { error } = await createServiceClient()
    .from("job_hiring_team")
    .delete()
    .eq("company_id", gate.ctx.companyId)
    .eq("job_id", input.jobId)
    .eq("member_id", input.memberId);

  if (error) return { success: false, error: error.message };

  revalidateJobTeamSurfaces();
  return { success: true, data: undefined };
}

/** Every surface whose contents depend on who is on a job's team. */
function revalidateJobTeamSurfaces(): void {
  revalidatePath("/ai-dashboard");
  revalidatePath("/ai-dashboard/jobs");
  revalidatePath("/ai-dashboard/applicants");
  revalidatePath("/ai-dashboard/messages");
  revalidatePath("/ai-dashboard/weekly-report");
}
