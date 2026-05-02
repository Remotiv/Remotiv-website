"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";

export type RemoteTalentStatus =
  | "pending"
  | "approved"
  | "shortlisted"
  | "placed"
  | "paused"
  | "archived";

export type EmploymentItem = {
  title: string;
  company: string;
  dates: string;
  description: string;
};

export type PortfolioItem = {
  title: string;
  role: string;
  url: string;
  description: string;
};

export type LanguageItem = {
  name: string;
  level: string;
};

export type EducationObj = {
  institution: string;
  degree: string;
  dates: string;
};

export type RemoteTalentProfile = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  city: string | null;
  country: string | null;
  time_zone: string | null;
  linkedin_url: string | null;

  job_titles: string | null;
  bio: string | null;
  skills: string[];
  employment_history: EmploymentItem[];
  education: EducationObj | null;
  portfolio: PortfolioItem[];

  hourly_rate: number | null;
  hours_per_week: string | null;
  work_type: string | null;
  availability: string | null;
  available_from_date: string | null;
  languages: LanguageItem[];

  cv_url: string | null;
  cv_text: string | null;
  photo_url: string | null;

  status: RemoteTalentStatus;
  email_verified: boolean;
  id_verified: boolean;
  phone_verified: boolean;
  approved_at: string | null;
  notes: string | null;
  created_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function fetchRemoteTalentProfiles(): Promise<RemoteTalentProfile[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("hire_remote_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  return ((data ?? []) as Array<Record<string, unknown>>).map(normaliseRow);
}

export async function updateRemoteTalentStatus(
  id: string,
  status: RemoteTalentStatus,
): Promise<MutationResult<undefined>> {
  const supabase = createServiceClient();

  const patch: Record<string, unknown> = { status };
  if (status === "approved") {
    patch.approved_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("hire_remote_profiles")
    .update(patch)
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/remote-talent");
  revalidatePath("/hire-remote");
  return { success: true, data: undefined };
}

export async function updateRemoteTalentVerification(
  id: string,
  idVerified: boolean,
  phoneVerified: boolean,
): Promise<MutationResult<undefined>> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("hire_remote_profiles")
    .update({
      id_verified: idVerified,
      phone_verified: phoneVerified,
    })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/remote-talent");
  revalidatePath("/hire-remote");
  return { success: true, data: undefined };
}

export async function saveRemoteTalentNote(
  id: string,
  note: string,
): Promise<MutationResult<undefined>> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("hire_remote_profiles")
    .update({ notes: note })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/remote-talent");
  return { success: true, data: undefined };
}

export async function deleteRemoteTalentProfile(
  id: string,
): Promise<MutationResult<undefined>> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("hire_remote_profiles")
    .delete()
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/remote-talent");
  revalidatePath("/hire-remote");
  return { success: true, data: undefined };
}

function normaliseRow(r: Record<string, unknown>): RemoteTalentProfile {
  const educationRaw = r.education;
  const education: EducationObj | null =
    educationRaw && typeof educationRaw === "object"
      ? {
          institution: typeof (educationRaw as Record<string, unknown>).institution === "string"
            ? (educationRaw as Record<string, unknown>).institution as string
            : "",
          degree: typeof (educationRaw as Record<string, unknown>).degree === "string"
            ? (educationRaw as Record<string, unknown>).degree as string
            : "",
          dates: typeof (educationRaw as Record<string, unknown>).dates === "string"
            ? (educationRaw as Record<string, unknown>).dates as string
            : "",
        }
      : null;

  return {
    id: r.id as string,
    first_name: (r.first_name as string) ?? "",
    last_name: (r.last_name as string) ?? "",
    email: (r.email as string) ?? "",
    phone: (r.phone as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    time_zone: (r.time_zone as string | null) ?? null,
    linkedin_url: (r.linkedin_url as string | null) ?? null,

    job_titles: (r.job_titles as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    skills: Array.isArray(r.skills) ? (r.skills as string[]) : [],
    employment_history: Array.isArray(r.employment_history)
      ? (r.employment_history as EmploymentItem[])
      : [],
    education,
    portfolio: Array.isArray(r.portfolio) ? (r.portfolio as PortfolioItem[]) : [],

    hourly_rate: typeof r.hourly_rate === "number" ? r.hourly_rate : null,
    hours_per_week: (r.hours_per_week as string | null) ?? null,
    work_type: (r.work_type as string | null) ?? null,
    availability: (r.availability as string | null) ?? null,
    available_from_date: (r.available_from_date as string | null) ?? null,
    languages: Array.isArray(r.languages) ? (r.languages as LanguageItem[]) : [],

    cv_url: (r.cv_url as string | null) ?? null,
    cv_text: (r.cv_text as string | null) ?? null,
    photo_url: (r.photo_url as string | null) ?? null,

    status: ((r.status as RemoteTalentStatus) ?? "pending"),
    email_verified: r.email_verified === true,
    id_verified: r.id_verified === true,
    phone_verified: r.phone_verified === true,
    approved_at: (r.approved_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  };
}
