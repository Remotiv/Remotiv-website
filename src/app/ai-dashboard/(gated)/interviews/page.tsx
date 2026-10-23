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
 *
 * No try/catch, and that is deliberate rather than an omission:
 * listInterviewSessions returns a Read instead of throwing, so a failed load
 * arrives here as a VALUE and is rendered by the client as its own state. The
 * alternative — a throw escaping into src/app/error.tsx — would replace the
 * whole dashboard with the generic boundary over one list that could not be
 * read, and would lose the Retry that belongs beside the thing that failed.
 */
export default async function InterviewsPage() {
  const ctx = await getCompanyContext();
  const initial = await listInterviewSessions(ctx, { status: "all", page: 1 });

  return <InterviewsClient initial={initial} />;
}
