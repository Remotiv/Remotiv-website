import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { computeCompleteness } from "../_completeness";
import { EditClient, type EditableProfile } from "./_edit-client";

export const dynamic = "force-dynamic";

const TALENT_COLUMNS =
  "id, first_name, last_name, email, phone, linkedin_url, city, country, job_title, role_category, years_experience, industry, summary, availability, work_type, salary_min, salary_max, skills, experience, user_id, status, claimed_at, approved_at";

const REMOTE_COLUMNS =
  "id, first_name, last_name, email, phone, linkedin_url, city, country, time_zone, job_titles, bio, hourly_rate, hours_per_week, work_type, availability, available_from_date, photo_path, cv_path, skills, employment_history, education, languages, portfolio, user_id, status, claimed_at, approved_at, email_verified";

export default async function TalentDashboardEditPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    redirect("/talent/login?reason=unauthorized");
  }

  const service = createServiceClient();
  const normalisedEmail = user.email.toLowerCase();

  const [{ data: talentRow }, { data: remoteRow }] = await Promise.all([
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
  ]);

  const profiles: EditableProfile[] = [];

  if (talentRow) {
    const r = talentRow as Record<string, unknown>;
    profiles.push({
      id: String(r.id ?? ""),
      sourceTable: "talent_profiles",
      poolLabel: "Pakistan Talent",
      firstName: (r.first_name as string | null) ?? "",
      lastName: (r.last_name as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      linkedinUrl: (r.linkedin_url as string | null) ?? null,
      email: (r.email as string) ?? user.email,
      matchScore: computeCompleteness(r, "talent_profiles"),
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
      phone: (r.phone as string | null) ?? null,
      linkedinUrl: (r.linkedin_url as string | null) ?? null,
      email: (r.email as string) ?? user.email,
      matchScore: computeCompleteness(r, "hire_remote_profiles"),
      raw: r,
    });
  }

  return <EditClient email={user.email} profiles={profiles} />;
}
