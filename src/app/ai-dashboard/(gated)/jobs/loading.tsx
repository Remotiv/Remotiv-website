import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-[22px] flex items-start justify-between gap-6">
        <div>
          <div className={`${SHIMMER} h-8 w-28`} />
          <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
        </div>
        <div className={`${SHIMMER} h-11 w-[130px] shrink-0`} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[1049px]:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] p-[18px]"
          >
            <div className={`${SHIMMER} h-[26px] w-28`} />
            <div className={`${SHIMMER} mt-3 h-7 w-12`} />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
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
