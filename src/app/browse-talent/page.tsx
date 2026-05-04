import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL, type UserRole } from "@/app/admin/lib/roles";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

export default async function BrowseTalentPage() {
  // Auth-aware client (reads cookies) for the user lookup; service client
  // bypasses RLS for the admin_users role read and the public talent read.
  const auth = await createClient();
  const supabase = createServiceClient();

  const { data: { user } } = await auth.auth.getUser();
  const userEmail = user?.email ?? "";
  const userId = user?.id ?? "";

  let isAdminPreview = false;
  if (user) {
    if (userEmail === SUPER_ADMIN_EMAIL) {
      isAdminPreview = true;
    } else if (userId) {
      const { data: roleRow } = await supabase
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      const role = (roleRow?.role as UserRole | undefined) ?? null;
      isAdminPreview = role === "super_admin" || role === "admin";
    }
  }

  const { data } = await supabase
    .from("talent_profiles")
    .select(
      "id, first_name, last_name, email, phone, cv_url, job_title, role_category, years_experience, industry, degree, institution, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, linkedin_url, github_url, experience, approved_at, created_at",
    )
    .not("approved_at", "is", null)
    .order("created_at", { ascending: false });

  const rawProfiles = (data ?? []) as TalentRow[];

  // Strip unlocked fields for non-admin users — never let the client receive
  // contact info unless the server has confirmed admin role. The client only
  // *renders* admin UI when isAdminPreview is true, but we belt-and-suspenders
  // by also nulling the underlying values so a tampered client can't read them.
  const realProfiles: TalentRow[] = rawProfiles.map((p) => ({
    ...p,
    email:        isAdminPreview ? p.email        : null,
    phone:        isAdminPreview ? p.phone        : null,
    cv_url:       isAdminPreview ? p.cv_url       : null,
    linkedin_url: isAdminPreview ? p.linkedin_url : null,
  }));

  return <BrowseClient realProfiles={realProfiles} isAdminPreview={isAdminPreview} />;
}
