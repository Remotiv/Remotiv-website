import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { AiShell } from "../_components/ai-shell";
import { getCompanyContext } from "../lib/company-guards";
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
  } catch {
    redirect("/ai-dashboard/login?reason=unauthorized");
  }

  if (ctx.mustChangePassword) {
    redirect("/ai-dashboard/change-password?forced=true");
  }

  // Sidebar badges only — HEAD counts, so no rows cross the wire. Applicants
  // are scoped on company_id_snapshot, matching fetchCompanyApplicants: it
  // survives job deletion, unlike a join through jobs.company_id.
  const service = createServiceClient();
  const [{ count: jobCount }, { count: applicantCount }] = await Promise.all([
    service
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId),
    service
      .from("job_applications")
      .select("id", { count: "exact", head: true })
      .eq("company_id_snapshot", ctx.companyId),
  ]);

  return (
    <AiShell
      companyName={ctx.company.name}
      role={ctx.role}
      userName={ctx.memberName}
      userEmail={ctx.user.email}
      jobCount={jobCount ?? 0}
      applicantCount={applicantCount ?? 0}
    >
      {children}
    </AiShell>
  );
}
