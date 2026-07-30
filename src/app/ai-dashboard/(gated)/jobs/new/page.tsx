import { redirect } from "next/navigation";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canCreateJobs } from "@/app/ai-dashboard/lib/company-roles";
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

  return <WizardClient companyName={ctx.company.name} />;
}
