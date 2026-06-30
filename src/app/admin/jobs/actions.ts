"use server";

import { revalidatePath } from "next/cache";
import type { ScreeningQuestion } from "@/lib/jobs";
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
  screening_questions: ScreeningQuestion[];
  display_order: number | null;
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
  screening_questions: ScreeningQuestion[];
  display_order: string;
  status: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// Server-side cleanup of the screening-questions array — the single source of
// truth before persistence. Drops invalid/empty questions, caps at 10, and
// normalizes each question's ideal/options per type. Empty result ([]) is valid.
function sanitizeQuestions(input: unknown): ScreeningQuestion[] {
  if (!Array.isArray(input)) return [];

  const cleaned: ScreeningQuestion[] = [];
  for (const raw of input.slice(0, 10)) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Partial<ScreeningQuestion>;

    const question = (typeof q.question === "string" ? q.question : "")
      .trim()
      .slice(0, 200);
    if (!question) continue; // drop empty-text questions

    const type = q.type;
    if (type !== "yesno" && type !== "numeric" && type !== "multiple") continue;

    const id = typeof q.id === "string" && q.id ? q.id : crypto.randomUUID();
    const essential = q.essential === true;

    if (type === "yesno") {
      const ideal = q.ideal === "No" ? "No" : "Yes";
      cleaned.push({ id, question, type, ideal, options: [], essential });
    } else if (type === "numeric") {
      const n = Number.parseFloat(String(q.ideal ?? ""));
      const ideal = Number.isFinite(n) && n >= 0 ? String(n) : "0";
      cleaned.push({ id, question, type, ideal, options: [], essential });
    } else {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter((o) => o.length > 0);
      if (options.length < 2) continue; // multiple requires >= 2 options
      const idx = Number.parseInt(String(q.ideal ?? "0"), 10);
      const ideal = String(
        Number.isInteger(idx) && idx >= 0 && idx < options.length ? idx : 0,
      );
      cleaned.push({ id, question, type, ideal, options, essential });
    }
  }
  return cleaned;
}

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

  // Custom display order — blank/invalid → null (sorts after numbered jobs).
  const orderRaw = input.display_order?.trim();
  const orderNum = orderRaw ? Number.parseInt(orderRaw, 10) : Number.NaN;
  const displayOrder = orderRaw && Number.isFinite(orderNum) ? orderNum : null;

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
      screening_questions: sanitizeQuestions(input.screening_questions),
      display_order: displayOrder,
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

export async function updateJobDisplayOrder(
  id: string,
  value: number | null,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const clean = value === null || !Number.isFinite(value) ? null : Math.trunc(value);
  const { error } = await supabase
    .from("jobs")
    .update({ display_order: clean })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/jobs");
  revalidatePath("/jobs");
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
