// Route-level loading state shown during navigation to /remote-ready while the
// page chunk loads. Block-shaped placeholders roughly match the real layout
// (hero band + stats strip + sticky steps bar + form card) so the perceived
// transition feels continuous rather than blank → content.

export default function RemoteReadyLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Remote-Ready application"
      className="min-h-screen bg-white motion-safe:animate-pulse"
    >
      {/* Hero band — mirrors .bat-wrap (bg #F5F1EC, big heading, sub-paragraph, stats row) */}
      <section className="px-6 py-16 text-center" style={{ background: "#F5F1EC" }}>
        <div className="mx-auto mb-8 h-7 w-[210px] rounded-full bg-black/[0.06]" />
        <div className="mx-auto mb-3 h-12 w-[80%] max-w-[720px] rounded-md bg-black/[0.08]" />
        <div className="mx-auto mb-7 h-12 w-[60%] max-w-[560px] rounded-md bg-black/[0.08]" />
        <div className="mx-auto mb-2 h-3 w-[70%] max-w-[560px] rounded bg-black/[0.06]" />
        <div className="mx-auto mb-10 h-3 w-[55%] max-w-[440px] rounded bg-black/[0.06]" />

        {/* Stats row (3 stat blocks side by side) */}
        <div className="mx-auto flex max-w-[860px] flex-row items-stretch overflow-hidden rounded-[20px] bg-remotiv-purple/30">
          <div className="flex-1 px-7 py-9">
            <div className="mx-auto mb-3 h-6 w-[60%] max-w-[140px] rounded bg-white/30" />
            <div className="mx-auto h-3 w-[40%] max-w-[100px] rounded bg-white/20" />
          </div>
          <div className="flex-1 border-x border-white/10 px-7 py-9">
            <div className="mx-auto mb-3 h-6 w-[50%] max-w-[120px] rounded bg-white/30" />
            <div className="mx-auto h-3 w-[35%] max-w-[80px] rounded bg-white/20" />
          </div>
          <div className="flex-1 px-7 py-9">
            <div className="mx-auto mb-3 h-6 w-[55%] max-w-[130px] rounded bg-white/30" />
            <div className="mx-auto h-3 w-[45%] max-w-[110px] rounded bg-white/20" />
          </div>
        </div>
      </section>

      {/* Steps bar (sticky white strip with 4 step pills) */}
      <div className="border-b border-black/[0.07] bg-white">
        <div className="mx-auto flex max-w-[880px] items-center gap-3 px-10 py-4">
          <div className="size-6 shrink-0 rounded-full bg-black/[0.06]" />
          <div className="h-3 w-32 rounded bg-black/[0.06]" />
          <div className="h-px flex-1 bg-black/[0.06]" />
          <div className="size-6 shrink-0 rounded-full bg-black/[0.06]" />
          <div className="h-3 w-36 rounded bg-black/[0.06]" />
          <div className="h-px flex-1 bg-black/[0.06]" />
          <div className="size-6 shrink-0 rounded-full bg-black/[0.06]" />
          <div className="h-3 w-32 rounded bg-black/[0.06]" />
          <div className="h-px flex-1 bg-black/[0.06]" />
          <div className="size-6 shrink-0 rounded-full bg-black/[0.06]" />
          <div className="h-3 w-40 rounded bg-black/[0.06]" />
        </div>
      </div>

      {/* Form card (rounded white card with header + body + footer) */}
      <section className="px-6 py-10 sm:px-10">
        <div
          className="mx-auto max-w-[760px] overflow-hidden rounded-[20px] border border-black/[0.08]"
          style={{ background: "#f8f4f1" }}
        >
          {/* Header (icon + title + sub) */}
          <div className="flex items-start gap-4 border-b border-black/[0.06] bg-white px-8 py-6">
            <div className="size-10 shrink-0 rounded-[10px] bg-black/[0.08]" />
            <div className="flex-1">
              <div className="mb-2 h-4 w-[40%] max-w-[200px] rounded bg-black/[0.08]" />
              <div className="h-3 w-[70%] max-w-[360px] rounded bg-black/[0.06]" />
            </div>
          </div>

          {/* Form body — section title + a grid of input rows */}
          <div className="px-8 py-7">
            <div className="mb-5 h-3 w-28 rounded bg-black/[0.06]" />
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-2 h-3 w-20 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
              <div>
                <div className="mb-2 h-3 w-20 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
            </div>
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-2 h-3 w-24 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
              <div>
                <div className="mb-2 h-3 w-24 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
            </div>
            <div className="mb-4">
              <div className="mb-2 h-3 w-32 rounded bg-black/[0.06]" />
              <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
            </div>
            <div className="mb-4">
              <div className="mb-2 h-3 w-28 rounded bg-black/[0.06]" />
              <div className="h-24 w-full rounded-[10px] border border-black/[0.08] bg-white" />
            </div>
          </div>

          {/* Footer (back + next buttons) */}
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] bg-white px-8 py-5">
            <div className="h-10 w-[120px] rounded-full bg-black/[0.06]" />
            <div className="h-10 w-[220px] rounded-full bg-black/[0.08]" />
          </div>
        </div>
      </section>
    </div>
  );
}
