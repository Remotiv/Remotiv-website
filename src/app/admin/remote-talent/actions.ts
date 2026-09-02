"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import type { InviteStatus } from "@/lib/claim-status";

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
  photo_path: string | null;

  status: RemoteTalentStatus;
  email_verified: boolean;
  id_verified: boolean;
  phone_verified: boolean;
  approved_at: string | null;
  claimed_at: string | null;
  notes: string | null;
  created_at: string;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function fetchRemoteTalentProfiles(): Promise<Read<RemoteTalentProfile[]>> {
  await requireAdmin();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("hire_remote_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[hire_remote_profiles] read failed:", error);
    return unavailable();
  }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(normaliseRow);

  // Photos live in the PUBLIC talent_photos bucket (post Phase 4.3C.0).
  // Build the public URL inline — no signing roundtrip per row, no async
  // map. Rows without photo_path keep photo_url=null; the dashboard's
  // Avatar component falls back to initials in that case.
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  return answered(
    rows.map((row) => {
    if (!row.photo_path || !base) {
      return { ...row, photo_url: null };
    }
    return {
      ...row,
      photo_url: `${base}/storage/v1/object/public/talent_photos/${row.photo_path}`,
    };
    }),
  );
}

export async function updateRemoteTalentStatus(
  id: string,
  status: RemoteTalentStatus,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
  const supabase = createServiceClient();

  const patch: Record<string, unknown> = { status };

  // Stamp approved_at the FIRST time a profile transitions to "approved".
  // Re-approving a paused/archived/shortlisted/placed profile must NOT
  // overwrite the original approval date.
  if (status === "approved") {
    const { data: existing } = await supabase
      .from("hire_remote_profiles")
      .select("approved_at")
      .eq("id", id)
      .maybeSingle();
    if (!existing?.approved_at) {
      patch.approved_at = new Date().toISOString();
    }
  }

  const { error } = await supabase
    .from("hire_remote_profiles")
    .update(patch)
    .eq("id", id);

  if (error) return { success: false, error: error.message };

  // Candidate-targeted notification on approved/archived transitions.
  // Same shape as the Pakistan talent flow (admin/talent/actions.ts).
  if (status === "approved" || status === "archived") {
    const { data: row } = await supabase
      .from("hire_remote_profiles")
      .select("user_id")
      .eq("id", id)
      .maybeSingle();
    const ownerId = (row as { user_id: string | null } | null)?.user_id;
    if (ownerId) {
      const isApproved = status === "approved";
      const { error: notifErr } = await supabase
        .from("notifications")
        .insert({
          recipient_user_id: ownerId,
          event_type: isApproved ? "profile_approved" : "profile_rejected",
          title: isApproved
            ? "Your profile is now live on Remotiv"
            : "Your profile needs some updates",
          message: isApproved
            ? "Clients can now discover you on the marketplace. Make sure your profile is complete to stand out."
            : "An admin reviewed your profile and asked for changes. Open your edit page to update it.",
          link: "/talent/dashboard/edit",
          metadata: { source_table: "hire_remote_profiles", profile_id: id },
        });
      if (notifErr) {
        console.error("[updateRemoteTalentStatus notification]", notifErr);
      }
    }
  }

  revalidatePath("/admin/remote-talent");
  revalidatePath("/find-freelancers");
  return { success: true, data: undefined };
}

export async function updateRemoteTalentVerification(
  id: string,
  idVerified: boolean,
  phoneVerified: boolean,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
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
  revalidatePath("/find-freelancers");
  return { success: true, data: undefined };
}

export async function saveRemoteTalentNote(
  id: string,
  note: string,
): Promise<MutationResult<undefined>> {
  await requireAdmin();
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
  await requireSuperAdmin();
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("hire_remote_profiles")
    .delete()
    .eq("id", id);

  if (error) return { success: false, error: error.message };
  revalidatePath("/admin/remote-talent");
  revalidatePath("/find-freelancers");
  return { success: true, data: undefined };
}

// ============================================================================
// K1 Phase 5: signed-URL CV access for /admin/remote-talent
// Mirrors getApplicationCvSignedUrl in admin/applications/actions.ts exactly —
// same bucket, same TTL, same deriveCvPathFromUrl fallback, same audit log.
// Only difference: queries hire_remote_profiles instead of job_applications.
// ============================================================================

const CV_BUCKET = "cvs";
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60;

function deriveCvPathFromUrl(cvUrl: string | null | undefined): string | null {
  if (!cvUrl) return null;
  const match = String(cvUrl).match(
    /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
  );
  return match ? match[1] : null;
}

export type RemoteTalentCvSignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_authenticated" | "cv_missing" | "internal_error" };

export async function getRemoteTalentCvSignedUrl(
  profileId: string,
): Promise<RemoteTalentCvSignedUrlResult> {
  if (typeof profileId !== "string" || profileId.length < 1 || profileId.length > 100) {
    return { ok: false, error: "internal_error" };
  }

  let adminCtx;
  try {
    adminCtx = await requireAdmin();
  } catch {
    return { ok: false, error: "not_authenticated" };
  }

  const service = createServiceClient();

  const { data: profileRow, error: profileErr } = await service
    .from("hire_remote_profiles")
    .select("cv_path, cv_url")
    .eq("id", profileId)
    .maybeSingle();
  if (profileErr || !profileRow) {
    return { ok: false, error: "cv_missing" };
  }

  const cvPath =
    (profileRow.cv_path as string | null) ??
    deriveCvPathFromUrl(profileRow.cv_url as string | null);
  if (!cvPath) {
    return { ok: false, error: "cv_missing" };
  }

  const { data: signed, error: signErr } = await service.storage
    .from(CV_BUCKET)
    .createSignedUrl(cvPath, CV_SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: "internal_error" };
  }

  service
    .from("signed_url_logs")
    .insert({
      user_id: adminCtx.user.id,
      candidate_id: profileId,
      source_table: "hire_remote_profiles",
      was_admin: true,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  return { ok: true, url: signed.signedUrl };
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
    photo_path: (r.photo_path as string | null) ?? null,

    status: ((r.status as RemoteTalentStatus) ?? "pending"),
    email_verified: r.email_verified === true,
    id_verified: r.id_verified === true,
    phone_verified: r.phone_verified === true,
    approved_at: (r.approved_at as string | null) ?? null,
    claimed_at: (r.claimed_at as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    created_at: (r.created_at as string) ?? "",
  };
}

// ============================================================================
// Phase 2: Talent claim — invite-status fetch + send-invite call
// Mirror of fetchTalentInviteStatuses / sendClaimInvites in /admin/talent.
// Only difference: source_table = 'hire_remote_profiles'.
// ============================================================================

export async function fetchRemoteInviteStatuses(
  profileIds: string[],
): Promise<Record<string, InviteStatus>> {
  await requireAdmin();
  if (profileIds.length === 0) return {};

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("talent_claim_tokens")
    .select("candidate_id, status, created_at")
    .in("candidate_id", profileIds)
    .eq("source_table", "hire_remote_profiles")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[talent_claim_tokens] remote read failed:", error);
    return {};
  }

  const result: Record<string, InviteStatus> = {};
  for (const row of (data ?? []) as Array<{
    candidate_id: string;
    status: string;
  }>) {
    if (result[row.candidate_id]) continue;
    result[row.candidate_id] = row.status as InviteStatus;
  }
  return result;
}

export async function sendRemoteClaimInvites(
  profileIds: string[],
): Promise<{ success: boolean; sent: number; skipped: unknown[]; error?: string }> {
  await requireAdmin();

  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://remotiv.work";

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
      body: JSON.stringify({ profileIds, sourceTable: "hire_remote_profiles" }),
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
    console.error("[sendRemoteClaimInvites] fetch error:", e);
    return { success: false, sent: 0, skipped: [], error: "Network error" };
  }
}
