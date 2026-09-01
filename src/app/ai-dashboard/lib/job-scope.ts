import { createServiceClient } from "@/lib/supabase/server";
import {
  type CompanyContext,
  isJobScopedRole,
  type JobTeamRole,
} from "./company-roles";

/**
 * Per-job visibility, resolved once and applied to every company-scoped read.
 *
 * ── The two layers ───────────────────────────────────────────
 *
 * ACCOUNT level (company_members.role) decides whether someone is site-wide.
 * Owner and admin are; recruiter and hiring manager are not.
 *
 * PER-JOB level (job_hiring_team) decides which jobs a non-site-wide member
 * can reach. Membership of the team is what grants access — `team_role` on
 * that row is a LABEL describing the person's relationship to the job, for
 * display and later for notifications. Nothing branches on it. Keeping that
 * line sharp is what stops "coordinator" quietly becoming a permission tier
 * nobody designed.
 *
 * ── Why an id list rather than a join ────────────────────────
 *
 * Every scoped read narrows on a set of job ids. Resolving them once per
 * request and passing `.in("job_id", …)` keeps the filter identical across the
 * list, its counts, its stat cards and its filter dropdowns — a `jobs!inner`
 * embed would have to be repeated per query and its default LEFT join makes
 * `.eq("jobs.company_id", …)` an unreliable boundary, the same reason
 * fetchCompanyApplicants scopes on company_id_snapshot instead.
 *
 * The company filter is NEVER replaced by this. Job scoping narrows within a
 * tenant; it is not the tenant boundary and must not be mistaken for one.
 */

export type JobScope =
  /** Owner/admin. Sees everything in the company. */
  | { scoped: false }
  /** Recruiter/hiring manager. Sees only these job ids — possibly none. */
  | { scoped: true; jobIds: string[] };

/** True when the scope resolves to nothing at all — the empty-state case. */
export function isEmptyScope(scope: JobScope): boolean {
  return scope.scoped && scope.jobIds.length === 0;
}

/**
 * The jobs this viewer may see.
 *
 * A scoped member with no assignments returns an EMPTY list, not an absent
 * filter. Callers must short-circuit on it rather than issuing `.in("id", [])`
 * — see `scopeJobIds`. Falling open here would hand an unassigned recruiter
 * the whole company, which is the exact failure this module exists to prevent.
 */
export async function getJobScope(ctx: CompanyContext): Promise<JobScope> {
  if (!isJobScopedRole(ctx.role)) return { scoped: false };

  // A scoped role with no member row cannot be on any team. Treated as no
  // access rather than full access — the safe direction.
  if (!ctx.memberId) return { scoped: true, jobIds: [] };

  const service = createServiceClient();
  const { data, error } = await service
    .from("job_hiring_team")
    .select("job_id")
    .eq("company_id", ctx.companyId)
    .eq("member_id", ctx.memberId)
    .limit(2000);

  if (error) {
    // A failed read must not widen visibility. An empty scope shows the
    // "not assigned yet" state, which is wrong but harmless; falling open
    // would leak another team's candidates.
    console.error("[job-scope] hiring team read failed:", error);
    return { scoped: true, jobIds: [] };
  }

  const jobIds = [
    ...new Set(
      ((data ?? []) as { job_id: string | null }[])
        .map((r) => r.job_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  return { scoped: true, jobIds };
}

/**
 * Narrow a caller's own id list by the scope.
 *
 * Returns null when the scope permits everything, so a caller can distinguish
 * "no filter" from "filter to nothing" — conflating those is how an empty
 * scope turns into an unfiltered query.
 */
export function scopeJobIds(scope: JobScope): string[] | null {
  return scope.scoped ? scope.jobIds : null;
}

/**
 * May this viewer act on this specific job?
 *
 * Re-fetches the assignment server-side; a job id from the client is never
 * evidence of anything. Owner and admin pass on role alone.
 */
export async function canAccessJob(
  ctx: CompanyContext,
  jobId: string,
): Promise<boolean> {
  if (!isJobScopedRole(ctx.role)) return true;
  if (!ctx.memberId || !jobId) return false;

  const service = createServiceClient();
  const { data } = await service
    .from("job_hiring_team")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("job_id", jobId)
    .eq("member_id", ctx.memberId)
    .maybeSingle();

  return Boolean(data);
}

/**
 * The application ids a viewer may see, or null when unrestricted.
 *
 * communication_logs has no job_id, so message scoping has to travel through
 * the applications belonging to scoped jobs. Range-paged: a company with more
 * than 1000 applications on its scoped jobs would otherwise silently lose the
 * tail, and a truncated allow-list hides messages rather than leaking them —
 * quiet either way, so it is paged rather than trusted to fit.
 *
 * An empty array is returned on a read failure, not a partial one. It is the
 * same direction the rest of this module fails in, made deterministic and
 * logged. Callers cannot distinguish it from "this member has no applications
 * to message about" — see the note on the console.error below, and the copy
 * that empty state renders.
 */
export async function scopedApplicationIds(
  ctx: CompanyContext,
  scope: JobScope,
): Promise<string[] | null> {
  if (!scope.scoped) return null;
  if (scope.jobIds.length === 0) return [];

  const service = createServiceClient();
  const out: string[] = [];
  const PAGE = 1000;

  // Chunked on the job ids too — a long `.in()` overflows the request URL.
  for (let i = 0; i < scope.jobIds.length; i += 100) {
    const chunk = scope.jobIds.slice(i, i + 100);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await service
        .from("job_applications")
        .select("id")
        .eq("company_id_snapshot", ctx.companyId)
        .in("job_id", chunk)
        .range(from, from + PAGE - 1);

      /*
       * Abandon the WHOLE allow-list, and say which read failed.
       *
       * This used to `break`, which left the inner page loop only — a failure
       * on chunk 2 of 5 carried on to chunk 3 and returned an allow-list
       * missing an arbitrary middle. That is not a smaller answer, it is a
       * different one, and it differed run to run.
       *
       * Unlike the paged reads on Overview and Analytics, this one is NOT
       * converted to a throw. Those produce wrong numbers presented as right,
       * with no safe reading. This produces a NARROWER authorization set, which
       * the module already fails toward on purpose (see getJobScope) — and it
       * runs in the gated layout, so throwing would take the entire dashboard
       * away from a scoped recruiter because a message query timed out. That is
       * worse than the bug. What was wrong here was silence and inconsistency,
       * not the direction of the failure.
       */
      if (error) {
        console.error(
          `[job-scope] application allow-list failed: jobs ${i}-${i + chunk.length - 1} of ${scope.jobIds.length}, rows ${from}-${from + PAGE - 1}. Returning an empty allow-list — message scoping is closed, not partial.`,
          error,
        );
        return [];
      }

      const batch = (data ?? []) as { id: string }[];
      out.push(...batch.map((r) => r.id));
      if (batch.length < PAGE) break;
    }
  }
  return out;
}

/** One row of a job's hiring team, as the UI renders it. */
export type HiringTeamMember = {
  id: string;
  memberId: string;
  name: string;
  email: string;
  teamRole: JobTeamRole;
  /** company_members.role — why they can see the job, site-wide or assigned. */
  accountRole: string;
};
