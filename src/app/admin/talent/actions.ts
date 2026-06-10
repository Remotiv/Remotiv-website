"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { trimToNull } from "@/app/admin/lib/validators";
import type { InviteStatus } from "@/lib/claim-status";
import { getAvatarUrl } from "@/lib/avatars";

// Build the displayed avatar URL for an admin row. When the talent has
// uploaded a real photo (photo_path is non-null), point at the public
// talent_photos bucket; otherwise fall back to the deterministic
// getAvatarUrl(first, last) static cartoon. We inline the URL instead
// of calling .getPublicUrl() because it's just a string concatenation
// and avoids allocating a service client per row.
function buildAdminTalentPhotoUrl(
  photoPath: string | null,
  firstName: string | null,
  lastName: string | null,
): string {
  if (photoPath && photoPath.trim()) {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    if (base) {
      return `${base}/storage/v1/object/public/talent_photos/${photoPath.trim()}`;
    }
  }
  return getAvatarUrl(firstName, lastName);
}

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
  claimed_at: string | null;
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

  return ((data ?? []) as Array<Record<string, unknown>>).map((raw) => {
    const profile = normaliseRow(raw);
    return {
      ...profile,
      avatar_url: buildAdminTalentPhotoUrl(
        (raw.photo_path as string | null) ?? null,
        profile.first_name,
        profile.last_name,
      ),
    };
  });
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
    .update({ notes: trimToNull(note) })
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/talent");
  return { success: true, data: undefined };
}

// ============================================================================
// Phase 2: Talent claim — invite-status fetch + send-invite call
// ----------------------------------------------------------------------------
// Reads from talent_claim_tokens (created in a separate migration). Returns
// the most-recent token status per profile id. Profiles with no token row
// are absent from the map; the UI maps "absent" → "not_invited".
// ============================================================================

export async function fetchTalentInviteStatuses(
  profileIds: string[],
): Promise<Record<string, InviteStatus>> {
  await requireAdmin();
  if (profileIds.length === 0) return {};

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("talent_claim_tokens")
    .select("candidate_id, status, created_at")
    .in("candidate_id", profileIds)
    .eq("source_table", "talent_profiles")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[talent_claim_tokens] read failed:", error);
    return {};
  }

  const result: Record<string, InviteStatus> = {};
  for (const row of (data ?? []) as Array<{
    candidate_id: string;
    status: string;
  }>) {
    // First row per candidate wins because the query is ordered desc.
    if (result[row.candidate_id]) continue;
    result[row.candidate_id] = row.status as InviteStatus;
  }
  return result;
}

export async function sendClaimInvites(
  profileIds: string[],
  sourceTable: "talent_profiles" | "hire_remote_profiles",
): Promise<{ success: boolean; sent: number; skipped: unknown[]; error?: string }> {
  await requireAdmin();

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://remotiv-website-m3jo.vercel.app";

  // Forward the caller's session cookies so the API route's requireAdmin()
  // gate sees the same user. Without this, the server-to-self fetch arrives
  // unauthenticated and the route returns 403.
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  try {
    const res = await fetch(`${baseUrl}/api/admin/send-invite`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ profileIds, sourceTable }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      sent?: number;
      skipped?: unknown[];
      error?: string;
    };

    if (!res.ok) {
      return {
        success: false,
        sent: 0,
        skipped: [],
        error: json.error ?? "Request failed",
      };
    }

    return {
      success: true,
      sent: typeof json.sent === "number" ? json.sent : 0,
      skipped: Array.isArray(json.skipped) ? json.skipped : [],
    };
  } catch (e) {
    console.error("[sendClaimInvites] fetch error:", e);
    return { success: false, sent: 0, skipped: [], error: "Network error" };
  }
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
    claimed_at: (r.claimed_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  };
}
