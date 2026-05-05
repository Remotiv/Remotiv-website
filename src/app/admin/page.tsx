import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { OverviewDashboard } from "./_components/overview-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "./lib/roles";

export const dynamic = "force-dynamic";

// ── Types shared with the client component ──────────────────

export type MetricResult = {
  current: number;
  previous: number;
  trend: number;
  up: boolean;
};

export type DashboardStats = {
  talent: MetricResult;
  remote: MetricResult;
  applications: MetricResult;
  jobs: MetricResult;
  clients: MetricResult;
  batches: MetricResult;
  bookings: MetricResult;
  contacts: MetricResult;
};

export type SubmissionsDay = {
  date: string;
  label: string;
  talent: number;
  remote: number;
  applications: number;
};

export type StatusSlice = { name: string; value: number };

export type PipelineSlice = { name: string; value: number; color: string };

export type ActivityKind =
  | "talent"
  | "application"
  | "decision"
  | "booking"
  | "inquiry";

export type ActivityItem = {
  id: string;
  type: ActivityKind;
  title: string;
  subtitle: string;
  time: string;
  link: string;
};

// ── Query helpers ────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function calculateMetric(
  supabase: SupabaseClient,
  table: string,
  filter?: { column: string; value: string },
): Promise<MetricResult> {
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * DAY_MS).toISOString();
  const sixtyDaysAgo = new Date(now - 60 * DAY_MS).toISOString();

  const total = supabase.from(table).select("*", { count: "exact", head: true });
  const recent = supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .gte("created_at", thirtyDaysAgo);
  const prior = supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .gte("created_at", sixtyDaysAgo)
    .lt("created_at", thirtyDaysAgo);

  const totalQ = filter ? total.eq(filter.column, filter.value) : total;
  const recentQ = filter ? recent.eq(filter.column, filter.value) : recent;
  const priorQ = filter ? prior.eq(filter.column, filter.value) : prior;

  const [{ count: totalCount }, { count: recentCount }, { count: priorCount }] =
    await Promise.all([totalQ, recentQ, priorQ]);

  const current = totalCount ?? 0;
  const previous = priorCount ?? 0;
  const recentN = recentCount ?? 0;

  let trend = 0;
  let up = true;
  if (previous === 0 && recentN > 0) {
    trend = 100;
    up = true;
  } else if (previous === 0 && recentN === 0) {
    trend = 0;
    up = true;
  } else {
    const raw = Math.round(((recentN - previous) / previous) * 100);
    trend = Math.abs(raw);
    up = raw >= 0;
  }

  return { current, previous, trend, up };
}

async function fetchSubmissionsByDay(
  supabase: SupabaseClient,
): Promise<SubmissionsDay[]> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();

  const [talent, remote, applications] = await Promise.all([
    supabase.from("talent_profiles").select("created_at").gte("created_at", since),
    supabase
      .from("hire_remote_profiles")
      .select("created_at")
      .gte("created_at", since),
    supabase
      .from("job_applications")
      .select("created_at")
      .gte("created_at", since),
  ]);

  const buckets: Record<
    string,
    { talent: number; remote: number; applications: number }
  > = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS);
    buckets[d.toISOString().slice(0, 10)] = {
      talent: 0,
      remote: 0,
      applications: 0,
    };
  }

  function bucket(
    rows: Array<{ created_at: string | null }> | null,
    key: "talent" | "remote" | "applications",
  ) {
    for (const r of rows ?? []) {
      const k = r.created_at?.slice(0, 10) ?? "";
      if (buckets[k]) buckets[k][key]++;
    }
  }
  bucket(talent.data as Array<{ created_at: string | null }> | null, "talent");
  bucket(remote.data as Array<{ created_at: string | null }> | null, "remote");
  bucket(
    applications.data as Array<{ created_at: string | null }> | null,
    "applications",
  );

  return Object.entries(buckets).map(([date, counts]) => ({
    date,
    label: new Date(date).toLocaleDateString("en-GB", {
      month: "short",
      day: "numeric",
    }),
    ...counts,
  }));
}

async function fetchApplicationsByStatus(
  supabase: SupabaseClient,
): Promise<StatusSlice[]> {
  const { data } = await supabase.from("job_applications").select("status");
  const rows = (data ?? []) as Array<{ status: string | null }>;
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const s = r.status || "pending";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({
    name: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " "),
    value: count,
  }));
}

async function fetchPipelineStats(
  supabase: SupabaseClient,
): Promise<PipelineSlice[]> {
  const { data } = await supabase
    .from("client_batch_candidates")
    .select("client_decision");
  const rows = (data ?? []) as Array<{ client_decision: string | null }>;
  const total = rows.length;
  const approved = rows.filter((r) => r.client_decision === "approve").length;
  const rejected = rows.filter((r) => r.client_decision === "reject").length;
  const interview = rows.filter(
    (r) => r.client_decision === "request_interview",
  ).length;
  const pending = total - approved - rejected - interview;
  return [
    { name: "In Review", value: pending, color: "#9886FE" },
    { name: "Approved", value: approved, color: "#49D7A7" },
    { name: "Interview Requested", value: interview, color: "#7E47FF" },
    { name: "Rejected", value: rejected, color: "#FF6B6B" },
  ];
}

async function fetchActivityFeed(
  supabase: SupabaseClient,
): Promise<ActivityItem[]> {
  type TalentRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    created_at: string;
  };
  type AppRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    created_at: string;
  };
  type DecisionRow = {
    id: string;
    first_name: string | null;
    last_name: string | null;
    client_decision: string | null;
    client_decision_at: string | null;
    batch_id: string;
  };
  type BookingRow = {
    id: string;
    full_name: string | null;
    created_at: string;
  };
  type ContactRow = { id: string; name: string | null; created_at: string };

  const [talent, applications, decisions, bookings, contacts] =
    await Promise.all([
      supabase
        .from("talent_profiles")
        .select("id, first_name, last_name, created_at")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("job_applications")
        .select("id, first_name, last_name, created_at")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("client_batch_candidates")
        .select("id, first_name, last_name, client_decision, client_decision_at, batch_id")
        .not("client_decision", "is", null)
        .order("client_decision_at", { ascending: false })
        .limit(10),
      supabase
        .from("bookings")
        .select("id, full_name, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("contact_submissions")
        .select("id, name, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

  const items: ActivityItem[] = [];

  function fullName(first: string | null, last: string | null): string {
    return `${first ?? ""} ${last ?? ""}`.trim();
  }

  for (const r of (talent.data ?? []) as TalentRow[]) {
    items.push({
      id: `t-${r.id}`,
      type: "talent",
      title: fullName(r.first_name, r.last_name) || "New talent",
      subtitle: "Joined Talent Network",
      time: r.created_at,
      link: "/admin/talent",
    });
  }

  for (const r of (applications.data ?? []) as AppRow[]) {
    items.push({
      id: `a-${r.id}`,
      type: "application",
      title: fullName(r.first_name, r.last_name) || "New applicant",
      subtitle: "Applied for a job",
      time: r.created_at,
      link: "/admin/applications",
    });
  }

  for (const r of (decisions.data ?? []) as DecisionRow[]) {
    if (!r.client_decision_at) continue;
    const name = fullName(r.first_name, r.last_name) || "candidate";
    const verb =
      r.client_decision === "approve"
        ? "approved"
        : r.client_decision === "reject"
          ? "rejected"
          : r.client_decision === "request_interview"
            ? "requested interview for"
            : "reviewed";
    items.push({
      id: `d-${r.id}`,
      type: "decision",
      title: `Client ${verb} ${name}`,
      subtitle: "Client Portal Decision",
      time: r.client_decision_at,
      link: `/admin/client-batches/${r.batch_id}`,
    });
  }

  for (const r of (bookings.data ?? []) as BookingRow[]) {
    items.push({
      id: `b-${r.id}`,
      type: "booking",
      title: r.full_name || "New booking",
      subtitle: "Booked a meeting",
      time: r.created_at,
      link: "/admin/contacts?tab=bookings",
    });
  }

  for (const r of (contacts.data ?? []) as ContactRow[]) {
    items.push({
      id: `c-${r.id}`,
      type: "inquiry",
      title: r.name || "New inquiry",
      subtitle: "Sent contact form",
      time: r.created_at,
      link: "/admin/contacts",
    });
  }

  return items
    .filter((i) => i.time)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 15);
}

// ── Page ─────────────────────────────────────────────────────

export default async function AdminOverviewPage() {
  const supabase = await createClient();
  const service = createServiceClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? "";
  const userEmail = user?.email ?? "";

  const [
    talent,
    remote,
    applications,
    jobs,
    clients,
    batches,
    bookings,
    contacts,
    submissionsByDay,
    applicationsByStatus,
    pipelineStats,
    activity,
    { data: roleRow },
  ] = await Promise.all([
    calculateMetric(service, "talent_profiles"),
    calculateMetric(service, "hire_remote_profiles"),
    calculateMetric(service, "job_applications"),
    calculateMetric(service, "jobs", { column: "status", value: "open" }),
    calculateMetric(service, "clients", { column: "status", value: "active" }),
    calculateMetric(service, "client_batches", {
      column: "status",
      value: "active",
    }),
    calculateMetric(service, "bookings"),
    calculateMetric(service, "contact_submissions"),
    fetchSubmissionsByDay(service),
    fetchApplicationsByStatus(service),
    fetchPipelineStats(service),
    fetchActivityFeed(service),
    service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else if (roleRow?.role) {
    userRole = roleRow.role as UserRole;
  }

  return (
    <OverviewDashboard
      email={userEmail}
      userRole={userRole}
      stats={{
        talent,
        remote,
        applications,
        jobs,
        clients,
        batches,
        bookings,
        contacts,
      }}
      submissionsByDay={submissionsByDay}
      applicationsByStatus={applicationsByStatus}
      pipelineStats={pipelineStats}
      activity={activity}
    />
  );
}
