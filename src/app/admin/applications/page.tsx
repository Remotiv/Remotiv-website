import type { ScreeningAnswerSnapshot } from "@/lib/jobs";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ApplicationsDashboard } from "@/app/admin/_components/applications-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import type { ApplicationTag, JobApplication, OpenJob } from "./actions";

export const dynamic = "force-dynamic";

// Range-paged fetch of every job_application. Supabase/PostgREST caps any
// unbounded select at 1000 rows, so we page through in 1000-row batches and
// concat until a short page signals the end. Light column list only — the
// heavy extracted-resume text column (unused by the list mapper, potentially
// KB-sized per row) is intentionally excluded. Mirrors the original query's
// ordering; the original list query had no row filters.
async function fetchAllApplications(
  service: ReturnType<typeof createServiceClient>,
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const cols =
    "id, job_id, first_name, last_name, email, phone, linkedin_url, cv_url, status, source, notes, created_at, screening_answers, job_title_snapshot, jobs(title)";
  let from = 0;
  const all: Record<string, unknown>[] = [];
  for (;;) {
    const { data, error } = await service
      .from("job_applications")
      .select(cols)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    all.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

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

  // Phase 2: per-admin private tags. One batched query against
  // application_admin_tags filtered by the current admin's auth user id —
  // returns ONLY this admin's rows, never another admin's. Runs in parallel
  // with the apps/jobs/role queries via Promise.all.
  const [apps, { data: jobs }, { data: roleRow }, { data: tagRows }] = await Promise.all([
    fetchAllApplications(service),
    service
      .from("jobs")
      .select("id, title")
      .eq("status", "open")
      .order("title", { ascending: true }),
    service.from("admin_users").select("role").eq("user_id", userId).maybeSingle(),
    service
      .from("application_admin_tags")
      .select("application_id, tag")
      .eq("admin_user_id", userId),
  ]);

  const tagMap = new Map<string, ApplicationTag[]>();
  for (const r of (tagRows ?? []) as Array<{ application_id: string; tag: string }>) {
    const existing = tagMap.get(r.application_id);
    if (existing) {
      existing.push(r.tag as ApplicationTag);
    } else {
      tagMap.set(r.application_id, [r.tag as ApplicationTag]);
    }
  }

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  // Phase 3: "already moved" detection. Normalise each application's email
  // (lowercase + trim, matching moveApplicationToTalent's L160 + the
  // normalizeEmail helper in src/lib/normalize.ts:13) and check it against the
  // set of emails already in the Pakistan talent pool.
  const normaliseEmail = (raw: unknown): string =>
    typeof raw === "string" ? raw.toLowerCase().trim() : "";

  // Build the set of emails already in the Pakistan talent pool (non-archived).
  // Range-page through ALL talent emails instead of a giant .in() on the
  // applications list — a ~1400-item .in() overflows the request URL and
  // silently fails, which previously blanked every "Already in Talent" badge.
  // Archived profiles are tombstones — they no longer count as "in Talent"
  // for the move-button gate; re-moving restores them server-side (see
  // moveApplicationToTalent's archived branch).
  const movedEmails = new Set<string>();
  {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data: movedRows, error: movedErr } = await service
        .from("talent_profiles")
        .select("email")
        .eq("is_archived", false)
        .range(from, from + PAGE - 1);
      if (movedErr) throw movedErr;
      const batch = movedRows ?? [];
      for (const r of batch) {
        const e = normaliseEmail((r as { email: string | null }).email);
        if (e.length > 0) movedEmails.add(e);
      }
      if (batch.length < PAGE) break;
      from += PAGE;
    }
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
    job_title: (a.jobs as { title?: string } | null)?.title ?? (a.job_title_snapshot as string | null) ?? null,
    alreadyMoved: movedEmails.has(normaliseEmail(a.email)),
    myTags: tagMap.get(a.id as string) ?? [],
    screening_answers: (a.screening_answers as ScreeningAnswerSnapshot[]) ?? [],
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
