"use server";

import { revalidatePath } from "next/cache";
import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";
import { getAvatarUrl } from "@/lib/avatars";
import { requireAdmin, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { isValidEmail, trimRequired, trimToNull } from "@/app/admin/lib/validators";

export type ApplicationStatus = "new" | "shortlisted" | "not_a_fit" | "maybe";
export type ApplicationSource = "job_application" | "manual_upload";

// Per-admin private tag values. Backed by application_admin_tags (migration
// 015); each admin's tags are isolated server-side via the admin_user_id
// filter on the page-load query. Distinct from the shared `status` enum,
// which is still in use for the legacy single-status badge.
export type ApplicationTag = "shortlist" | "maybe" | "not_a_fit";

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
  // Phase 3: read-only UI hint set by /admin/applications/page.tsx after a
  // batched lookup against talent_profiles.email. true when a talent_profiles
  // row already exists for this application's normalised email, so the
  // dashboard can disable "Move to Talent" + show an "Already in Talent" badge.
  // Derived, never persisted.
  alreadyMoved: boolean;
  // The CURRENT admin's private tags for this application — never another
  // admin's. Populated by page.tsx from a single batched query against
  // application_admin_tags filtered by admin_user_id = current user. Always
  // an array (possibly empty). Derived, never persisted on JobApplication
  // itself.
  myTags: ApplicationTag[];
  // Frozen screening-answer snapshot from job_applications.screening_answers
  // (jsonb). Always an array (DB default '[]'); empty when the job had no
  // screening questions. Display-only — already scored at apply time.
  screening_answers: ScreeningAnswerSnapshot[];
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

// Phase 3: per-admin private tag toggle. Off → insert (data.tagged = true);
// on → delete (data.tagged = false). The admin id is read from the auth
// session via requireAdmin() — callers cannot spoof another admin's id.
// Mirrors setTalentFlag's structure (role guard → service client →
// inspect-then-mutate → revalidate).
export async function toggleApplicationTag(
  applicationId: string,
  tag: ApplicationTag,
): Promise<MutationResult<{ tagged: boolean }>> {
  const ctx = await requireAdmin();
  const adminUserId = ctx.user.id;
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from("application_admin_tags")
    .select("id")
    .eq("application_id", applicationId)
    .eq("admin_user_id", adminUserId)
    .eq("tag", tag)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("application_admin_tags")
      .delete()
      .eq("id", (existing as { id: string }).id);
    if (error) return { success: false, error: error.message };
    revalidatePath("/admin/applications");
    return { success: true, data: { tagged: false } };
  }

  const { error } = await supabase
    .from("application_admin_tags")
    .insert({
      application_id: applicationId,
      admin_user_id: adminUserId,
      tag,
    });

  if (error) {
    // 23505 = unique_violation. Two rapid clicks can race past the
    // maybeSingle() check; the unique (application_id, admin_user_id, tag)
    // constraint on the join table catches it. Surface that as "already
    // tagged" rather than a user-facing error.
    if ((error as { code?: string }).code === "23505") {
      revalidatePath("/admin/applications");
      return { success: true, data: { tagged: true } };
    }
    return { success: false, error: error.message };
  }

  revalidatePath("/admin/applications");
  return { success: true, data: { tagged: true } };
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

  // 2. Duplicate-by-email guard against talent_profiles, with archived-aware
  // branching. An ACTIVE row (is_archived = false) blocks the move outright.
  // An ARCHIVED row (is_archived = true) is treated as a tombstone: re-moving
  // the same applicant restores the row in place (refreshing all profile
  // columns + flipping is_archived back to false) rather than inserting a
  // duplicate. Active is checked first so an active row always wins if both
  // somehow co-exist.
  const { data: activeExisting } = await supabase
    .from("talent_profiles")
    .select("id")
    .eq("email", email)
    .eq("is_archived", false)
    .maybeSingle();

  if (activeExisting) {
    return {
      success: false,
      error: "This applicant is already in the Talent network",
    };
  }

  const { data: archivedExisting } = await supabase
    .from("talent_profiles")
    .select("id")
    .eq("email", email)
    .eq("is_archived", true)
    .maybeSingle();

  // 3. Shared profile values — used by BOTH the INSERT (new row) and the
  // restore-UPDATE (archived row) paths so the two stay in lockstep.
  const profilePatch = {
    first_name:   typeof row.first_name   === "string" ? row.first_name   : "",
    last_name:    typeof row.last_name    === "string" ? row.last_name    : null,
    phone:        typeof row.phone        === "string" ? row.phone        : null,
    city:         typeof row.city         === "string" ? row.city         : null,
    country:      typeof row.country      === "string" ? row.country      : null,
    linkedin_url: typeof row.linkedin_url === "string" ? row.linkedin_url : null,
    github_url:   typeof row.github_url   === "string" ? row.github_url   : null,
    cv_url:       typeof row.cv_url       === "string" ? row.cv_url       : null,
    cv_path:      typeof row.cv_path      === "string" ? row.cv_path      : null,
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
  };

  if (archivedExisting) {
    // 3a. RESTORE branch — UPDATE the archived row in place, refresh all
    // profile columns, and flip is_archived back to false. Same revalidates as
    // the INSERT branch so /admin/applications and /admin/talent both reflect.
    const archivedId = (archivedExisting as { id: string }).id;
    const { error: updateErr } = await supabase
      .from("talent_profiles")
      .update({ ...profilePatch, is_archived: false })
      .eq("id", archivedId);

    if (updateErr) return { success: false, error: updateErr.message };

    revalidatePath("/admin/applications");
    revalidatePath("/admin/talent");
    return { success: true, data: { talent_id: archivedId } };
  }

  // 3b. INSERT branch — no existing row for this email, create a new one.
  const { data: inserted, error: insertErr } = await supabase
    .from("talent_profiles")
    .insert({ ...profilePatch, email })
    .select("id")
    .single();

  if (insertErr) return { success: false, error: insertErr.message };
  if (!inserted) return { success: false, error: "Insert returned no row." };

  revalidatePath("/admin/applications");
  revalidatePath("/admin/talent");
  return { success: true, data: { talent_id: (inserted as { id: string }).id } };
}

// ============================================================================
// K1 Phase 5: signed-URL CV access for /admin/applications
// ----------------------------------------------------------------------------
// The `cvs` storage bucket was flipped to private (Migration 004, K1 Phase 1)
// but this dashboard kept rendering legacy <a href={app.cv_url}> direct links
// pointing at /storage/v1/object/public/cvs/... — those return Supabase's
// "Bucket not found" error against a private bucket. This action mirrors the
// working pattern in browse-talent/actions.ts (getCvSignedUrl + signCvUrlAndLog)
// but queries `job_applications` instead of `talent_profiles`, so admin views
// of applicant CVs land on a short-lived signed URL backed by the same audit
// log every other CV grant writes to.
//
// Cannot directly import from browse-talent/actions.ts (second-Mac territory)
// — the helpers below replicate just what's needed for the admin/applications
// surface. Keep them in sync if the canonical helpers there change shape.
// ============================================================================

const CV_BUCKET = "cvs";
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — matches the canonical TTL in browse-talent/actions.ts

/**
 * Extract a bucket-relative path from a legacy public URL string. Mirrors
 * `deriveCvPathFromUrl` in browse-talent/actions.ts — used as a fallback for
 * older job_applications rows that have only `cv_url` and no `cv_path`.
 */
function deriveCvPathFromUrl(cvUrl: string | null | undefined): string | null {
  if (!cvUrl) return null;
  const match = String(cvUrl).match(
    /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
  );
  return match ? match[1] : null;
}

export type ApplicationCvSignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: "not_authenticated" | "cv_missing" | "internal_error" };

export async function getApplicationCvSignedUrl(
  applicationId: string,
): Promise<ApplicationCvSignedUrlResult> {
  // Input shape gate — same defensive check pattern used elsewhere.
  if (typeof applicationId !== "string" || applicationId.length < 1 || applicationId.length > 100) {
    return { ok: false, error: "internal_error" };
  }

  // requireAdmin throws if the caller isn't a logged-in admin. Convert that
  // throw into the discriminated-union shape so the client gets a clean
  // typed error instead of a server-action rejection.
  let adminCtx;
  try {
    adminCtx = await requireAdmin();
  } catch {
    return { ok: false, error: "not_authenticated" };
  }

  const service = createServiceClient();

  const { data: appRow, error: appErr } = await service
    .from("job_applications")
    .select("cv_path, cv_url")
    .eq("id", applicationId)
    .maybeSingle();
  if (appErr || !appRow) {
    return { ok: false, error: "cv_missing" };
  }

  // Prefer cv_path (the modern storage-relative key); fall back to extracting
  // it from a legacy cv_url for older rows that pre-date Migration 004's
  // backfill. Either way, what createSignedUrl wants is the bucket-relative
  // path, not the full URL.
  const cvPath =
    (appRow.cv_path as string | null) ??
    deriveCvPathFromUrl(appRow.cv_url as string | null);
  if (!cvPath) {
    return { ok: false, error: "cv_missing" };
  }

  const { data: signed, error: signErr } = await service.storage
    .from(CV_BUCKET)
    .createSignedUrl(cvPath, CV_SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return { ok: false, error: "internal_error" };
  }

  // Fire-and-forget audit log. Never await — a logging failure must not
  // block a successful grant. Schema (migration 004):
  //   user_id, candidate_id, source_table, was_admin, granted_at (default now())
  // Even though job_applications.id isn't strictly a "candidate", the table
  // is generic — source_table distinguishes the row's true origin.
  service
    .from("signed_url_logs")
    .insert({
      user_id: adminCtx.user.id,
      candidate_id: applicationId,
      source_table: "job_applications",
      was_admin: true,
    })
    .then(({ error }) => {
      if (error) console.error("[signed_url_logs insert]", error);
    });

  return { ok: true, url: signed.signedUrl };
}
