import { redirect } from "next/navigation";
import { getCompanyContext } from "../lib/company-guards";
import { COMPANY_ROLE_LABELS, type CompanyContext } from "../lib/company-roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard — Remotiv AI Interviews" };

// Step 1a placeholder. Proves tenant resolution end-to-end (company + role);
// the real product UI is designed and built in later phases.
export default async function CompanyDashboardPage() {
  // The gated layout guards this route too, but Next renders layout and page
  // concurrently — so an unguarded throw here surfaces as an error page before
  // the layout's redirect lands. Redirect on failure instead of throwing.
  let ctx: CompanyContext;
  try {
    ctx = await getCompanyContext();
  } catch {
    redirect("/ai-dashboard/login?reason=unauthorized");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-remotiv-bg px-6 py-16 font-sans">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.05] bg-white p-8 text-center shadow-sm">
        <span className="font-heading text-xl font-bold text-remotiv-purple">
          Remotiv.
        </span>

        <h1 className="mt-6 font-heading text-2xl font-bold text-gray-900">
          {ctx.company.name}
        </h1>
        <p className="mt-1 text-sm text-gray-500">{ctx.user.email}</p>

        <span className="mt-4 inline-block rounded-full bg-remotiv-purple/10 px-3 py-1 text-[11px] font-semibold text-remotiv-purple">
          {COMPANY_ROLE_LABELS[ctx.role]}
        </span>

        <p className="mt-8 text-sm text-gray-400">Dashboard coming soon.</p>

        <form action="/ai-dashboard/logout" method="post" className="mt-8">
          <button
            type="submit"
            className="w-full rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50"
          >
            Sign Out
          </button>
        </form>
      </div>
    </main>
  );
}
