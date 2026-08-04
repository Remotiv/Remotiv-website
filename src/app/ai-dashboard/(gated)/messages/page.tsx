import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import {
  fetchMessageAggregates,
  fetchMessageJobs,
  fetchMessages,
  fetchManualTemplates,
  fetchRecipients,
} from "./actions";
import { MessagesClient } from "./_messages-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Messages — Remotiv AI Interviews" };

export default async function MessagesPage() {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const [aggregates, first, recipients, templates, jobs, applicants, roles, replyRow] =
    await Promise.all([
      fetchMessageAggregates(),
      fetchMessages({ tab: "all", jobId: "", search: "", page: 0 }),
      fetchRecipients(),
      fetchManualTemplates(),
      fetchMessageJobs(),
      service
        .from("job_applications")
        .select("id", { count: "exact", head: true })
        .eq("company_id_snapshot", ctx.companyId),
      service
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("company_id", ctx.companyId),
      // The reply-to the identity block and the footer both quote. Read here
      // rather than widening the shared company guard, which runs on every
      // /ai-dashboard request and does not otherwise need this column.
      service
        .from("companies")
        .select("candidate_reply_email")
        .eq("id", ctx.companyId)
        .maybeSingle(),
    ]);

  const replyTo =
    ((replyRow.data as { candidate_reply_email: string | null } | null)
      ?.candidate_reply_email ?? "").trim() || null;

  return (
    <MessagesClient
      companyName={ctx.company.name}
      replyToAddress={replyTo}
      initialRows={first.rows}
      initialMatching={first.matching}
      initialAggregates={aggregates}
      recipients={recipients}
      templates={templates}
      jobs={jobs}
      applicantCount={applicants.count ?? 0}
      roleCount={roles.count ?? 0}
    />
  );
}
