"use server";

import { pageAll } from "@/lib/supabase/paging";
import { answered, type Read, unavailable } from "@/lib/supabase/read";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { getJobScope } from "@/app/ai-dashboard/lib/job-scope";
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
  pendingInvites: { ok: true, value: 0 },
  liveRoles: [],
  recentApplicants: [],
  activity: { ok: true, value: [] },
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


function fullName(r: AppRow): string {
  const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
  return name || r.email?.split("@")[0] || "Someone";
}

/** A job with its applications counted by an `!inner(count)` embed: `[{ count: n }]`. */
type JobCountRow = { id: string; job_applications: { count: number }[] | null };

/** A head count, or a thrown error: every figure here is stated out loud. */
async function headCount(
  label: string,
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
): Promise<number> {
  const { count, error } = await query;
  if (error || count === null) {
    throw new Error(`[overview] ${label} count failed: ${error?.message ?? "no count"}`);
  }
  return count;
}

/** The stages other than Applied, counted one by one. Applied is the rest. */
const NOT_APPLIED: ReadonlyArray<PipelineStage> = PIPELINE_STAGES.filter((s) => s !== "applied");

/**
 * Everything the Overview renders, counted in the database (#32).
 *
 * Scoped exactly as the other pages are: jobs on company_id, applications on
 * company_id_snapshot (which survives job deletion, unlike a join through
 * jobs.company_id), history and invites on company_id. Nothing here is
 * hardcoded: every figure is counted.
 *
 * No read here grows with the number of applicants. The hero and funnel are
 * head counts, the role cards are counts embedded in the jobs read, and the
 * only applicant rows transferred are the six newest and the few named in the
 * activity feed. This page used to drain every application in scope, names
 * and emails included, to tally them in memory: ten sequential 1,000-row
 * reads at 10,000 applicants.
 */
export async function fetchOverview(): Promise<OverviewData> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();
  const now = Date.now();
  const weekAgoIso = new Date(now - WEEK_MS).toISOString();

  /*
   * Every read below that touches applications or jobs carries the job scope
   * itself: `.in("id" | "job_id", jobIds)` for a scoped role, nothing for an
   * owner or admin. Conditional, never `.in(col, [])` for an unscoped role,
   * which would return nothing.
   */
  const scope = await getJobScope(ctx);
  if (scope.scoped && scope.jobIds.length === 0) return { ...EMPTY };

  /** This company's applications, narrowed to the role's jobs. Head count only. */
  const appCount = () => {
    const q = service
      .from("job_applications")
      .select("id", { count: "exact", head: true })
      .eq("company_id_snapshot", ctx.companyId);
    return scope.scoped ? q.in("job_id", scope.jobIds) : q;
  };

  /*
   * The screening count: `<> '[]'` is the predicate, verified equal to the old
   * `Array.isArray(x) && x.length > 0` across every production row and
   * cross-checked against `screening_answers->0 IS NOT NULL`. The column is
   * `jsonb NOT NULL DEFAULT '[]'::jsonb` and /api/apply is its only writer, so
   * there is no null and no non-array case for the two to disagree on.
   */
  const counts = Promise.all([
    headCount("applications", appCount()),
    headCount("new this week", appCount().gte("created_at", weekAgoIso)),
    headCount("screened", appCount().neq("screening_answers", "[]")),
    Promise.all(
      NOT_APPLIED.map((stage) =>
        headCount(`stage ${stage}`, appCount().eq("pipeline_stage", stage)),
      ),
    ),
  ]);

  const jobsRead = pageAll<JobRow>(
    (from, to) => {
      const q = service
        .from("jobs")
        .select("id, title, category, status, created_at")
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null);
      return (scope.scoped ? q.in("id", scope.jobIds) : q)
        .order("created_at", { ascending: false })
        // id is a unique final term, so jobs sharing a created_at cannot
        // straddle a page boundary and come back twice or not at all (#54).
        .order("id", { ascending: false })
        .range(from, to);
    },
    { scope: "overview", label: "jobs" },
  );

  /*
   * The role cards' figures: applications per job, counted by the database.
   * `!inner(count)` returns each job that has at least one matching
   * application, with the count; a job it leaves out has none, so it counts 0.
   * The embedded filter is the tenant boundary: without it a job would count
   * another company's applications that point at it, and !inner is what makes
   * that filter restrict the rows (tenant-isolation.test.ts reads it so).
   * Verified on staging (17 Nov 2026) against the in-memory tally this
   * replaces, at 10,003 applications, for the owner and a scoped recruiter,
   * all time and since a cut: identical. A pointed-elsewhere company filter
   * counts 0.
   */
  const perJobCount = (label: string, since: string | null) =>
    pageAll<JobCountRow>(
      (from, to) => {
        let q = service
          .from("jobs")
          .select("id, job_applications!inner(count)")
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .eq("job_applications.company_id_snapshot", ctx.companyId);
        if (since) q = q.gte("job_applications.created_at", since);
        return (scope.scoped ? q.in("id", scope.jobIds) : q)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
      },
      { scope: "overview", label },
    ).then((rows) => {
      const byJob = new Map<string, number>();
      for (const r of rows) {
        const n = r.job_applications?.[0]?.count;
        // A job the read returned without a count is a malformed answer, not a zero.
        if (typeof n !== "number") throw new Error(`[overview] ${label}: no count on a job`);
        byJob.set(r.id, n);
      }
      return byJob;
    });

  /** The six newest: five recent-applicant rows and six activity entries. */
  const newestRead = (() => {
    const q = service
      .from("job_applications")
      .select(
        "id, first_name, last_name, email, job_id, job_title_snapshot, pipeline_stage, created_at",
      )
      .eq("company_id_snapshot", ctx.companyId);
    return (scope.scoped ? q.in("job_id", scope.jobIds) : q)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(6)
      .then(({ data, error }) => {
        if (error) throw new Error(`[overview] newest applications failed: ${error.message}`);
        return (data ?? []) as AppRow[];
      });
  })();

  /*
   * The stage-history feed, narrowed IN THE DATABASE. It used to take the
   * company's latest 12 moves and drop the ones outside a recruiter's jobs in
   * memory, so a recruiter whose jobs were not among the company's 12 latest
   * saw no moves at all while older ones existed. For a scoped role the
   * history row must now have a live application in this company on one of
   * their jobs (!inner, so the embedded filters restrict the history rows),
   * and the 12 are the latest of THOSE.
   */
  const historyRead = (() => {
    const base = "id, application_id, from_stage, to_stage, changed_by_name, created_at";
    const q = scope.scoped
      ? service
          .from("application_stage_history")
          .select(`${base}, job_applications!inner(job_id)`)
          .eq("company_id", ctx.companyId)
          .eq("job_applications.company_id_snapshot", ctx.companyId)
          .in("job_applications.job_id", scope.jobIds)
      : service.from("application_stage_history").select(base).eq("company_id", ctx.companyId);
    return q
      .order("created_at", { ascending: false })
      .limit(12)
      .then(({ data, error }): Read<HistoryRow[]> => {
        // "Nothing has happened in Acme yet" is a claim about their workspace.
        // An empty array on a failed read made the feed say it on no evidence.
        if (error) {
          console.error("[overview] history failed:", error);
          return unavailable();
        }
        return answered((data ?? []) as HistoryRow[]);
      });
  })();

  /*
   * #67: pending invites live in company_invites, the same rule the Team
   * page lists (team/actions.ts fetchTeamMembers): this company, status
   * 'pending', not yet expired. A timed-out invite stays 'pending', so the
   * expires_at filter is what keeps it out. Do not point this back at
   * company_members - nothing writes 'invited' there.
   */
  const invitesRead = service
    .from("company_invites")
    .select("id", { count: "exact", head: true })
    .eq("company_id", ctx.companyId)
    .eq("status", "pending")
    .gt("expires_at", new Date(now).toISOString())
    .then(({ count, error }): Read<number> => {
      // Unknown, not zero. `pendingInvites > 0` gates the card, so a failed
      // read used to be indistinguishable from "nothing pending" - and an
      // invite that expires unnoticed costs someone a teammate.
      if (error) {
        console.error("[overview] invites failed:", error);
        return unavailable();
      }
      return answered(count ?? 0);
    });

  const [
    [total, newThisWeek, screenedCount, notApplied],
    jobs,
    perJob,
    perJobThisWeek,
    newest,
    history,
    invites,
  ] = await Promise.all([
    counts,
    jobsRead,
    perJobCount("applications per job", null),
    perJobCount("applications per job this week", weekAgoIso),
    newestRead,
    historyRead,
    invitesRead,
  ]);

  /*
   * The names on the feed's stage moves: only the applications those (at most
   * 12) moves name, read in the same scope the page uses, so a move on an
   * application outside it still reads "An applicant".
   */
  const historyRows = history.ok ? history.value : [];
  const namedIds = [
    ...new Set(historyRows.map((h) => h.application_id).filter((id): id is string => !!id)),
  ];
  const named = new Map<string, AppRow>();
  if (namedIds.length > 0) {
    const q = service
      .from("job_applications")
      .select(
        "id, first_name, last_name, email, job_id, job_title_snapshot, pipeline_stage, created_at",
      )
      .eq("company_id_snapshot", ctx.companyId)
      .in("id", namedIds);
    const { data, error } = await (scope.scoped ? q.in("job_id", scope.jobIds) : q);
    if (error) throw new Error(`[overview] feed names failed: ${error.message}`);
    for (const a of (data ?? []) as AppRow[]) named.set(a.id, a);
  }

  if (jobs.length === 0 && total === 0) {
    return { ...EMPTY, pendingInvites: invites };
  }

  // ── Applications ───────────────────────────────────────────
  const stageOf = (r: AppRow): PipelineStage =>
    (PIPELINE_STAGES as readonly string[]).includes(r.pipeline_stage ?? "")
      ? (r.pipeline_stage as PipelineStage)
      : "applied";

  /*
   * Applied is the rest: every application not counted in one of the other
   * six stages, which is what the in-memory stageOf did (an unknown stage read
   * as applied). Floored at zero: the counts are read in parallel, so a row
   * moving stage between two of them could otherwise make it negative.
   */
  const stageCount = new Map<PipelineStage, number>(
    NOT_APPLIED.map((stage, i) => [stage, notApplied[i]]),
  );
  const awaitingReview = Math.max(0, total - notApplied.reduce((sum, n) => sum + n, 0));
  stageCount.set("applied", awaitingReview);

  const funnel: FunnelStep[] = FUNNEL_STAGES.map((stage) => {
    const count = stageCount.get(stage) ?? 0;
    return {
      stage,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    };
  });

  // ── Jobs ───────────────────────────────────────────────────
  const published = jobs.filter((j) => j.status === "open");
  const drafts = jobs.filter((j) => j.status === "on_hold");

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
      applicants: perJob.get(j.id) ?? 0,
      newThisWeek: perJobThisWeek.get(j.id) ?? 0,
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

  // Newest first: the query is ordered created_at desc, id desc.
  const recentApplicants: RecentApplicant[] = newest
    .slice(0, RECENT_APPLICANT_LIMIT)
    .map((a) => ({
    id: a.id,
    name: fullName(a),
    jobTitle:
      jobs.find((j) => j.id === a.job_id)?.title?.trim() ||
      a.job_title_snapshot?.trim() ||
      "-",
    stage: stageOf(a),
    createdAt: a.created_at ?? "",
  }));

  // ── Activity feed ──────────────────────────────────────────
  // Three real sources merged and re-sorted: stage moves, new applications,
  // and job publications. No synthetic "AI screened N" entries.
  const stageItems: ActivityItem[] = historyRows
    .filter((h) => h.to_stage && h.created_at)
    .map((h) => {
      const app = h.application_id ? named.get(h.application_id) : undefined;
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

  const applyItems: ActivityItem[] = newest.slice(0, 6).map((a) => ({
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
    activity: history.ok ? answered(activity) : unavailable(),
  };
}
