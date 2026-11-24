import { createClient, createServiceClient } from "@/lib/supabase/server";
import { JobsDashboard } from "../_components/jobs-dashboard";
import type { Job } from "./actions";
import { type UserRole, isSuperAdminEmail } from "../lib/roles";

export const dynamic = "force-dynamic";

/**
 * Exactly the columns JobsDashboard reads (cards, table, filters, the edit
 * form, JobOrderCell's display_order), never `*`: a new column on jobs must not
 * reach this page by default. In particular migration 074's hiring challenges
 * are private to the company's live interview and are not selected here.
 * jobs-select.test.ts pins this list.
 */
const ADMIN_JOB_COLUMNS =
  "id, title, company, company_rating, location, salary_min, salary_max, salary_currency, contract_type, work_type, category, experience_level, language, positions, description, responsibilities, requirements, screening_questions, display_order, status, created_at, deleted_at";

export default async function AdminJobsPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: jobs }, { data: roleRow }] = await Promise.all([
    // Deliberately unfiltered on `deleted_at` — this is the one list that must
    // see tombstones, because the recovery view is a filter on it rather than a
    // separate page. JobsDashboard hides them from every other filter state.
    service
      .from("jobs")
      .select(ADMIN_JOB_COLUMNS)
      .order("display_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (isSuperAdminEmail(userEmail)) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <JobsDashboard
      email={userEmail}
      userRole={userRole}
      initialJobs={(jobs ?? []) as Job[]}
    />
  );
}
