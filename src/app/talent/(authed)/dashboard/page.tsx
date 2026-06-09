import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { type Job, LIST_SELECT } from "@/lib/jobs";
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

export default async function TalentDashboardPage() {
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
      service
        .from("jobs")
        .select(LIST_SELECT)
        .eq("status", "open")
        .order("created_at", { ascending: false }),
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

  return (
    <DashboardClient email={user.email} profiles={profiles} jobs={jobs} />
  );
}
