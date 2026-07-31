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

      {/* Dark hero. Its own skeleton bars are translucent white, since the
          surface underneath is #141020 rather than the page cream. */}
      <div className="mb-[26px] grid grid-cols-1 gap-6 rounded-[22px] bg-[var(--ai-sidebar)] px-6 py-6 min-[840px]:grid-cols-[auto_1px_1fr] min-[840px]:gap-7 min-[840px]:px-7">
        <div>
          <div className="h-3 w-[110px] animate-pulse rounded bg-white/10" />
          <div className="mt-3 h-[46px] w-[92px] animate-pulse rounded-lg bg-white/10" />
          <div className="mt-3 h-3 w-[130px] animate-pulse rounded bg-white/10" />
        </div>
        <div className="hidden h-[78px] self-center bg-white/[0.12] min-[840px]:block" />
        <div className="min-w-0">
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
