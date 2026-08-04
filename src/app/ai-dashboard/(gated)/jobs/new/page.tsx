import { redirect } from "next/navigation";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canCreateJobs } from "@/app/ai-dashboard/lib/company-roles";
import { EMPTY_JOB_INPUT } from "@/app/ai-dashboard/lib/job-types";
import { seedRejectionDefault } from "@/lib/email/candidate/triggers";
import { WizardClient } from "./_wizard-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "New job — Remotiv AI Interviews" };

export default async function NewJobPage() {
  const ctx = await getCompanyContext();

  // Hiring managers can view jobs but never create them. The action enforces
  // this too; this just avoids rendering a form that can't be submitted.
  if (!canCreateJobs(ctx.role)) {
    redirect("/ai-dashboard/jobs");
  }

  // The company setting is a SEED for new jobs, not a live reference — the
  // value is copied into the job here and is independent of the company
  // setting from then on. That is what stops a later change to the default
  // retroactively switching rejections on for jobs already posted.
  const sendRejectionDefault = await seedRejectionDefault(ctx.companyId);

  return (
    <WizardClient
      companyName={ctx.company.name}
      initialState={{
        ...EMPTY_JOB_INPUT,
        send_rejection_email: sendRejectionDefault,
      }}
    />
  );
}
