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
import { isTipDismissed } from "../lib/tip-state";
import { WelcomeModal } from "../_components/welcome-modal";
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

  /*
   * Resolved with the page's own data, not after it. The modal is part of this
   * render's HTML, so it covers the dashboard in the first paint rather than
   * arriving once the client has mounted — see the note in welcome-modal.tsx.
   *
   * Every role sees it: it describes the product, not a permission. The read is
   * tolerant of a failure and answers "not dismissed", which shows the modal;
   * the client keeps its own dismissal for the session either way.
   */
  const [data, welcomeDismissed] = await Promise.all([
    fetchOverview(),
    isTipDismissed(ctx.memberId, "welcome"),
  ]);

  return (
    <>
      {!welcomeDismissed && <WelcomeModal />}
      <OverviewClient
        memberName={ctx.memberName}
        companyName={ctx.company.name}
        canCreateJob={canCreateJobs(ctx.role)}
        canManageTeam={canManageTeam(ctx.role)}
        data={data}
      />
    </>
  );
}
