import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { getJobScope, isEmptyScope } from "@/app/ai-dashboard/lib/job-scope";
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

  // The hero's "To N applicants across N roles" must describe what the viewer
  // can see, not the whole company — a scoped member reading "128 applicants"
  // above a page listing four is the same disagreement as a wrong tab count.
  const heroScope = await getJobScope(ctx);
  const heroEmpty = isEmptyScope(heroScope);

  const [aggregates, first, recipients, templates, jobs, applicants, roles, replyRow] =
    await Promise.all([
      fetchMessageAggregates(),
      fetchMessages({ tab: "all", jobId: "", search: "", page: 0 }),
      fetchRecipients(),
      fetchManualTemplates(),
      fetchMessageJobs(),
      (() => {
        if (heroEmpty) return Promise.resolve({ count: 0 });
        const q = service
          .from("job_applications")
          .select("id", { count: "exact", head: true })
          .eq("company_id_snapshot", ctx.companyId);
        return heroScope.scoped ? q.in("job_id", heroScope.jobIds) : q;
      })(),
      (() => {
        if (heroEmpty) return Promise.resolve({ count: 0 });
        const q = service
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("company_id", ctx.companyId);
        return heroScope.scoped ? q.in("id", heroScope.jobIds) : q;
      })(),
      // The reply-to the identity block and the footer both quote. Read here
      // rather than widening the shared company guard, which runs on every
      // /ai-dashboard request and does not otherwise need this column.
      service
        .from("companies")
        .select("candidate_reply_email")
        .eq("id", ctx.companyId)
        .maybeSingle(),
    ]);

  const unassigned = heroEmpty;

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
      unassigned={unassigned}
    />
  );
}
