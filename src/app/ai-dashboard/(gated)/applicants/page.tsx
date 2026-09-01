import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { getJobScope, isEmptyScope } from "@/app/ai-dashboard/lib/job-scope";
import { fetchManualTemplates } from "@/app/ai-dashboard/(gated)/messages/actions";
import { fetchCompanyApplicants } from "./actions";
import { ApplicantsClient } from "./_applicants-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Applicants — Remotiv AI Interviews" };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default async function ApplicantsPage() {
  const [ctx, applicants, manualTemplates] = await Promise.all([
    getCompanyContext(),
    fetchCompanyApplicants(),
    fetchManualTemplates(),
  ]);

  // Distinguishes "this company has no applicants" from "you are on no jobs",
  // which look identical on screen and need opposite copy.
  const unassigned = isEmptyScope(await getJobScope(ctx));

  // The address the drawer's composer quotes back to the sender.
  const { data: replyRow } = await createServiceClient()
    .from("companies")
    .select("candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const replyToAddress =
    ((replyRow as { candidate_reply_email: string | null } | null)
      ?.candidate_reply_email ?? "").trim() || null;

  // Computed, never hardcoded — same rule the handoff sets for Overview.
  //
  // `now` is also handed to the client so its date formatters can render "2d
  // ago" identically on this pass and on the hydrating one. Reading the clock
  // independently in both places is what made every applicant row a hydration
  // mismatch.
  // Unwrapped once, here. The derived figures below are all claims about the
  // pipeline, so on a failed read they are computed over [] and the client is
  // told not to present them as facts.
  const applicantRows = applicants.ok ? applicants.value : [];
  const now = Date.now();
  const since = now - WEEK_MS;
  const newThisWeek = applicantRows.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return !Number.isNaN(t) && t >= since;
  }).length;

  // Distinct live jobs represented in the result set. Derived from the rows we
  // already have rather than a second query; applications whose job was
  // deleted carry a null job_id and simply don't count toward "open roles".
  const openRoles = new Set(
    applicantRows.map((r) => r.job_id).filter((id): id is string => Boolean(id)),
  ).size;

  return (
    <ApplicantsClient
      viewerRole={ctx.role}
      applicants={applicantRows}
      loadFailed={!applicants.ok}
      newThisWeek={newThisWeek}
      openRoles={openRoles}
      companyName={ctx.company.name}
      replyToAddress={replyToAddress}
      manualTemplates={manualTemplates}
      unassigned={unassigned}
      renderedAt={now}
    />
  );
}
