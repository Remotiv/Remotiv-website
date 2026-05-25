// Route-level loading state shown during navigation to /ai-matching while the
// page chunk loads. Block-shaped placeholders roughly match the real layout
// (hero + form card + chips + "How It Works" 3-up) so the perceived transition
// feels continuous rather than blank → content.

export default function AiMatchingLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading AI Matching"
      className="min-h-screen bg-remotiv-bg motion-safe:animate-pulse"
    >
      {/* Hero */}
      <section className="px-6 pb-10 pt-[72px] text-center">
        <div className="mx-auto mb-6 h-7 w-[190px] rounded-full bg-black/[0.06]" />
        <div className="mx-auto mb-3 h-12 w-[70%] max-w-[640px] rounded-md bg-black/[0.08]" />
        <div className="mx-auto mb-6 h-12 w-[50%] max-w-[480px] rounded-md bg-black/[0.08]" />
        <div className="mx-auto mb-2 h-3 w-[80%] max-w-[520px] rounded bg-black/[0.06]" />
        <div className="mx-auto mb-10 h-3 w-[60%] max-w-[420px] rounded bg-black/[0.06]" />

        {/* Search form card */}
        <div className="mx-auto mb-7 max-w-[760px] overflow-hidden rounded-[20px] border border-black/[0.08] bg-white p-5 shadow-[0_8px_32px_rgba(0,0,0,0.07)]">
          <div className="mb-3 h-3 w-56 rounded bg-black/[0.06]" />
          <div className="mb-3 h-[100px] w-full rounded-md bg-black/[0.06]" />
          <div className="mb-3 ml-auto h-3 w-12 rounded bg-black/[0.06]" />
          <div className="-mx-5 -mb-5 h-[50px] w-[calc(100%+2.5rem)] bg-remotiv-purple/30" />
        </div>

        {/* Suggestion chips */}
        <div className="mx-auto mb-2 h-3 w-32 rounded bg-black/[0.06]" />
        <div className="mx-auto flex max-w-[760px] flex-wrap justify-center gap-2.5">
          <div className="h-11 w-[210px] rounded-full border border-black/[0.08] bg-white" />
          <div className="h-11 w-[260px] rounded-full border border-black/[0.08] bg-white" />
          <div className="h-11 w-[300px] rounded-full border border-black/[0.08] bg-white" />
          <div className="h-11 w-[230px] rounded-full border border-black/[0.08] bg-white" />
          <div className="h-11 w-[250px] rounded-full border border-black/[0.08] bg-white" />
        </div>
      </section>

      {/* How It Works band */}
      <section className="border-b border-black/[0.07] bg-remotiv-bg px-6 py-12 sm:px-10 sm:py-14 md:px-14 md:py-16">
        <div className="mx-auto max-w-[1000px]">
          <div className="mb-3 h-3 w-32 rounded bg-black/[0.06]" />
          <div className="mb-10 h-10 w-[60%] max-w-[520px] rounded-md bg-black/[0.08]" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="h-[200px] rounded-[20px] border border-black/[0.08] bg-white" />
            <div className="h-[200px] rounded-[20px] border border-black/[0.08] bg-white" />
            <div className="h-[200px] rounded-[20px] border border-black/[0.08] bg-white" />
          </div>
        </div>
      </section>
    </div>
  );
}
