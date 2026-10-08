import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { loadInterviewSession } from "@/lib/interviews/review";
import { ReviewClient } from "./_review-client";

export const metadata: Metadata = { title: "Interview review · Remotiv" };

/**
 * One candidate's interview.
 *
 * `loadInterviewSession` returns null for anything outside the viewer's
 * company OR their hiring-team scope, and both land on the same 404 — a
 * distinct "not authorised" would confirm the session id exists.
 */
export default async function InterviewReviewPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const ctx = await getCompanyContext();
  const session = await loadInterviewSession(ctx, sessionId);
  if (!session) notFound();

  // The account role, so the stage control follows the same rule as the drawer.
  return <ReviewClient session={session} viewerRole={ctx.role} />;
}
