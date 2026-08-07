import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <div className={`${SHIMMER} h-8 w-28`} />
          <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
        </div>
        <div className={`${SHIMMER} h-11 w-[130px] shrink-0`} />
      </div>

      {/* Mint block + ink breakdown, matching DashboardHero so the skeleton
          does not flash a different shape when content arrives. Bars on the
          mint side are ink-tinted; on the ink side, translucent white. */}
      <div className="mb-[26px] grid grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] min-[1180px]:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col justify-center bg-remotiv-green px-[26px] py-[22px] min-[1180px]:px-7 min-[1180px]:py-[26px]">
          <div className="h-3 w-[110px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-[46px] w-[92px] animate-pulse rounded-lg bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-3 w-[130px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
        </div>
        <div className="min-w-0 px-[26px] py-[22px] min-[1180px]:px-[30px] min-[1180px]:py-[26px]">
          <div className="mb-3 h-3 w-[110px] animate-pulse rounded bg-white/10" />
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="mb-2 grid grid-cols-[minmax(0,110px)_1fr_34px] items-center gap-3 last:mb-0 min-[630px]:grid-cols-[minmax(0,150px)_1fr_34px]"
            >
              <div className="h-3 animate-pulse rounded bg-white/10" />
              <div className="h-[6px] animate-pulse rounded bg-white/10" />
              <div className="h-3 animate-pulse rounded bg-white/10" />
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
        <div className="border-b border-[var(--ai-line)] p-[18px]">
          <div className={`${SHIMMER} h-9 w-[300px]`} />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3.5 border-b border-[var(--ai-line-soft)] px-5 py-[15px] last:border-b-0"
          >
            <div className={`${SHIMMER} size-[42px] shrink-0 rounded-xl`} />
            <div className="min-w-0 flex-1">
              <div className={`${SHIMMER} h-4 w-52`} />
              <div className={`${SHIMMER} mt-2 h-3 w-40`} />
            </div>
            <div className={`${SHIMMER} h-7 w-24 shrink-0`} />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
