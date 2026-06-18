import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ApplicationsDashboard } from "@/app/admin/_components/applications-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import type { JobApplication, OpenJob } from "./actions";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const { search: initialSearch } = await searchParams;

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [{ data: apps }, { data: jobs }, { data: roleRow }] = await Promise.all([
    service
      .from("job_applications")
      .select("*, jobs(title)")
      .order("created_at", { ascending: false }),
    service
      .from("jobs")
      .select("id, title")
      .eq("status", "open")
      .order("title", { ascending: true }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  // Phase 3: "already moved" detection. Normalise each application's email
  // (lowercase + trim, matching moveApplicationToTalent's L160 + the
  // normalizeEmail helper in src/lib/normalize.ts:13). One IN query collects
  // every talent_profiles row whose email is in the page's set, and we build
  // a lookup set the mapper uses to set `alreadyMoved` per row.
  const normaliseEmail = (raw: unknown): string =>
    typeof raw === "string" ? raw.toLowerCase().trim() : "";

  const normalisedEmails = Array.from(
    new Set(
      (apps ?? [])
        .map((a) => normaliseEmail((a as Record<string, unknown>).email))
        .filter((e) => e.length > 0),
    ),
  );

  let movedEmails = new Set<string>();
  if (normalisedEmails.length > 0) {
    const { data: movedRows } = await service
      .from("talent_profiles")
      .select("email")
      .in("email", normalisedEmails)
      // Archived profiles are tombstones — they no longer count as "in Talent"
      // for the move-button gate. Re-moving the same applicant restores the
      // archived row server-side; see moveApplicationToTalent's archived branch.
      .eq("is_archived", false);
    movedEmails = new Set(
      ((movedRows ?? []) as Array<{ email: string | null }>)
        .map((r) => normaliseEmail(r.email))
        .filter((e) => e.length > 0),
    );
  }

  const applications: JobApplication[] = (apps ?? []).map((a: Record<string, unknown>) => ({
    id: a.id as string,
    job_id: a.job_id as string | null,
    first_name: a.first_name as string,
    last_name: a.last_name as string,
    email: a.email as string,
    phone: a.phone as string,
    linkedin_url: (a.linkedin_url as string | null) ?? null,
    cv_url: a.cv_url as string,
    status: a.status as JobApplication["status"],
    source: ((a.source as JobApplication["source"]) ?? "job_application"),
    notes: (a.notes as string | null) ?? null,
    created_at: a.created_at as string,
    job_title: (a.jobs as { title?: string } | null)?.title ?? null,
    alreadyMoved: movedEmails.has(normaliseEmail(a.email)),
  }));

  const openJobs: OpenJob[] = (jobs ?? []) as OpenJob[];

  return (
    <ApplicationsDashboard
      email={userEmail}
      userRole={userRole}
      initialApplications={applications}
      openJobs={openJobs}
      initialSearch={initialSearch ?? ""}
    />
  );
}
