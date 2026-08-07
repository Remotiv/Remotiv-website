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
      <div className="mb-[26px] grid grid-cols-1 overflow-hidden rounded-[22px] bg-[var(--ai-sidebar)] min-[1180px]:grid-cols-[340px_minmax(0,1fr)_auto]">
        <div className="flex flex-col justify-center bg-remotiv-green px-[26px] py-[22px] min-[1180px]:px-7 min-[1180px]:py-[26px]">
          <div className="h-3 w-[90px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-[46px] w-[150px] animate-pulse rounded-lg bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-[5px] w-[168px] animate-pulse rounded-[3px] bg-[rgba(4,52,44,0.16)]" />
          <div className="mt-3 h-3 w-[150px] animate-pulse rounded bg-[rgba(4,52,44,0.16)]" />
        </div>
        <div className="min-w-0 px-[26px] py-[22px] min-[1180px]:px-[30px] min-[1180px]:py-[26px]">
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
        <div className="px-[26px] pb-[22px] min-[1180px]:py-[26px] min-[1180px]:pl-2.5 min-[1180px]:pr-[30px] min-[1180px]:text-right">
          <div className="mb-[11px] h-3 w-[100px] animate-pulse rounded bg-white/10 min-[1180px]:ml-auto" />
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
