import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { peekSession, RECOVER_ATTEMPTED_COOKIE } from "@/lib/supabase/session-cookie";
import { AiShell } from "../_components/ai-shell";
import {
  CompanyAccessDenied,
  getCompanyContext,
  loginRedirectFor,
} from "../lib/company-guards";
import { orElse } from "@/lib/supabase/read";
import { getJobScope, scopedApplicationIds } from "../lib/job-scope";
import { COMPANY_LOGO_BUCKET } from "./settings/constants";
import { SessionRefresh } from "./_session-refresh";
import type { CompanyContext } from "../lib/company-roles";

/**
 * A badge number the sidebar can stand behind, or nothing at all.
 *
 * `count ?? 0` turned a query that FAILED into a confident zero. A recruiter
 * reads "0" beside Applicants, believes it, and stops looking — while the page
 * itself would have listed eighty-seven. A wrong answer presented as a right
 * one is worse than no answer, and the sidebar already knows how to show no
 * answer: an undefined count renders no badge.
 *
 * A real zero survives. The noJobs short-circuit passes `error: null`, and a
 * genuinely empty workspace still counts nothing and still shows 0 — which is
 * the entire point, since those two cases used to be indistinguishable.
 */
function badgeCount(result: { count: number | null; error: unknown }): number | undefined {
  return result.error ? undefined : (result.count ?? 0);
}

export default async function GatedCompanyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /*
   * Resolve company + role. Eligibility comes from resolveCompanyAccess, the
   * same rule the login page admits on; the shell reads company/role/user
   * straight off this ctx.
   *
   * There is no separate getUser() above this. getCompanyContext resolves the
   * session itself and throws CompanyAccessDenied("unauthenticated") when there
   * isn't one, which the catch below routes to exactly the same bare
   * /ai-dashboard/login the explicit guard used to. It earned its place before
   * the catch could tell "signed out" from "wrong account"; now it is four
   * sequential round-trips buying nothing.
   */
  /*
   * ── Session recovery, ABOVE the gate ─────────────────────────
   *
   * peekSession reads the cookie without waking auth-js, so an expired token
   * is noticed here rather than discovered inside getUser() — where auth-js
   * would refresh it, fail to persist the result (a render cannot set
   * cookies), and leave the browser holding a refresh token that has just been
   * retired. That was the remaining hole: a cold return burned a rotation on
   * every render until SessionRefresh mounted and rotated again.
   *
   * Expired → one redirect to the recover handler, which can write cookies.
   * The latch cookie is the loop guard: if it is already present, the recover
   * handler has had its one attempt for this navigation and the answer is
   * login. Live or absent → fall through; getCompanyContext handles both as it
   * always did, and a live token gives __loadSession nothing to refresh.
   */
  const cookieStore = await cookies();
  const peek = await peekSession(cookieStore);
  if (peek.state === "expired") {
    if (cookieStore.get(RECOVER_ATTEMPTED_COOKIE)) {
      redirect("/ai-dashboard/login");
    }
    // Set by proxy.ts for every /ai-dashboard request: path + query, so the
    // user lands back on the exact page, filters included.
    const returnTo = (await headers()).get("x-url") ?? "/ai-dashboard";
    redirect(`/ai-dashboard/api/session/recover?next=${encodeURIComponent(returnTo)}`);
  }

  let ctx: CompanyContext;
  try {
    ctx = await getCompanyContext();
  } catch (err) {
    // Only a DECIDED refusal becomes a redirect, and each reason goes to a
    // login page that will agree with it. Anything else — a company profile
    // that would not load after access was already granted — is rethrown to
    // the error boundary. Redirecting on that would send the user to a login
    // page that admits them, and back here, and round again.
    if (err instanceof CompanyAccessDenied) {
      console.error("[ai-dashboard] access denied:", err.access.reason);
      redirect(loginRedirectFor(err.access));
    }
    throw err;
  }

  if (ctx.mustChangePassword) {
    redirect("/ai-dashboard/change-password?forced=true");
  }

  // Sidebar badges only — HEAD counts, so no rows cross the wire. Applicants
  // are scoped on company_id_snapshot, matching fetchCompanyApplicants: it
  // survives job deletion, unlike a join through jobs.company_id.
  const service = createServiceClient();

  // The badges must count exactly what each page will list. A scoped member
  // seeing "128" beside an Applicants page showing 4 is the same class of bug
  // as a tab count disagreeing with its rows.
  const scope = await getJobScope(ctx);
  /*
   * orElse, deliberately. A failed allow-list read degrades to "closed" here —
   * the same behaviour as before the type existed — because the consequence is
   * one badge count, and taking the whole workspace away for that would be
   * worse than the bug. The Messages page does NOT absorb it; see the note on
   * scopedApplicationIds for why those two are not in disagreement.
   */
  const allowedApps = orElse(await scopedApplicationIds(ctx, scope), []);
  const noJobs = scope.scoped && scope.jobIds.length === 0;

  const [jobs, applicants, messages, interviews] =
    noJobs
      ? [
          { count: 0, error: null },
          { count: 0, error: null },
          { count: 0, error: null },
          { count: 0, error: null },
        ]
      : await Promise.all([
          (() => {
            const q = service
              .from("jobs")
              .select("id", { count: "exact", head: true })
              .eq("company_id", ctx.companyId);
            return scope.scoped ? q.in("id", scope.jobIds) : q;
          })(),
          (() => {
            const q = service
              .from("job_applications")
              .select("id", { count: "exact", head: true })
              .eq("company_id_snapshot", ctx.companyId);
            return scope.scoped ? q.in("job_id", scope.jobIds) : q;
          })(),
          // Must match what the Messages page lists, or the badge and the page
          // disagree. Cancelled rows are tombstones for messages that never
          // sent; a null application_id is a message whose applicant has been
          // deleted, which that page hides.
          (() => {
            const q = service
              .from("communication_logs")
              .select("id", { count: "exact", head: true })
              .eq("company_id", ctx.companyId)
              .neq("status", "cancelled")
              .not("application_id", "is", null);
            return allowedApps === null ? q : q.in("application_id", allowedApps);
          })(),
          // Scoped on job_id like Jobs, not through applications: an interview
          // belongs to a job, and the list this badge labels is scoped that way.
          (() => {
            const q = service
              .from("interview_sessions")
              .select("id", { count: "exact", head: true })
              .eq("company_id", ctx.companyId);
            return scope.scoped ? q.in("job_id", scope.jobIds) : q;
          })(),
        ]);

  // Public URL — a logo appears on every public job post, so it is served
  // straight from the public bucket rather than signed per render.
  const logoUrl = ctx.company.logo_path
    ? service.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(ctx.company.logo_path)
        .data.publicUrl
    : null;

  return (
    <AiShell
      companyName={ctx.company.name}
      companyLogoUrl={logoUrl}
      role={ctx.role}
      userName={ctx.memberName}
      userEmail={ctx.user.email}
      jobCount={badgeCount(jobs)}
      applicantCount={badgeCount(applicants)}
      messageCount={badgeCount(messages)}
      interviewCount={badgeCount(interviews)}
    >
      <SessionRefresh />
      {children}
    </AiShell>
  );
}
