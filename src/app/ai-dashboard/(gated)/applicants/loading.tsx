import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import { isApplicantsSplitOn } from "@/app/ai-dashboard/lib/applicants-split-flag";
import { HeroSkeleton, SplitSkeleton } from "./_split-skeleton";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

/**
 * The Applicants loading state: the Split shape by default (_split-skeleton.tsx,
 * C3), the old page's skeleton with the kill switch on. The switch is read here,
 * on the server, by the same rule page.tsx applies (applicants-split-flag.ts).
 */
export default function Loading() {
  return isApplicantsSplitOn(null) ? <SplitSkeleton /> : <TableSkeleton />;
}

/** The old page's skeleton (APPLICANTS_SPLIT_DISABLED=1), unchanged. */
function TableSkeleton() {
  return (
    <PageContainer>
      <div className="mb-[22px]">
        <div className={`${SHIMMER} h-8 w-44`} />
        <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
      </div>

      <HeroSkeleton />

      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
        <div className="border-b border-[var(--ai-line)] p-[18px]">
          <div className={`${SHIMMER} h-9 w-[340px] max-w-full`} />
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3.5 border-b border-[var(--ai-line-soft)] px-5 py-[13px] last:border-b-0"
          >
            <div className={`${SHIMMER} size-10 shrink-0 rounded-full`} />
            <div className="min-w-0 flex-1">
              <div className={`${SHIMMER} h-4 w-44`} />
              <div className={`${SHIMMER} mt-2 h-3 w-56`} />
            </div>
            <div className={`${SHIMMER} size-[38px] shrink-0 rounded-full`} />
            <div className={`${SHIMMER} h-7 w-24 shrink-0`} />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
