"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";

export type AdminLoginStatus = "active" | "paused" | "archived";

export type TeamMember = {
  id: string;
  auth_user_id: string | null;
  full_name: string;
  role: string;
  email: string;
  phone: string | null;
  status: "active" | "inactive";
  /** admin_users.status — the auth-gate column. */
  auth_status: AdminLoginStatus;
  permission: "super_admin" | "admin" | "viewer";
  candidates_assigned: number;
  clients_assigned: number;
  avg_placements: number;
  notes: string | null;
  gender: string | null;
  avatar_url: string | null;
  joined_at: string;
};

export type MemberInput = {
  full_name: string;
  role: string;
  email: string;
  phone: string;
  status: string;
  permission: string;
  notes: string;
  gender: string;
  avatar_url: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const DEFAULT_PASSWORD = "Remotiv@2026";

export async function addMember(
  input: MemberInput,
): Promise<MutationResult<TeamMember>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();

  // 1. Create Supabase auth account (skip email verification)
  const { data: authData, error: authError } =
    await supabase.auth.admin.createUser({
      email: input.email,
      password: DEFAULT_PASSWORD,
      email_confirm: true,
    });

  if (authError) return { success: false, error: authError.message };

  // 2. Insert into team_members, linking auth user
  const { data, error } = await supabase
    .from("team_members")
    .insert({
      auth_user_id: authData.user.id,
      full_name: input.full_name,
      role: input.role,
      email: input.email,
      phone: input.phone || null,
      status: input.status,
      permission: input.permission,
      notes: input.notes || null,
      gender: input.gender || null,
      avatar_url: input.avatar_url || null,
    })
    .select()
    .single();

  if (error) {
    // Roll back: delete the auth user we just created
    await supabase.auth.admin.deleteUser(authData.user.id);
    return { success: false, error: error.message };
  }

  // 3. Sync role into admin_users so the permission system picks it up
  await supabase.from("admin_users").insert({
    user_id: authData.user.id,
    role: input.permission,
    full_name: input.full_name,
  });

  revalidatePath("/admin/team");
  return { success: true, data: data as TeamMember };
}

export async function updateMember(
  id: string,
  input: MemberInput,
): Promise<MutationResult<TeamMember>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("team_members")
    .update({
      full_name: input.full_name,
      role: input.role,
      email: input.email,
      phone: input.phone || null,
      status: input.status,
      permission: input.permission,
      notes: input.notes || null,
      gender: input.gender || null,
      // avatar_url intentionally not updated — assigned once at creation
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Sync updated permission into admin_users
  const member = data as TeamMember;
  if (member.auth_user_id) {
    await supabase
      .from("admin_users")
      .update({ role: input.permission })
      .eq("user_id", member.auth_user_id);
  }

  revalidatePath("/admin/team");
  return { success: true, data: member };
}

export async function toggleMemberStatus(
  id: string,
  newStatus: "active" | "inactive",
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("team_members")
    .update({ status: newStatus })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/team");
  return { success: true, data: undefined };
}

/**
 * Fetch all team members enriched with their admin_users.status. This is
 * the auth-gate status — distinct from team_members.status (HR display).
 */
export async function fetchTeamMembersWithAuthStatus(): Promise<TeamMember[]> {
  await requireSuperAdmin();
  const supabase = createServiceClient();

  const { data: members } = await supabase
    .from("team_members")
    .select("*")
    .order("joined_at", { ascending: false });

  const rows = (members ?? []) as Array<Record<string, unknown>>;
  const userIds = rows
    .map((r) => r.auth_user_id as string | null)
    .filter((id): id is string => !!id);

  let statusMap = new Map<string, AdminLoginStatus>();
  if (userIds.length > 0) {
    const { data: adminRows } = await supabase
      .from("admin_users")
      .select("user_id, status")
      .in("user_id", userIds);
    statusMap = new Map(
      ((adminRows ?? []) as Array<{ user_id: string; status: string | null }>).map((r) => [
        r.user_id,
        ((r.status as AdminLoginStatus) ?? "active"),
      ]),
    );
  }

  return rows.map((r) => ({
    ...(r as TeamMember),
    auth_status: r.auth_user_id
      ? statusMap.get(r.auth_user_id as string) ?? "active"
      : "active",
  }));
}

/**
 * Pause / unpause / archive a team member's auth login by updating
 * admin_users.status. The admin layout reads this on every request and
 * force-logs-out anyone with status != 'active'.
 */
export async function setAdminLoginStatus(
  authUserId: string,
  status: AdminLoginStatus,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  if (!authUserId) return { success: false, error: "Missing auth user id." };

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("admin_users")
    .update({ status })
    .eq("user_id", authUserId);

  if (error) return { success: false, error: error.message };

  revalidatePath("/admin/team");
  return { success: true, data: undefined };
}

export async function removeMember(
  id: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();

  // 1. Fetch auth_user_id before deleting the row
  const { data: member } = await supabase
    .from("team_members")
    .select("auth_user_id")
    .eq("id", id)
    .single();

  // 2. Delete from team_members
  const { error } = await supabase.from("team_members").delete().eq("id", id);

  if (error) return { success: false, error: error.message };

  // 3. Delete auth user + admin_users row if we have a reference
  if (member?.auth_user_id) {
    await Promise.all([
      supabase.auth.admin.deleteUser(member.auth_user_id),
      supabase.from("admin_users").delete().eq("user_id", member.auth_user_id),
    ]);
  }

  revalidatePath("/admin/team");
  return { success: true, data: undefined };
}
