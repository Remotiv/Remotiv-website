import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { AiShell } from "../_components/ai-shell";
import {
  CompanyAccessDenied,
  getCompanyContext,
  loginRedirectFor,
} from "../lib/company-guards";
import { getJobScope, scopedApplicationIds } from "../lib/job-scope";
import { COMPANY_LOGO_BUCKET } from "./settings/constants";
import { SessionRefresh } from "./_session-refresh";
import type { CompanyContext } from "../lib/company-roles";

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
  const allowedApps = await scopedApplicationIds(ctx, scope);
  const noJobs = scope.scoped && scope.jobIds.length === 0;

  const [
    { count: jobCount },
    { count: applicantCount },
    { count: messageCount },
    { count: interviewCount },
  ] =
    noJobs
      ? [{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }]
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
      jobCount={jobCount ?? 0}
      applicantCount={applicantCount ?? 0}
      messageCount={messageCount ?? 0}
      interviewCount={interviewCount ?? 0}
    >
      <SessionRefresh />
      {children}
    </AiShell>
  );
}
