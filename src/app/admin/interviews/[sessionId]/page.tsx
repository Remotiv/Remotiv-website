import "@/app/ai-dashboard/ai-dashboard.css";
import { notFound } from "next/navigation";
import { TopNav } from "@/app/admin/_components/top-nav";
import { type AdminContext, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { LiveReviewClient } from "@/app/ai-dashboard/(gated)/interviews/[sessionId]/_live-review-client";
import { loadPlatformLiveReview } from "@/lib/interviews/live-review";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI Video Interview review · Remotiv admin" };

/**
 * One company's AI Video Interview, read-only, for a Remotiv super admin (F4).
 *
 * Super admin only, checked here on the server; anyone else gets a 404. The
 * view is logged (admin_access_logs) before any candidate data is read: if the
 * log cannot be written, the page shows the reason and nothing else. Recording
 * links go through app/admin/interviews/actions.ts, which checks and logs
 * every one again. There is no action on this page.
 */
export default async function AdminInterviewReviewPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  let admin: AdminContext;
  try {
    admin = await requireSuperAdmin();
  } catch {
    notFound();
  }
  const review = await loadPlatformLiveReview(admin.user.id, sessionId);
  if (!review.ok && review.reason === "not_found") notFound();

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={admin.user.email} userRole={admin.role} />
      {review.ok ? (
        <div className="ai-shell">
          <LiveReviewClient
            view={review.view}
            candidateName={review.candidateName}
            jobTitle={`${review.jobTitle} · ${review.companyName}`}
            canAct={false}
            mode="platform"
          />
        </div>
      ) : (
        <main className="mx-auto max-w-screen-md px-4 py-10">
          <p role="alert" className="text-sm font-semibold text-gray-900" data-not-logged>
            {review.message}
          </p>
        </main>
      )}
    </div>
  );
}
