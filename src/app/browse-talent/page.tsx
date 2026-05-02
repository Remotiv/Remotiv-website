import { createServiceClient } from "@/lib/supabase/server";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

export default async function BrowseTalentPage() {
  // Service client bypasses RLS — this is a public read of approved talent.
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("talent_profiles")
    .select(
      "id, first_name, last_name, job_title, role_category, years_experience, industry, degree, institution, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, linkedin_url, github_url, experience, approved_at, created_at",
    )
    .not("approved_at", "is", null)
    .order("created_at", { ascending: false });

  const realProfiles = (data ?? []) as TalentRow[];

  return <BrowseClient realProfiles={realProfiles} />;
}
