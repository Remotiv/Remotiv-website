// Route-level loading state shown during navigation to /hire-remote while the
// page chunk loads + the initial Supabase query resolves. Block-shaped
// placeholders roughly match the real layout (hero band + stats strip + filter
// bar + 6-card candidate grid) so the perceived transition feels continuous.

export default function HireRemoteLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading talent marketplace"
      className="min-h-screen bg-remotiv-bg motion-safe:animate-pulse"
    >
      {/* Hero band */}
      <section className="px-6 pb-20 pt-20 text-center md:px-14 md:pb-[72px] md:pt-[84px]">
        <div className="mx-auto mb-5 h-7 w-[160px] rounded-full bg-black/[0.06]" />
        <div className="mx-auto mb-3 h-12 w-[70%] max-w-[640px] rounded-md bg-black/[0.08]" />
        <div className="mx-auto mb-5 h-6 w-[55%] max-w-[480px] rounded bg-black/[0.06]" />
        <div className="mx-auto mb-3 h-3 w-[60%] max-w-[520px] rounded bg-black/[0.06]" />
        <div className="mx-auto mb-10 h-3 w-[45%] max-w-[420px] rounded bg-black/[0.06]" />

        {/* Stats strip placeholder */}
        <div className="mx-auto flex max-w-[720px] flex-wrap items-center justify-center gap-0 rounded-full border border-black/[0.08] bg-white/70 px-1 py-2.5">
          <div className="h-5 w-[120px] border-r border-black/[0.08] px-5" />
          <div className="h-5 w-[120px] border-r border-black/[0.08] px-5" />
          <div className="h-5 w-[180px] border-r border-black/[0.08] px-5" />
          <div className="h-5 w-[140px] px-5" />
        </div>
      </section>

      {/* Filter bar + cards grid */}
      <section className="bg-[#f8f4f1] px-4 py-12 md:px-10">
        <div className="mx-auto max-w-7xl">
          {/* Filter bar */}
          <div className="rounded-2xl bg-white p-3 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center lg:gap-2">
              <div className="h-11 w-full rounded-xl border border-black/[0.08] bg-white lg:w-36" />
              <div className="h-11 w-full rounded-xl border border-black/[0.08] bg-white lg:w-32" />
              <div className="hidden h-11 rounded-xl border border-black/[0.08] bg-white lg:block lg:w-64" />
              <div className="h-11 w-full rounded-xl border border-black/[0.08] bg-white lg:w-32" />
              <div className="h-11 w-full rounded-xl border border-black/[0.08] bg-white lg:w-36" />
              <div className="h-11 w-full rounded-xl border border-black/[0.08] bg-white lg:w-32" />
              <div className="hidden h-11 flex-1 rounded-xl bg-[#f8f8f8] lg:block" />
              <div className="h-11 w-full rounded-xl bg-remotiv-green/40 lg:w-28" />
            </div>
          </div>

          {/* Results header */}
          <div className="mt-6 flex items-baseline justify-between">
            <div className="h-5 w-48 rounded bg-black/[0.06]" />
            <div className="h-4 w-32 rounded bg-black/[0.06]" />
          </div>

          {/* 6 candidate-card placeholders */}
          <div className="mt-4 grid grid-cols-1 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <article
                key={i}
                aria-hidden="true"
                className="flex flex-col gap-3 rounded-2xl border border-black/[0.06] bg-white px-6 py-6"
              >
                <div className="flex items-start gap-4">
                  <div className="size-14 shrink-0 rounded-full bg-black/[0.06]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="h-5 w-36 rounded bg-black/[0.08]" />
                        <div className="h-3 w-24 rounded bg-black/[0.06]" />
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <div className="h-5 w-20 rounded bg-black/[0.08]" />
                        <div className="h-3 w-24 rounded-full bg-remotiv-green/30" />
                      </div>
                    </div>
                    <div className="mt-2 h-3 w-1/2 rounded bg-black/[0.06]" />
                    <div className="mt-2 h-3 w-full rounded bg-black/[0.06]" />
                    <div className="mt-1.5 h-3 w-4/5 rounded bg-black/[0.06]" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <div className="h-5 w-16 rounded-md bg-black/[0.05]" />
                  <div className="h-5 w-20 rounded-md bg-black/[0.05]" />
                  <div className="h-5 w-14 rounded-md bg-black/[0.05]" />
                  <div className="h-5 w-24 rounded-md bg-black/[0.05]" />
                </div>
                <div className="mt-1 flex items-center justify-end">
                  <div className="h-7 w-28 rounded-xl border border-remotiv-green/40" />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
