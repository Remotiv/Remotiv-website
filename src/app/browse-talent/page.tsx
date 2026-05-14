import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL, type UserRole } from "@/app/admin/lib/roles";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

export default async function BrowseTalentPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  // Future-proof for B-2 pagination; not consumed yet.
  const _params = await searchParams;

  // Auth-aware client (reads cookies) for user + subscription lookup; service
  // client bypasses RLS for the admin_users role read and the public talent fetch.
  const auth = await createClient();
  const supabase = createServiceClient();

  const { data: { user } } = await auth.auth.getUser();
  const userEmail = user?.email ?? "";
  const userId = user?.id ?? "";

  let tier: "free" | "subscriber" = "free";
  if (user) {
    if (userEmail === SUPER_ADMIN_EMAIL) {
      tier = "subscriber";
    } else if (userId) {
      const { data: roleRow } = await supabase
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      const role = (roleRow?.role as UserRole | undefined) ?? null;
      if (role === "super_admin" || role === "admin") {
        tier = "subscriber";
      } else {
        const { data: sub } = await auth
          .from("subscriptions")
          .select("tier")
          .eq("user_id", userId)
          .maybeSingle();
        if (sub?.tier === "starter" || sub?.tier === "pro") {
          tier = "subscriber";
        }
      }
    }
  }

  let talentQuery = supabase
    .from("talent_profiles")
    .select(
      "id, first_name, last_name, email, phone, cv_url, job_title, role_category, years_experience, industry, degree, institution, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, linkedin_url, github_url, experience, approved_at, created_at",
    )
    .not("approved_at", "is", null)
    .order("created_at", { ascending: false });

  if (tier === "free") {
    talentQuery = talentQuery.limit(15);
  }

  const { data } = await talentQuery;
  const rows = (data ?? []) as TalentRow[];

  const realProfiles: TalentRow[] = tier === "subscriber"
    ? rows
    : rows.map((row) => ({
        ...row,
        email: null,
        phone: null,
        cv_url: null,
        linkedin_url: null,
      }));

  return <BrowseClient realProfiles={realProfiles} tier={tier} />;
}
