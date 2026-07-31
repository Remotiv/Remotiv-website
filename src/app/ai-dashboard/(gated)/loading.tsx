import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";
/** The hero is #141020, so its shimmer is translucent white — the cream
 *  --ai-line-soft would be invisible on it. */
const DARK_SHIMMER = "animate-pulse rounded bg-white/10";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <div className={`${SHIMMER} h-8 w-[260px] max-w-full`} />
          <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
        </div>
        <div className={`${SHIMMER} h-11 w-[130px] shrink-0`} />
      </div>

      <div className="mb-3.5 grid grid-cols-1 gap-7 rounded-[24px] bg-[var(--ai-sidebar)] px-6 py-7 min-[968px]:grid-cols-[minmax(0,1fr)_1px_minmax(0,1.15fr)] min-[968px]:items-center min-[968px]:gap-[30px] min-[968px]:px-[30px]">
        <div>
          <div className={`${DARK_SHIMMER} h-[26px] w-[170px] rounded-full`} />
          <div className={`${DARK_SHIMMER} mt-3.5 h-[29px] w-full max-w-[380px]`} />
          <div className={`${DARK_SHIMMER} mt-2 h-[29px] w-full max-w-[300px]`} />
          <div className={`${DARK_SHIMMER} mt-3.5 h-3 w-full max-w-[340px]`} />
          <div className={`${DARK_SHIMMER} mt-5 h-[42px] w-[180px] rounded-[11px]`} />
        </div>
        <div className="hidden h-[150px] self-center bg-white/[0.12] min-[968px]:block" />
        <div className="min-w-0">
          <div className={`${DARK_SHIMMER} mb-3.5 h-3 w-20`} />
          <div className="flex gap-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="min-w-0 flex-1">
                <div className={`${DARK_SHIMMER} h-3 w-full`} />
                <div className={`${DARK_SHIMMER} mt-2.5 h-6 w-8`} />
                <div className={`${DARK_SHIMMER} mt-2.5 h-1`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-0.5 mb-[13px] mt-[26px]">
        <div className={`${SHIMMER} h-5 w-28`} />
      </div>
      <div className="grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[968px]:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] p-[19px]"
          >
            <div className={`${SHIMMER} size-[38px] rounded-full`} />
            <div className={`${SHIMMER} mt-3.5 h-4 w-40`} />
            <div className={`${SHIMMER} mt-2.5 h-3 w-full`} />
            <div className={`${SHIMMER} mt-3.5 h-3 w-28`} />
          </div>
        ))}
      </div>

      <div className="mx-0.5 mb-[13px] mt-[26px]">
        <div className={`${SHIMMER} h-5 w-24`} />
      </div>
      <div className="grid grid-cols-1 items-start gap-3.5 min-[968px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        {[0, 1].map((col) => (
          <div
            key={col}
            className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]"
          >
            <div className="border-b border-[var(--ai-line)] px-5 py-4">
              <div className={`${SHIMMER} h-4 w-36`} />
            </div>
            <div className="flex flex-col gap-4 px-5 py-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className={`${SHIMMER} size-9 shrink-0 rounded-full`} />
                  <div className="min-w-0 flex-1">
                    <div className={`${SHIMMER} h-3.5 w-32`} />
                    <div className={`${SHIMMER} mt-2 h-3 w-44 max-w-full`} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PageContainer>
  );
}
