import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL, type UserRole } from "@/app/admin/lib/roles";
import { BrowseClient, type TalentRow } from "./_browse-client";

export const dynamic = "force-dynamic";

const VALID_ROLES = [
  "All",
  "Engineer",
  "SDR",
  "CS",
  "Design",
  "Data",
  "DevOps",
  "QA",
  "Marketing",
  "Ops",
  "Finance",
] as const;
type RoleFilter = (typeof VALID_ROLES)[number];

function escapeIlike(s: string): string {
  // Escape Postgres ILIKE wildcards (% and _) and the escape character (\).
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export default async function BrowseTalentPage({
  searchParams,
}: {
  searchParams: Promise<{
    role?: string;
    q?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;

  const roleParam = params.role ?? "All";
  const role: RoleFilter = (VALID_ROLES as readonly string[]).includes(roleParam)
    ? (roleParam as RoleFilter)
    : "All";
  const q = (params.q ?? "").trim().slice(0, 100);
  const sort: "match" | "name" = params.sort === "name" ? "name" : "match";
  const pageRaw = Number(params.page ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

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
      const userRole = (roleRow?.role as UserRole | undefined) ?? null;
      if (userRole === "super_admin" || userRole === "admin") {
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

  const PAGE_SIZE = tier === "free" ? 15 : 30;
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let talentQuery = supabase
    .from("talent_profiles")
    .select(
      "id, first_name, last_name, email, phone, cv_url, job_title, role_category, years_experience, industry, degree, institution, city, country, skills, summary, availability, work_type, notice_period, work_location, salary_min, salary_max, avatar_url, linkedin_url, github_url, experience, approved_at, created_at",
    )
    .not("approved_at", "is", null);

  let countQuery = supabase
    .from("talent_profiles")
    .select("id", { count: "exact", head: true })
    .not("approved_at", "is", null);

  if (role !== "All") {
    talentQuery = talentQuery.eq("role_category", role);
    countQuery = countQuery.eq("role_category", role);
  }

  if (q !== "") {
    const safeQ = escapeIlike(q);
    const orFilter = `first_name.ilike.%${safeQ}%,last_name.ilike.%${safeQ}%,job_title.ilike.%${safeQ}%`;
    talentQuery = talentQuery.or(orFilter);
    countQuery = countQuery.or(orFilter);
  }

  if (sort === "name") {
    talentQuery = talentQuery.order("first_name", { ascending: true });
  } else {
    talentQuery = talentQuery.order("created_at", { ascending: false });
  }

  talentQuery = talentQuery.range(from, to);

  const [talentResult, countResult] = await Promise.all([talentQuery, countQuery]);
  const rows = (talentResult.data ?? []) as TalentRow[];
  const totalCount = countResult.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const realProfiles: TalentRow[] = tier === "subscriber"
    ? rows
    : rows.map((row) => ({
        ...row,
        email: null,
        phone: null,
        cv_url: null,
        linkedin_url: null,
      }));

  return (
    <BrowseClient
      realProfiles={realProfiles}
      tier={tier}
      currentPage={page}
      totalPages={totalPages}
      totalCount={totalCount}
      pageSize={PAGE_SIZE}
      activeRole={role}
      activeQuery={q}
      activeSort={sort}
    />
  );
}
