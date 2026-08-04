import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
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
  const since = Date.now() - WEEK_MS;
  const newThisWeek = applicants.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return !Number.isNaN(t) && t >= since;
  }).length;

  // Distinct live jobs represented in the result set. Derived from the rows we
  // already have rather than a second query; applications whose job was
  // deleted carry a null job_id and simply don't count toward "open roles".
  const openRoles = new Set(
    applicants.map((r) => r.job_id).filter((id): id is string => Boolean(id)),
  ).size;

  return (
    <ApplicantsClient
      viewerRole={ctx.role}
      applicants={applicants}
      newThisWeek={newThisWeek}
      openRoles={openRoles}
      companyName={ctx.company.name}
      replyToAddress={replyToAddress}
      manualTemplates={manualTemplates}
    />
  );
}
