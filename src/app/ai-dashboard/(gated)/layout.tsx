import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { AiShell } from "../_components/ai-shell";
import { CompanyLookupError, getCompanyContext } from "../lib/company-guards";
import { getJobScope, scopedApplicationIds } from "../lib/job-scope";
import { COMPANY_LOGO_BUCKET } from "./settings/constants";
import type { CompanyContext } from "../lib/company-roles";

export default async function GatedCompanyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/ai-dashboard/login");
  }

  // Resolve company + role (company_members → companies.user_id fallback).
  // A non-company session throws — bounce it back to login rather than
  // rendering an empty workspace. This is the ONLY resolution in the tree;
  // the shell reads company/role/user straight off this ctx.
  let ctx: CompanyContext;
  try {
    ctx = await getCompanyContext();
  } catch (err) {
    // A failed LOOKUP is not a wrong kind of account. Collapsing the two here
    // undid the login gate's own distinction on the way back out: a transient
    // database error bounced a legitimate owner to login and told them this
    // login is for company accounts only.
    if (err instanceof CompanyLookupError) {
      console.error("[ai-dashboard] company lookup failed:", err);
      redirect("/ai-dashboard/login?reason=unavailable");
    }
    redirect("/ai-dashboard/login?reason=unauthorized");
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
      {children}
    </AiShell>
  );
}
