"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";

export type TalentStatus =
  | "pending"
  | "approved"
  | "shortlisted"
  | "placed"
  | "paused"
  | "archived";

export type TalentProfile = {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  city: string | null;
  country: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  job_title: string | null;
  role_category: string | null;
  years_experience: number | null;
  industry: string | null;
  degree: string | null;
  institution: string | null;
  skills: string[];
  experience: Array<{
    title?: string;
    company?: string;
    start?: string;
    end?: string;
    dates?: string;
    skills?: string[];
  }>;
  summary: string | null;
  availability: string | null;
  work_type: string | null;
  notice_period: string | null;
  work_location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  avatar_url: string | null;
  cv_url: string | null;
  status: TalentStatus;
  approved_at: string | null;
  notes: string | null;
  created_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function fetchTalentProfiles(): Promise<TalentProfile[]> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("talent_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[talent_profiles] read failed:", error);
    return [];
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map(normaliseRow);
}

export async function updateTalentStatus(
  id: string,
  status: TalentStatus,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();

  const patch: Record<string, unknown> = { status };

  // Stamp approved_at only on the FIRST transition into "approved" so the
  // original approval date is preserved across pause/archive → re-approve
  // cycles. Subsequent re-approvals leave approved_at untouched.
  if (status === "approved") {
    const { data: existing } = await supabase
      .from("talent_profiles")
      .select("approved_at")
      .eq("id", id)
      .maybeSingle();
    if (!existing?.approved_at) {
      patch.approved_at = new Date().toISOString();
    }
  }

  const { error } = await supabase
    .from("talent_profiles")
    .update(patch)
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/talent");
  revalidatePath("/browse-talent");
  return { success: true, data: undefined };
}

export async function deleteTalentProfile(
  id: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("talent_profiles")
    .delete()
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/talent");
  return { success: true, data: undefined };
}

export async function saveTalentNote(
  id: string,
  note: string,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("talent_profiles")
    .update({ notes: note })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/talent");
  return { success: true, data: undefined };
}

function normaliseRow(r: Record<string, unknown>): TalentProfile {
  return {
    id: r.id as string,
    first_name: (r.first_name as string) ?? "",
    last_name: (r.last_name as string | null) ?? null,
    email: (r.email as string) ?? "",
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    linkedin_url: (r.linkedin_url as string | null) ?? null,
    github_url: (r.github_url as string | null) ?? null,
    job_title: (r.job_title as string | null) ?? null,
    role_category: (r.role_category as string | null) ?? null,
    years_experience: (r.years_experience as number | null) ?? null,
    industry: (r.industry as string | null) ?? null,
    degree: (r.degree as string | null) ?? null,
    institution: (r.institution as string | null) ?? null,
    skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
    experience: Array.isArray(r.experience)
      ? (r.experience as Array<{
          title?: string;
          company?: string;
          start?: string;
          end?: string;
          dates?: string;
          skills?: string[];
        }>)
      : [],
    summary: (r.summary as string | null) ?? null,
    availability: (r.availability as string | null) ?? null,
    work_type: (r.work_type as string | null) ?? null,
    notice_period: (r.notice_period as string | null) ?? null,
    work_location: (r.work_location as string | null) ?? null,
    salary_min: (r.salary_min as number | null) ?? null,
    salary_max: (r.salary_max as number | null) ?? null,
    avatar_url: (r.avatar_url as string | null) ?? null,
    cv_url: (r.cv_url as string | null) ?? null,
    status: ((r.status as TalentStatus) ?? "pending"),
    approved_at: (r.approved_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  };
}
