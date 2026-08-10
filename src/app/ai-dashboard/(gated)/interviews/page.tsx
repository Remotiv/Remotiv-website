import type { Metadata } from "next";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { listInterviewSessions } from "@/lib/interviews/review";
import { InterviewsClient } from "./_interviews-client";

export const metadata: Metadata = { title: "Interviews · Remotiv" };

/**
 * Every interview for the company, hiring-team scoped.
 *
 * The first page is rendered server-side so the empty state — which is the
 * state every company is in on day one — arrives with the HTML rather than
 * after a spinner. Filtering and paging then go through a server action.
 */
export default async function InterviewsPage() {
  const ctx = await getCompanyContext();
  const initial = await listInterviewSessions(ctx, { status: "all", page: 1 });

  return <InterviewsClient initial={initial} />;
}
