import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-[22px]">
        <div className={`${SHIMMER} h-8 w-44`} />
        <div className={`${SHIMMER} mt-3 h-4 w-[420px] max-w-full`} />
      </div>

      {/* Dark hero keeps its colour while loading so the page doesn't flash
          from light to dark when content arrives. */}
      <div className="mb-[26px] rounded-[22px] bg-[var(--ai-sidebar)] px-7 py-6">
        <div className="h-3 w-28 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-11 w-32 animate-pulse rounded-lg bg-white/10" />
        <div className="mt-3 h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>

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
