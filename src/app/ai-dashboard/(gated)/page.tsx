import { redirect } from "next/navigation";
import {
  CompanyAccessDenied,
  getCompanyContext,
  loginRedirectFor,
} from "../lib/company-guards";
import {
  canCreateJobs,
  canManageTeam,
  type CompanyContext,
} from "../lib/company-roles";
import { fetchOverview } from "./overview-actions";
import { OverviewClient } from "./_overview-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview — Remotiv AI Interviews" };

export default async function CompanyOverviewPage() {
  // The gated layout guards this route too, but Next renders layout and page
  // concurrently — so an unguarded throw here surfaces as an error page before
  // the layout's redirect lands. Redirect on failure instead of throwing.
  let ctx: CompanyContext;
  try {
    ctx = await getCompanyContext();
  } catch (err) {
    if (err instanceof CompanyAccessDenied) {
      console.error("[ai-dashboard] access denied:", err.access.reason);
      redirect(loginRedirectFor(err.access));
    }
    throw err;
  }

  const data = await fetchOverview();

  return (
    <OverviewClient
      memberName={ctx.memberName}
      companyName={ctx.company.name}
      canCreateJob={canCreateJobs(ctx.role)}
      canManageTeam={canManageTeam(ctx.role)}
      data={data}
    />
  );
}
