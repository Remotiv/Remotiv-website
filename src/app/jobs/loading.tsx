// Route-level loading state shown during navigation to /jobs while the server
// component awaits getInitialJobs(). Card-shaped pulses roughly match the
// real layout (hero band + 3-column card grid below) so the perceived
// transition feels continuous rather than "loading spinner → cards appear".

export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading jobs"
      className="min-h-screen bg-[#FAFAFA] px-5 pt-6 sm:px-6 md:px-6 animate-pulse"
    >
      {/* Hero strip (2-up) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="min-h-[280px] rounded-[20px] bg-[#0e0e0e]/80" />
        <div className="min-h-[160px] max-h-[320px] rounded-[20px] bg-[#0e0e0e]/60 md:min-h-[280px]" />
      </div>

      {/* Purple search band */}
      <div className="mt-2 h-[140px] rounded-[20px] bg-remotiv-purple/30" />

      {/* Sidebar + cards grid */}
      <div className="mt-4 grid grid-cols-1 items-start gap-6 pb-16 sm:grid-cols-1 xl:grid-cols-[280px_1fr]">
        <div className="hidden h-[400px] rounded-[20px] border border-black/[0.08] bg-white xl:block" />
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders have no stable identity
              key={i}
              className="h-[240px] rounded-[20px] border border-black/[0.08] bg-white"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
