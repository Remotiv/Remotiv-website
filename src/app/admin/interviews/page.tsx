import Link from "next/link";
import { notFound } from "next/navigation";
import { TopNav } from "@/app/admin/_components/top-nav";
import { type AdminContext, requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { listPlatformLiveSessions } from "@/lib/interviews/live-review";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI Video Interviews · Remotiv admin" };

const CELL = "px-4 py-3 text-sm";

/**
 * Every company's AI Video Interviews, for a Remotiv super admin (F4): company,
 * job, outcome, date and the last six characters of the session id. No
 * candidate name or other candidate data. Super admin only, checked here on
 * the server; anyone else gets a 404. The nav item only advertises it.
 */
export default async function AdminInterviewsPage() {
  let admin: AdminContext;
  try {
    admin = await requireSuperAdmin();
  } catch {
    notFound();
  }
  const rows = await listPlatformLiveSessions();

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={admin.user.email} userRole={admin.role} />
      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <p className="text-xs text-gray-400">Admin · all companies</p>
        <h1 className="font-heading text-3xl font-bold tracking-tight text-gray-900">
          AI Video Interviews
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-500">
          Read-only. Opening a review, or any recording in it, is logged with your account.
        </p>
        {rows.length === 0 ? (
          <p className="mt-6 text-sm text-gray-500" data-empty>
            No AI Video Interviews yet.
          </p>
        ) : (
          <table className="mt-6 w-full border-collapse overflow-hidden rounded-xl bg-white text-left">
            <thead className="text-xs uppercase tracking-wide text-gray-400">
              <tr>
                <th className={CELL}>Company</th>
                <th className={CELL}>Job</th>
                <th className={CELL}>Outcome</th>
                <th className={CELL}>Date</th>
                <th className={CELL}>Session</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-gray-100" data-session-row>
                  <td className={CELL}>{r.companyName}</td>
                  <td className={CELL}>{r.jobTitle}</td>
                  <td className={CELL}>{r.outcome}</td>
                  <td className={CELL}>{r.createdAt.slice(0, 10)}</td>
                  <td className={CELL}>
                    <Link className="font-mono underline" href={`/admin/interviews/${r.id}`}>
                      {r.shortId}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
