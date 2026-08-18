import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { type Job, LIST_SELECT, publiclyVisible } from "@/lib/jobs";
import { DashboardClient, type DashboardProfile } from "./_dashboard-client";
import {
  computeCompleteness,
  getMissingHighValueFields,
} from "./_completeness";

export const dynamic = "force-dynamic";

const TALENT_COLUMNS =
  "id, first_name, last_name, email, phone, city, country, linkedin_url, job_title, role_category, years_experience, industry, summary, availability, work_type, salary_min, salary_max, avatar_url, cv_url, skills, experience, status, claimed_at, approved_at";

const REMOTE_COLUMNS =
  "id, first_name, last_name, email, phone, city, country, time_zone, linkedin_url, job_titles, bio, hourly_rate, hours_per_week, work_type, availability, photo_path, cv_path, skills, employment_history, education, languages, portfolio, status, claimed_at, approved_at, email_verified";

export default async function TalentDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    profile_id?: string;
    source_table?: string;
  }>;
}) {
  const sp = await searchParams;
  // Defense in depth: re-validate the params even though /talent/login
  // already filtered them. A user typing the URL by hand still has to clear
  // the same checks.
  const validAutoClaimProfileId =
    typeof sp.profile_id === "string" &&
    /^[0-9a-fA-F-]{36}$/.test(sp.profile_id)
      ? sp.profile_id
      : null;
  const validAutoClaimSourceTable =
    sp.source_table === "talent_profiles" ||
    sp.source_table === "hire_remote_profiles"
      ? sp.source_table
      : null;
  const autoClaimProfileId =
    validAutoClaimProfileId && validAutoClaimSourceTable
      ? validAutoClaimProfileId
      : null;
  const autoClaimSourceTable =
    validAutoClaimProfileId && validAutoClaimSourceTable
      ? validAutoClaimSourceTable
      : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    redirect("/talent/login?reason=unauthorized");
  }

  const service = createServiceClient();
  const normalisedEmail = user.email.toLowerCase();

  const [{ data: talentRow }, { data: remoteRow }, { data: liveJobs }] =
    await Promise.all([
      service
        .from("talent_profiles")
        .select(TALENT_COLUMNS)
        .eq("email", normalisedEmail)
        .maybeSingle(),
      service
        .from("hire_remote_profiles")
        .select(REMOTE_COLUMNS)
        .eq("email", normalisedEmail)
        .maybeSingle(),
      publiclyVisible(service.from("jobs").select(LIST_SELECT)).order(
        "created_at",
        { ascending: false },
      ),
    ]);

  const jobs = (liveJobs ?? []) as unknown as Job[];

  const profiles: DashboardProfile[] = [];

  if (talentRow) {
    const r = talentRow as Record<string, unknown>;
    profiles.push({
      id: String(r.id ?? ""),
      sourceTable: "talent_profiles",
      poolLabel: "Pakistan Talent",
      firstName: (r.first_name as string | null) ?? "",
      lastName: (r.last_name as string | null) ?? null,
      email: (r.email as string) ?? user.email,
      claimedAt: (r.claimed_at as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      status: (r.status as string | null) ?? "pending",
      matchScore: computeCompleteness(r, "talent_profiles"),
      missingHighValueFields: getMissingHighValueFields(r, "talent_profiles"),
      raw: r,
    });
  }

  if (remoteRow) {
    const r = remoteRow as Record<string, unknown>;
    profiles.push({
      id: String(r.id ?? ""),
      sourceTable: "hire_remote_profiles",
      poolLabel: "Remote Ready",
      firstName: (r.first_name as string | null) ?? "",
      lastName: (r.last_name as string | null) ?? null,
      email: (r.email as string) ?? user.email,
      claimedAt: (r.claimed_at as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
      status: (r.status as string | null) ?? "pending",
      matchScore: computeCompleteness(r, "hire_remote_profiles"),
      missingHighValueFields: getMissingHighValueFields(
        r,
        "hire_remote_profiles",
      ),
      raw: r,
    });
  }

  // Collect profile IDs for the shortlisted-count query.
  // client_batch_candidates uses (source_type, source_id); UUIDs are unique
  // across pools so .in("source_id", profileIds) is functionally safe.
  const profileIds = profiles.map((p) => p.id).filter(Boolean);

  const [notificationsRes, shortlistedRes, applicationsRes] = await Promise.all(
    [
      service
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("recipient_user_id", user.id)
        .is("read_at", null),
      profileIds.length > 0
        ? service
            .from("client_batch_candidates")
            .select("id", { count: "exact", head: true })
            .in("source_id", profileIds)
        : Promise.resolve({ count: 0, error: null }),
      service
        .from("job_applications")
        .select("id, job_id, status, created_at, jobs(title, company)")
        .eq("email", normalisedEmail)
        .order("created_at", { ascending: false })
        .limit(3),
    ],
  );

  const unreadCount = notificationsRes.error
    ? 0
    : (notificationsRes.count ?? 0);
  const shortlistedCount = shortlistedRes.error
    ? 0
    : (shortlistedRes.count ?? 0);
  const rawApplications = applicationsRes.error
    ? []
    : (applicationsRes.data ?? []);

  const recentApplications = (
    rawApplications as Array<Record<string, unknown>>
  ).map((a) => {
    const job = a.jobs as { title?: string; company?: string } | null;
    return {
      id: String(a.id ?? ""),
      jobId: (a.job_id as string | null) ?? "",
      jobTitle: job?.title ?? "(Untitled job)",
      company: job?.company ?? null,
      status: (a.status as string | null) ?? "submitted",
      createdAt: (a.created_at as string | null) ?? "",
    };
  });

  return (
    <DashboardClient
      email={user.email}
      profiles={profiles}
      jobs={jobs}
      unreadCount={unreadCount}
      shortlistedCount={shortlistedCount}
      recentApplications={recentApplications}
      autoClaimProfileId={autoClaimProfileId}
      autoClaimSourceTable={autoClaimSourceTable}
    />
  );
}
