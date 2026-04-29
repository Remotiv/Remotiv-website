"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

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
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("application_comments")
    .insert({ application_id: applicationId, comment, author_name: authorName })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/applications");
  return { success: true, data: data as ApplicationComment };
}

export async function deleteApplication(
  id: string,
): Promise<MutationResult<undefined>> {
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
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("application_comments")
    .select("*")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: true });

  return (data ?? []) as ApplicationComment[];
}
