import { PageContainer } from "@/app/ai-dashboard/_components/page-container";

const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <PageContainer>
      <div className="mb-[22px]">
        <div className={`${SHIMMER} h-9 w-72 max-w-full`} />
        <div className={`${SHIMMER} mt-3 h-4 w-56`} />
      </div>
      <div className="mb-[26px] h-[236px] animate-pulse rounded-[22px] bg-[var(--ai-sidebar)] opacity-70" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 min-[1120px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[260px] animate-pulse rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)]"
          />
        ))}
      </div>
    </PageContainer>
  );
}
