"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/app/ai-dashboard/lib/applicant-types";
import type {
  ActivityItem,
  FunnelStep,
  LiveRole,
  OverviewData,
  RecentApplicant,
} from "./overview-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shared types live in ./overview-types.ts.

const WEEK_MS = 7 * 86_400_000;

/**
 * Card caps. Both sections are fixed-height regardless of how much data the
 * workspace holds: five rows and four role cards, with the section's "All N →"
 * link carrying the rest.
 */
const RECENT_APPLICANT_LIMIT = 5;
const LIVE_ROLE_LIMIT = 4;

/** Steps the hero funnel draws, in order. Offer and Rejected are deliberately
 *  absent: the mock's funnel is the forward path, and a rejected count sitting
 *  inside it would read as progress. */
const FUNNEL_STAGES: ReadonlyArray<PipelineStage> = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "hired",
];

const EMPTY: OverviewData = {
  totalApplicants: 0,
  newThisWeek: 0,
  screenedCount: 0,
  funnel: FUNNEL_STAGES.map((stage) => ({ stage, count: 0, pct: 0 })),
  publishedJobs: 0,
  draftJobs: 0,
  soleDraftId: null,
  soleDraftTitle: null,
  awaitingReview: 0,
  pendingInvites: 0,
  liveRoles: [],
  recentApplicants: [],
  activity: [],
};

type JobRow = {
  id: string;
  title: string | null;
  category: string | null;
  status: string | null;
  created_at: string | null;
};

type AppRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  pipeline_stage: string | null;
  screening_answers: unknown;
  created_at: string | null;
};

type HistoryRow = {
  id: string;
  application_id: string | null;
  from_stage: string | null;
  to_stage: string | null;
  changed_by_name: string | null;
  created_at: string | null;
};

/** Range-paged read: both tables have hit the PostgREST 1000-row cap before,
 *  and an unbounded select silently truncates rather than erroring. */
async function pageAll<T>(
  // PromiseLike, not Promise: a PostgREST query builder is thenable but has no
  // .catch/.finally, so it doesn't satisfy the Promise interface.
  run: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: unknown }>,
  label: string,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) {
      console.error(`[overview] ${label} failed:`, error);
      return rows;
    }
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function fullName(r: AppRow): string {
  const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
  return name || r.email?.split("@")[0] || "Someone";
}

/**
 * Everything the Overview renders, in four queries.
 *
 * Scoped exactly as the other pages are: jobs on company_id, applications on
 * company_id_snapshot (which survives job deletion, unlike a join through
 * jobs.company_id), history and invites on company_id. Nothing here is
 * hardcoded — every figure is counted from these rows.
 */
export async function fetchOverview(): Promise<OverviewData> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const now = Date.now();
  const weekAgoIso = new Date(now - WEEK_MS).toISOString();

  const [jobs, apps, history, invites] = await Promise.all([
    pageAll<JobRow>(
      (from, to) =>
        service
          .from("jobs")
          .select("id, title, category, status, created_at")
          .eq("company_id", ctx.companyId)
          .order("created_at", { ascending: false })
          .range(from, to),
      "jobs",
    ),
    pageAll<AppRow>(
      (from, to) =>
        service
          .from("job_applications")
          .select(
            "id, first_name, last_name, email, job_id, job_title_snapshot, pipeline_stage, screening_answers, created_at",
          )
          .eq("company_id_snapshot", ctx.companyId)
          .order("created_at", { ascending: false })
          .range(from, to),
      "applications",
    ),
    service
      .from("application_stage_history")
      .select("id, application_id, from_stage, to_stage, changed_by_name, created_at")
      .eq("company_id", ctx.companyId)
      .order("created_at", { ascending: false })
      .limit(12)
      .then(({ data, error }) => {
        if (error) console.error("[overview] history failed:", error);
        return (data ?? []) as HistoryRow[];
      }),
    service
      .from("company_members")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      .eq("status", "invited")
      .then(({ count, error }) => {
        if (error) console.error("[overview] invites failed:", error);
        return count ?? 0;
      }),
  ]);

  if (jobs.length === 0 && apps.length === 0) {
    return { ...EMPTY, pendingInvites: invites };
  }

  // ── Applications ───────────────────────────────────────────
  const stageOf = (r: AppRow): PipelineStage =>
    (PIPELINE_STAGES as readonly string[]).includes(r.pipeline_stage ?? "")
      ? (r.pipeline_stage as PipelineStage)
      : "applied";

  const isRecent = (iso: string | null) =>
    !!iso && now - new Date(iso).getTime() <= WEEK_MS;

  const total = apps.length;
  const newThisWeek = apps.filter((a) => isRecent(a.created_at)).length;
  const screenedCount = apps.filter(
    (a) => Array.isArray(a.screening_answers) && a.screening_answers.length > 0,
  ).length;
  const awaitingReview = apps.filter((a) => stageOf(a) === "applied").length;

  const funnel: FunnelStep[] = FUNNEL_STAGES.map((stage) => {
    const count = apps.filter((a) => stageOf(a) === stage).length;
    return {
      stage,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });

  // ── Jobs ───────────────────────────────────────────────────
  const published = jobs.filter((j) => j.status === "open");
  const drafts = jobs.filter((j) => j.status === "on_hold");

  const byJob = new Map<string, { total: number; recent: number }>();
  for (const a of apps) {
    if (!a.job_id) continue;
    const entry = byJob.get(a.job_id) ?? { total: 0, recent: 0 };
    entry.total += 1;
    if (isRecent(a.created_at)) entry.recent += 1;
    byJob.set(a.job_id, entry);
  }

  /**
   * Top roles by volume, capped so the strip's height is fixed no matter how
   * many roles are published. Ties break on created_at (newest first) then id:
   * without a total order the sort may reorder equal counts between renders
   * and the cards would shuffle on every refresh.
   */
  const liveRoles: LiveRole[] = published
    .map((j) => ({
      id: j.id,
      title: j.title?.trim() || "Untitled role",
      category: j.category?.trim() || "",
      applicants: byJob.get(j.id)?.total ?? 0,
      newThisWeek: byJob.get(j.id)?.recent ?? 0,
      createdAt: j.created_at ?? "",
    }))
    .sort((a, b) => {
      if (b.applicants !== a.applicants) return b.applicants - a.applicants;
      const byDate =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    })
    .slice(0, LIVE_ROLE_LIMIT)
    .map(({ createdAt: _createdAt, ...role }) => role);

  // Newest first — apps is already ordered created_at desc by the query.
  const recentApplicants: RecentApplicant[] = apps
    .slice(0, RECENT_APPLICANT_LIMIT)
    .map((a) => ({
    id: a.id,
    name: fullName(a),
    jobTitle:
      jobs.find((j) => j.id === a.job_id)?.title?.trim() ||
      a.job_title_snapshot?.trim() ||
      "—",
    stage: stageOf(a),
    createdAt: a.created_at ?? "",
  }));

  // ── Activity feed ──────────────────────────────────────────
  // Three real sources merged and re-sorted: stage moves, new applications,
  // and job publications. No synthetic "AI screened N" entries.
  const appById = new Map(apps.map((a) => [a.id, a]));

  const stageItems: ActivityItem[] = history
    .filter((h) => h.to_stage && h.created_at)
    .map((h) => {
      const app = h.application_id ? appById.get(h.application_id) : undefined;
      const to = h.to_stage as PipelineStage;
      return {
        id: `stage-${h.id}`,
        kind: "stage" as const,
        subject: app ? fullName(app) : "An applicant",
        predicate: h.from_stage
          ? `was moved to ${to}`
          : `entered the pipeline as ${to}`,
        actor: h.changed_by_name?.trim() || null,
        createdAt: h.created_at as string,
      };
    });

  const applyItems: ActivityItem[] = apps.slice(0, 6).map((a) => ({
    id: `apply-${a.id}`,
    kind: "applied" as const,
    subject: fullName(a),
    predicate: `applied for ${
      jobs.find((j) => j.id === a.job_id)?.title?.trim() ||
      a.job_title_snapshot?.trim() ||
      "a role"
    }`,
    actor: null,
    createdAt: a.created_at ?? "",
  }));

  const jobItems: ActivityItem[] = published.slice(0, 4).map((j) => ({
    id: `job-${j.id}`,
    kind: "published" as const,
    subject: j.title?.trim() || "A role",
    predicate: "was published",
    actor: null,
    createdAt: j.created_at ?? "",
  }));

  const activity = [...stageItems, ...applyItems, ...jobItems]
    .filter((i) => i.createdAt)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 6);

  return {
    totalApplicants: total,
    newThisWeek,
    screenedCount,
    funnel,
    publishedJobs: published.length,
    draftJobs: drafts.length,
    soleDraftId: drafts.length === 1 ? drafts[0].id : null,
    soleDraftTitle: drafts.length === 1 ? (drafts[0].title?.trim() ?? null) : null,
    awaitingReview,
    pendingInvites: invites,
    liveRoles,
    recentApplicants,
    activity,
  };
}
