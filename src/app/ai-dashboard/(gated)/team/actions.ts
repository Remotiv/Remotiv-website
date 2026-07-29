"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import type {
  CompanyMemberStatus,
  CompanyRole,
  TeamMemberRow,
} from "@/app/ai-dashboard/lib/company-roles";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Result/row types live in lib/company-roles.ts.
type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const ASSIGNABLE_ROLES: readonly CompanyRole[] = [
  "admin",
  "recruiter",
  "hiring_manager",
];

type MemberQueryRow = {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  role: CompanyRole;
  status: CompanyMemberStatus;
};

// ── Reads ────────────────────────────────────────────────────

/**
 * Every member of the viewer's company. Readable by any active member; only
 * mutations are role-gated.
 *
 * Email + last_sign_in_at come from auth.users, which PostgREST can't see —
 * they need the Admin API. We fan out getUserById per member inside
 * Promise.all rather than calling listUsers: listUsers paginates the ENTIRE
 * project's auth table (every talent, client, and admin account) and silently
 * truncates at the page size, so it would drop members as the project grows.
 * Team sizes are small, so N parallel lookups cost one wall-clock round-trip.
 */
export async function fetchTeamMembers(): Promise<TeamMemberRow[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data, error } = await service
    .from("company_members")
    .select("id, user_id, name, email, role, status")
    .eq("company_id", ctx.companyId)
    .neq("status", "removed")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[team] fetchTeamMembers query failed:", error);
    return [];
  }

  const members = (data ?? []) as MemberQueryRow[];
  if (members.length === 0) return [];

  const authResults = await Promise.all(
    members.map(async (m) => {
      if (!m.user_id) return { email: null, lastSignInAt: null };
      try {
        const { data: authData } = await service.auth.admin.getUserById(m.user_id);
        return {
          email: authData?.user?.email ?? null,
          lastSignInAt: authData?.user?.last_sign_in_at ?? null,
        };
      } catch {
        // One failed lookup degrades that row, never the whole page.
        return { email: null, lastSignInAt: null };
      }
    }),
  );

  return members.map((m, i) => {
    const email = m.email?.trim() || authResults[i].email || "";
    const name = m.name?.trim() || email.split("@")[0] || "Unknown";
    return {
      id: m.id,
      user_id: m.user_id,
      name,
      email,
      role: m.role,
      status: m.status,
      last_sign_in_at: authResults[i].lastSignInAt,
      is_self: m.user_id !== null && m.user_id === ctx.user.id,
      is_owner: m.role === "owner",
    };
  });
}

// ── Mutations ────────────────────────────────────────────────

export async function updateMemberRole(
  memberId: string,
  role: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  // Validate against the union — never trust a client-supplied role string.
  if (!ASSIGNABLE_ROLES.includes(role as CompanyRole)) {
    return { success: false, error: "Invalid role." };
  }

  const service = createServiceClient();

  // Re-fetch the target row: the client-supplied id proves nothing about
  // which company it belongs to.
  const { data: targetRow } = await service
    .from("company_members")
    .select("id, company_id, user_id, role")
    .eq("id", memberId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    user_id: string | null;
    role: CompanyRole;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Member not found in your workspace." };
  }
  if (target.role === "owner") {
    return { success: false, error: "The owner's role can't be changed." };
  }
  if (target.user_id && target.user_id === ctx.user.id) {
    return { success: false, error: "You can't change your own role." };
  }

  const { error } = await service
    .from("company_members")
    .update({ role })
    .eq("id", memberId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: undefined };
}

export async function removeMember(
  memberId: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");

  const service = createServiceClient();

  const { data: targetRow } = await service
    .from("company_members")
    .select("id, company_id, user_id, role")
    .eq("id", memberId)
    .maybeSingle();

  const target = targetRow as {
    id: string;
    company_id: string;
    user_id: string | null;
    role: CompanyRole;
  } | null;

  if (!target || target.company_id !== ctx.companyId) {
    return { success: false, error: "Member not found in your workspace." };
  }
  if (target.role === "owner") {
    return { success: false, error: "The owner can't be removed." };
  }
  if (target.user_id && target.user_id === ctx.user.id) {
    return { success: false, error: "You can't remove yourself." };
  }

  // Soft removal: the status enum already carries "removed", so we keep the
  // row for audit. The auth user is deliberately NOT deleted — that account
  // may be in use elsewhere; we only sever this membership.
  const { error } = await service
    .from("company_members")
    .update({ status: "removed" })
    .eq("id", memberId)
    .eq("company_id", ctx.companyId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/team");
  return { success: true, data: undefined };
}
