const SHIMMER = "animate-pulse rounded-lg bg-[var(--ai-line-soft)]";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1560px] px-4 pb-16 pt-[30px] lg:px-8">
      <div className="mb-[22px] flex items-start justify-between gap-6">
        <div>
          <div className={`${SHIMMER} h-8 w-32`} />
          <div className={`${SHIMMER} mt-3 h-4 w-[380px] max-w-full`} />
        </div>
        <div className={`${SHIMMER} h-11 w-[150px] shrink-0`} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] p-[18px]"
          >
            <div className={`${SHIMMER} h-[26px] w-32`} />
            <div className={`${SHIMMER} mt-3 h-7 w-14`} />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)]">
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
    </div>
  );
}
