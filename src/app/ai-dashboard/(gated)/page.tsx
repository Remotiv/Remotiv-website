import { redirect } from "next/navigation";
import { Briefcase, Users, Video } from "lucide-react";
import { PageContainer } from "../_components/page-container";
import { getCompanyContext } from "../lib/company-guards";
import {
  COMPANY_ROLE_LABELS,
  type CompanyContext,
} from "../lib/company-roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview — Remotiv AI Interviews" };

const STATS = [
  { label: "Open jobs",     icon: Briefcase, tintBg: "var(--ai-purple-tint)", tintFg: "var(--ai-purple-ink)" },
  { label: "Applicants",    icon: Users,     tintBg: "var(--ai-peach-tint)",  tintFg: "var(--ai-peach-ink)" },
  { label: "Interviews run", icon: Video,    tintBg: "var(--ai-sky-tint)",    tintFg: "var(--ai-sky-ink)" },
] as const;

// Step 1c placeholder. Real counts arrive with Jobs (Step 2) and Interviews
// (Step 7); rendering them as 0 through the same card keeps the swap a
// one-line change per stat.
export default async function CompanyOverviewPage() {
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
    <PageContainer>
      <div className="mb-[22px]">
        <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
          {ctx.company.name}
        </h1>
        <p className="mt-2 max-w-[440px] text-sm text-[var(--ai-t2)]">
          Signed in as {ctx.user.email} · {COMPANY_ROLE_LABELS[ctx.role]}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[1049px]:grid-cols-3">
        {STATS.map(({ label, icon: Icon, tintBg, tintFg }) => (
          <div
            key={label}
            className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-4"
          >
            <div className="flex items-center gap-[7px] text-xs font-medium text-[var(--ai-t3)]">
              <span
                className="flex size-[26px] items-center justify-center rounded-lg"
                style={{ background: tintBg, color: tintFg }}
              >
                <Icon className="size-[15px]" strokeWidth={1.9} />
              </span>
              {label}
            </div>
            <div className="mt-3 font-heading text-[28px] font-extrabold leading-none tracking-[-0.02em]">
              0
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-[18px] border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-6 py-16 text-center">
        <p className="font-heading text-sm font-semibold text-[var(--ai-t2)]">
          Dashboard coming soon
        </p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-[var(--ai-t3)]">
          Jobs, applicants, and AI interviews land in upcoming releases. Manage
          your workspace members from the Team page in the meantime.
        </p>
      </div>
    </PageContainer>
  );
}
