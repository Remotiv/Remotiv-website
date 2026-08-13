"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { isSuperAdminEmail, type UserRole } from "@/app/admin/lib/roles";

export type HireRequestStatus = "new" | "contacted" | "matched" | "placed" | "archived";

export type HireRequest = {
  id: string;
  full_name: string;
  email: string;
  company: string;
  notes: string | null;
  engagement_type: string;
  budget_range: string;
  project_description: string;
  timeline: string;
  candidate_id: string | null;
  candidate_name: string | null;
  candidate_rate: string | null;
  status: HireRequestStatus;
  created_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const STATUS_VALUES: ReadonlyArray<HireRequestStatus> = [
  "new",
  "contacted",
  "matched",
  "placed",
  "archived",
];

// ── Auth gates ───────────────────────────────────────────────

async function getAdminRole(): Promise<UserRole | null> {
  const auth = await createAuthClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  if (isSuperAdminEmail(user.email)) return "super_admin";

  const supabase = createServiceClient();
  const { data: roleRow } = await supabase
    .from("admin_users")
    .select("role, status")
    .eq("user_id", user.id)
    .maybeSingle();

  type AdminRow = { role: UserRole | null; status: string | null };
  const r = roleRow as AdminRow | null;
  if (!r || !r.role) return null;
  if (r.status && r.status !== "active") return null;
  return r.role;
}

async function requireAdmin(): Promise<UserRole> {
  const role = await getAdminRole();
  if (!role || (role !== "super_admin" && role !== "admin")) {
    throw new Error("Forbidden");
  }
  return role;
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchHireRequests(): Promise<HireRequest[]> {
  await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("hire_requests")
    .select(
      "id, full_name, email, company, notes, engagement_type, budget_range, project_description, timeline, candidate_id, candidate_name, candidate_rate, status, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[hire_requests] read failed:", error);
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    full_name: (r.full_name as string) ?? "",
    email: (r.email as string) ?? "",
    company: (r.company as string) ?? "",
    notes: (r.notes as string | null) ?? null,
    engagement_type: (r.engagement_type as string) ?? "",
    budget_range: (r.budget_range as string) ?? "",
    project_description: (r.project_description as string) ?? "",
    timeline: (r.timeline as string) ?? "",
    candidate_id: (r.candidate_id as string | null) ?? null,
    candidate_name: (r.candidate_name as string | null) ?? null,
    candidate_rate: (r.candidate_rate as string | null) ?? null,
    status: ((r.status as HireRequestStatus) ?? "new"),
    created_at: (r.created_at as string) ?? "",
  }));
}

// ── Mutations ────────────────────────────────────────────────

export async function updateHireRequestStatus(
  id: string,
  newStatus: HireRequestStatus,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  if (!STATUS_VALUES.includes(newStatus)) {
    return { success: false, error: "Invalid status" };
  }
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("hire_requests")
    .update({ status: newStatus })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/hire-requests");
  return { success: true, data: undefined };
}

export async function deleteHireRequest(
  id: string,
): Promise<MutationResult<undefined>> {
  const role = await requireAdmin();
  if (role !== "super_admin") {
    return { success: false, error: "Only super admin can delete." };
  }
  const supabase = createServiceClient();
  const { error } = await supabase.from("hire_requests").delete().eq("id", id);
  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/hire-requests");
  return { success: true, data: undefined };
}
