"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { trimRequired, trimToNull } from "@/app/admin/lib/validators";

export type Job = {
  id: string;
  title: string;
  company: string;
  company_rating: number;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  contract_type: "Full time" | "Part time" | "Contract";
  work_type: "Remote" | "On-site" | "Hybrid";
  category: "Engineering" | "Design" | "Sales" | "Marketing" | "Data" | "Support";
  experience_level: "Entry" | "Intermediate" | "Expert";
  language: string;
  description: string | null;
  status: "open" | "on_hold" | "closed";
  created_at: string;
};

export type JobInput = {
  title: string;
  company: string;
  company_rating: string;
  location: string;
  salary_min: string;
  salary_max: string;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  description: string;
  status: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

function buildPatch(input: JobInput):
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string } {
  const title = trimRequired(input.title);
  if (!title) return { ok: false, error: "Job title is required." };
  const company = trimRequired(input.company);
  if (!company) return { ok: false, error: "Company is required." };
  const location = trimRequired(input.location);
  if (!location) return { ok: false, error: "Location is required." };

  return {
    ok: true,
    patch: {
      title,
      company,
      company_rating: Number.parseFloat(input.company_rating) || 4.5,
      location,
      salary_min: input.salary_min ? Number.parseInt(input.salary_min, 10) : null,
      salary_max: input.salary_max ? Number.parseInt(input.salary_max, 10) : null,
      contract_type: input.contract_type,
      work_type: input.work_type,
      category: input.category,
      experience_level: input.experience_level,
      language: trimToNull(input.language) ?? "English",
      description: trimToNull(input.description),
      status: input.status,
    },
  };
}

export async function createJob(
  input: JobInput,
): Promise<MutationResult<Job>> {
  await requireAdmin();
  const built = buildPatch(input);
  if (!built.ok) return { success: false, error: built.error };

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert(built.patch)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  return { success: true, data: data as Job };
}

export async function updateJob(
  id: string,
  input: JobInput,
): Promise<MutationResult<Job>> {
  await requireAdmin();
  const built = buildPatch(input);
  if (!built.ok) return { success: false, error: built.error };

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .update(built.patch)
    .eq("id", id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  return { success: true, data: data as Job };
}

export async function updateJobStatus(
  id: string,
  status: "open" | "on_hold" | "closed",
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("jobs")
    .update({ status })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  return { success: true, data: undefined };
}

export async function deleteJob(
  id: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase.from("jobs").delete().eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  return { success: true, data: undefined };
}
