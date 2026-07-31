import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <div className={`${SHIMMER} h-8 w-32`} />
          <div className={`${SHIMMER} mt-3 h-4 w-[380px] max-w-full`} />
        </div>
        <div className={`${SHIMMER} h-11 w-[150px] shrink-0`} />
      </div>

      {/* Dark hero. Its shimmer is translucent white — the cream
          --ai-line-soft would be invisible on #141020. */}
      <div className="mb-[26px] grid grid-cols-1 gap-6 rounded-[22px] bg-[var(--ai-sidebar)] px-6 py-6 min-[840px]:grid-cols-[auto_1px_1fr_auto] min-[840px]:items-center min-[840px]:gap-7 min-[840px]:px-7">
        <div>
          <div className="h-3 w-[90px] animate-pulse rounded bg-white/10" />
          <div className="mt-3 h-[46px] w-[150px] animate-pulse rounded-lg bg-white/10" />
          <div className="mt-3 h-[5px] w-[168px] animate-pulse rounded-[3px] bg-white/10" />
          <div className="mt-3 h-3 w-[150px] animate-pulse rounded bg-white/10" />
        </div>
        <div className="hidden h-[82px] self-center bg-white/[0.12] min-[840px]:block" />
        <div className="min-w-0">
          <div className="mb-3 h-3 w-[120px] animate-pulse rounded bg-white/10" />
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="mb-2 grid grid-cols-[minmax(0,96px)_1fr_20px] items-center gap-3 last:mb-0 min-[630px]:grid-cols-[minmax(0,124px)_1fr_20px]"
            >
              <div className="h-3 animate-pulse rounded bg-white/10" />
              <div className="h-[6px] animate-pulse rounded bg-white/10" />
              <div className="h-3 animate-pulse rounded bg-white/10" />
            </div>
          ))}
        </div>
        <div className="min-[840px]:text-right">
          <div className="mb-[11px] h-3 w-[100px] animate-pulse rounded bg-white/10 min-[840px]:ml-auto" />
          <div className="flex min-[840px]:justify-end">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`size-[38px] animate-pulse rounded-full border-[2.5px] border-[var(--ai-sidebar)] bg-white/10 ${
                  i === 0 ? "" : "-ml-[11px]"
                }`}
              />
            ))}
          </div>
          <div className="mt-2.5 h-3 w-[140px] animate-pulse rounded bg-white/10 min-[840px]:ml-auto" />
        </div>
      </div>

      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
        <div className="border-b border-[var(--ai-line)] p-[18px]">
          <div className={`${SHIMMER} h-9 w-[260px]`} />
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-[var(--ai-line-soft)] px-5 py-[15px] last:border-b-0"
          >
            <div className={`${SHIMMER} size-10 shrink-0 rounded-full`} />
            <div className="min-w-0 flex-1">
              <div className={`${SHIMMER} h-4 w-40`} />
              <div className={`${SHIMMER} mt-2 h-3 w-52`} />
            </div>
            <div className={`${SHIMMER} h-8 w-32 shrink-0`} />
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
