"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAvatarUrl } from "@/lib/avatars";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";

export type ApplicationStatus = "new" | "shortlisted" | "not_a_fit" | "maybe";
export type ApplicationSource = "job_application" | "manual_upload";

export type JobApplication = {
  id: string;
  job_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  linkedin_url: string | null;
  cv_url: string;
  status: ApplicationStatus;
  source: ApplicationSource;
  notes: string | null;
  created_at: string;
  job_title?: string | null;
};

export type OpenJob = { id: string; title: string };

export type ApplicationComment = {
  id: string;
  application_id: string;
  comment: string;
  author_name: string;
  created_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function updateApplicationStatus(
  id: string,
  status: ApplicationStatus,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("job_applications")
    .update({ status })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/applications");
  return { success: true, data: undefined };
}

export async function addComment(
  applicationId: string,
  comment: string,
  authorName: string,
): Promise<MutationResult<ApplicationComment>> {
  await requireAdmin();
  const trimmedComment = trimRequired(comment);
  if (!trimmedComment) {
    return { success: false, error: "Comment cannot be empty." };
  }
  const trimmedAuthor = trimToNull(authorName) ?? "Anonymous";

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("application_comments")
    .insert({
      application_id: applicationId,
      comment: trimmedComment,
      author_name: trimmedAuthor,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/applications");
  return { success: true, data: data as ApplicationComment };
}

export async function deleteApplication(
  id: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("job_applications")
    .delete()
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/applications");
  return { success: true, data: undefined };
}

export async function fetchComments(
  applicationId: string,
): Promise<ApplicationComment[]> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("application_comments")
    .select("*")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: true });

  return (data ?? []) as ApplicationComment[];
}

// ── Move application → Talent profile ────────────────────────

export type MoveToTalentInput = {
  job_title: string;
  role_category: string;
  years_experience: number;
  industry: string;
  degree: string;
  institution: string;
  skills: string[];
  summary: string;
  employment_history: Array<{
    title: string;
    company: string;
    dates: string;
    description: string;
  }>;
  availability: string;
  work_type: string;
  notice_period: string;
  work_location: string;
  salary_min: number | null;
  salary_max: number | null;
};

export async function moveApplicationToTalent(
  applicationId: string,
  additionalData: MoveToTalentInput,
): Promise<MutationResult<{ talent_id: string }>> {
  await requireAdmin();
  const supabase = createServiceClient();

  // 1. Fetch the source application (select * to pick up columns the typed
  // JobApplication shape doesn't expose, e.g. city / country / github_url /
  // cv_text).
  const { data: appRow, error: fetchErr } = await supabase
    .from("job_applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!appRow) return { success: false, error: "Application not found." };

  const row = appRow as Record<string, unknown>;
  const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
  if (!isValidEmail(email)) {
    return { success: false, error: "Application has no valid email." };
  }

  // 2. Duplicate-by-email guard against talent_profiles.
  const { data: existingTalent } = await supabase
    .from("talent_profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existingTalent) {
    return {
      success: false,
      error: "This applicant is already in the Talent network",
    };
  }

  // 3. Insert the new talent profile.
  const { data: inserted, error: insertErr } = await supabase
    .from("talent_profiles")
    .insert({
      first_name:   typeof row.first_name   === "string" ? row.first_name   : "",
      last_name:    typeof row.last_name    === "string" ? row.last_name    : null,
      email,
      phone:        typeof row.phone        === "string" ? row.phone        : null,
      city:         typeof row.city         === "string" ? row.city         : null,
      country:      typeof row.country      === "string" ? row.country      : null,
      linkedin_url: typeof row.linkedin_url === "string" ? row.linkedin_url : null,
      github_url:   typeof row.github_url   === "string" ? row.github_url   : null,
      cv_url:       typeof row.cv_url       === "string" ? row.cv_url       : null,
      cv_text:      typeof row.cv_text      === "string" ? row.cv_text      : null,

      job_title:        additionalData.job_title,
      role_category:    additionalData.role_category,
      years_experience: additionalData.years_experience,
      industry:         additionalData.industry,
      degree:           additionalData.degree,
      institution:      additionalData.institution,
      skills:           additionalData.skills,
      experience:       additionalData.employment_history,
      summary:          additionalData.summary,
      availability:     additionalData.availability,
      work_type:        additionalData.work_type,
      notice_period:    additionalData.notice_period,
      work_location:    additionalData.work_location,
      salary_min:       additionalData.salary_min,
      salary_max:       additionalData.salary_max,

      avatar_url: getAvatarUrl(
        typeof row.first_name === "string" ? row.first_name : null,
        typeof row.last_name === "string" ? row.last_name : null,
      ),
      status: "pending",
      approved_at: null,
    })
    .select("id")
    .single();

  if (insertErr) return { success: false, error: insertErr.message };
  if (!inserted) return { success: false, error: "Insert returned no row." };

  revalidatePath("/admin/applications");
  revalidatePath("/admin/talent");
  return { success: true, data: { talent_id: (inserted as { id: string }).id } };
}
