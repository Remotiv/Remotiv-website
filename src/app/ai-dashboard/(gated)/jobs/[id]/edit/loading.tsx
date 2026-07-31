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
        <div className="grid grid-cols-1 items-start gap-[22px] min-[705px]:grid-cols-[220px_minmax(0,1fr)] min-[1017px]:grid-cols-[236px_minmax(0,1fr)_300px]">
          {/* The rail is a dark card, so its shimmer is translucent white —
              the cream --ai-line-soft would be invisible on #141020. */}
          <div className="rounded-[20px] bg-[var(--ai-sidebar)] px-[18px] py-5">
            <div className="h-5 w-28 animate-pulse rounded-lg bg-white/10" />
            <div className="mt-2 h-3 w-32 animate-pulse rounded bg-white/10" />
            <div className="mt-3.5 h-1 w-full animate-pulse rounded-[3px] bg-white/10" />
            <div className="mt-[18px] flex flex-col gap-0.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="h-[41px] w-full animate-pulse rounded-[11px] bg-white/[0.06]"
                />
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
            <div className="flex items-start justify-between gap-4 px-[26px] pb-1.5 pt-[22px]">
              <div className="min-w-0 flex-1">
                <div className={`${SHIMMER} h-6 w-32`} />
                <div className={`${SHIMMER} mt-2 h-3.5 w-72 max-w-full`} />
              </div>
              <div className={`${SHIMMER} h-6 w-[86px] shrink-0 rounded-full`} />
            </div>
            <div className="flex flex-col gap-4 px-[26px] pb-6 pt-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i}>
                  <div className={`${SHIMMER} h-3 w-24`} />
                  <div className={`${SHIMMER} mt-2 h-11 w-full`} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-[26px] py-4">
              <div className={`${SHIMMER} h-4 w-20`} />
              <div className={`${SHIMMER} h-10 w-32`} />
            </div>
          </div>

          {/* 1017, matching the wizard's third track — not 1049. */}
          <div className="hidden min-[1017px]:block">
            <div className={`${SHIMMER} h-3 w-28`} />
            <div className={`${SHIMMER} mt-2.5 h-[320px] w-full rounded-2xl`} />
          </div>
        </div>
      </PageContainer>
    </div>
  );
}
