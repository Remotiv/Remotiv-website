import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-[22px]">
        <div className={`${SHIMMER} h-8 w-52`} />
        <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
      </div>
      {/* Split mint/ink so the skeleton matches DashboardHero's shape. */}
      <div className="mb-[26px] grid grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] min-[1180px]:grid-cols-[340px_minmax(0,1fr)]">
        <div className="h-[152px] animate-pulse bg-remotiv-green opacity-70" />
        <div className="hidden h-[152px] animate-pulse opacity-70 min-[1180px]:block" />
      </div>
      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
        <div className="border-b border-[var(--ai-line)] px-[18px] py-3.5">
          <div className={`${SHIMMER} h-9 w-[340px] max-w-full`} />
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 border-b border-[var(--ai-line-soft)] px-5 py-[13px]">
            <div className={`${SHIMMER} size-9 shrink-0 rounded-full`} />
            <div className="min-w-0 flex-1">
              <div className={`${SHIMMER} h-3.5 w-40 max-w-full`} />
              <div className={`${SHIMMER} mt-2 h-3 w-64 max-w-full`} />
            </div>
            <div className={`${SHIMMER} h-6 w-20 shrink-0 rounded-full`} />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
