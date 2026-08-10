import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded bg-[var(--ai-line-soft)]";

/** Mirrors the mint/ink split of DashboardHero so the shape doesn't change
 *  when content arrives. */
export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-[22px]">
        <div className={`${SHIMMER} h-10 w-[220px]`} />
        <div className={`${SHIMMER} mt-3 h-4 w-[460px] max-w-full`} />
      </div>
      <div className="mb-[26px] grid grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] min-[1180px]:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col justify-center bg-remotiv-green px-[26px] py-[22px] min-[1180px]:px-7 min-[1180px]:py-[26px]">
          <div className="h-3 w-[110px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-[46px] w-[92px] animate-pulse rounded-lg bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-3 w-[130px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
        </div>
        <div className="px-[26px] py-[22px] min-[1180px]:px-[30px] min-[1180px]:py-[26px]">
          <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
          <div className="mt-3 h-8 w-40 animate-pulse rounded bg-white/10" />
        </div>
      </div>
      <div className="h-[320px] rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]" />
    </PageContainer>
  );
}
