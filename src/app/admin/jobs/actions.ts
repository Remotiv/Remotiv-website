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
  salary_currency: string | null;
  contract_type: "Full time" | "Part time" | "Contract";
  work_type: "Remote" | "On-site" | "Hybrid";
  category: "Engineering" | "Design" | "Sales" | "Marketing" | "Data" | "Support";
  experience_level: "Entry" | "Intermediate" | "Expert";
  language: string;
  positions: number;
  slug: string | null;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
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
  salary_currency: string;
  contract_type: string;
  work_type: string;
  category: string;
  experience_level: string;
  language: string;
  positions: string;
  description: string;
  responsibilities: string;
  requirements: string;
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

  const salaryCurrency = (input.salary_currency ?? "").trim().toUpperCase();
  if (salaryCurrency !== "USD" && salaryCurrency !== "PKR") {
    return { ok: false, error: "Currency is required (USD or PKR)." };
  }

  return {
    ok: true,
    patch: {
      title,
      company,
      company_rating: Number.parseFloat(input.company_rating) || 4.5,
      location,
      salary_min: input.salary_min ? Number.parseInt(input.salary_min, 10) : null,
      salary_max: input.salary_max ? Number.parseInt(input.salary_max, 10) : null,
      salary_currency: salaryCurrency,
      contract_type: input.contract_type,
      work_type: input.work_type,
      category: input.category,
      experience_level: input.experience_level,
      language: trimToNull(input.language) ?? "English",
      positions: Math.max(1, Number.parseInt(input.positions, 10) || 1),
      description: trimToNull(input.description),
      responsibilities: trimToNull(input.responsibilities),
      requirements: trimToNull(input.requirements),
      status: input.status,
    },
  };
}

// URL-safe slug from a job title: lowercase, non-alphanumerics → hyphens,
// trimmed of leading/trailing hyphens. Uniqueness is enforced separately in
// createJob (DB also has a unique index on slug).
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function createJob(
  input: JobInput,
): Promise<MutationResult<Job>> {
  await requireAdmin();
  const built = buildPatch(input);
  if (!built.ok) return { success: false, error: built.error };

  const supabase = createServiceClient();

  // Slug generated on CREATE only (stable thereafter — updateJob never touches
  // it, so shared links don't break when the title is edited). Ensure
  // uniqueness by suffixing -2, -3, … on collision.
  const base = slugifyTitle((built.patch.title as string) ?? "") || "job";
  let candidate = base;
  let n = 2;
  for (;;) {
    const { data: clash } = await supabase
      .from("jobs")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!clash) break;
    candidate = `${base}-${n}`;
    n += 1;
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({ ...built.patch, slug: candidate })
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
