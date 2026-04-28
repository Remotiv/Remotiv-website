"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

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

function toInsert(input: JobInput) {
  return {
    title: input.title,
    company: input.company,
    company_rating: parseFloat(input.company_rating) || 4.5,
    location: input.location,
    salary_min: input.salary_min ? parseInt(input.salary_min) : null,
    salary_max: input.salary_max ? parseInt(input.salary_max) : null,
    contract_type: input.contract_type,
    work_type: input.work_type,
    category: input.category,
    experience_level: input.experience_level,
    language: input.language || "English",
    description: input.description || null,
    status: input.status,
  };
}

export async function createJob(
  input: JobInput,
): Promise<MutationResult<Job>> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .insert(toInsert(input))
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
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("jobs")
    .update(toInsert(input))
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
  const supabase = createServiceClient();
  const { error } = await supabase.from("jobs").delete().eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  return { success: true, data: undefined };
}
