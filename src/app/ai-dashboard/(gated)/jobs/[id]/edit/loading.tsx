import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-[var(--ai-line)] bg-[var(--ai-inset)]/85 px-4 min-[840px]:px-8">
        <div className={`${SHIMMER} h-9 w-20`} />
        <div className={`${SHIMMER} h-4 w-24`} />
        <div className="ml-auto flex gap-2.5">
          <div className={`${SHIMMER} h-9 w-28`} />
          <div className={`${SHIMMER} h-9 w-32`} />
        </div>
      </div>

      <PageContainer>
        {/* Must stay identical to the wizard's grid in ../../new/_wizard-client.tsx
            (705/1017 tiers) — a mismatch makes the layout snap width the moment
            real content replaces the skeleton. */}
        <div className="grid grid-cols-1 items-start gap-[22px] min-[705px]:grid-cols-[190px_minmax(0,1fr)] min-[1017px]:grid-cols-[200px_minmax(0,1fr)_280px]">
          <div>
            <div className={`${SHIMMER} h-6 w-28`} />
            <div className={`${SHIMMER} mt-2 h-3.5 w-36`} />
            <div className="mt-[18px] flex flex-col gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={`${SHIMMER} h-11 w-full`} />
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
            <div className="px-6 pb-1 pt-5">
              <div className={`${SHIMMER} h-6 w-32`} />
              <div className={`${SHIMMER} mt-2 h-3.5 w-72 max-w-full`} />
            </div>
            <div className="flex flex-col gap-4 px-6 pb-[22px] pt-[18px]">
              {[0, 1, 2, 3].map((i) => (
                <div key={i}>
                  <div className={`${SHIMMER} h-3 w-24`} />
                  <div className={`${SHIMMER} mt-2 h-11 w-full`} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-6 py-[15px]">
              <div className={`${SHIMMER} h-4 w-20`} />
              <div className={`${SHIMMER} h-10 w-32`} />
            </div>
          </div>

          <div className="hidden min-[1049px]:block">
            <div className={`${SHIMMER} h-3 w-28`} />
            <div className={`${SHIMMER} mt-2.5 h-[320px] w-full rounded-2xl`} />
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
