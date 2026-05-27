// Route-level loading state shown during navigation to /ai-results while the
// page chunk loads and the client component mounts. Block-shaped placeholders
// mirror the real LoadingPanel layout (shown internally while the /api/ai-matching
// fetch is in flight):
//   Central hero — green orb + "Finding…" heading + 4 step pill outlines
//   5 candidate-card skeletons — matching the SkeletonCard shape used by the
//   real page (name + role badge + location + summary + skills + contact chips
//   on the left; score block + View Profile + Save on the right)

export default function AIResultsLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading AI matching results"
      className="min-h-screen bg-remotiv-bg motion-safe:animate-pulse"
    >
      {/* Hero — mirrors LoadingPanel's top section */}
      <section className="bg-remotiv-bg px-6 py-16 text-center sm:px-10 sm:py-20">
        {/* Animated green orb (68px circle) */}
        <div className="mx-auto mb-5 size-[68px] rounded-full bg-remotiv-green/30" />
        {/* "Finding Your Best Matches…" heading */}
        <div className="mx-auto mb-2 h-5 w-[220px] rounded-md bg-black/[0.08]" />
        {/* Query preview bar */}
        <div className="mx-auto mb-8 h-3.5 w-[260px] rounded bg-black/[0.06]" />

        {/* 4 step pill outlines — mirrors LoadingSteps */}
        <div className="mx-auto flex max-w-[420px] flex-col gap-2">
          <div className="flex h-12 w-full items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-[18px]">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.12] bg-remotiv-bg" />
            <div className="h-3 w-36 rounded bg-black/[0.06]" />
          </div>
          <div className="flex h-12 w-full items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-[18px]">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.12] bg-remotiv-bg" />
            <div className="h-3 w-44 rounded bg-black/[0.06]" />
          </div>
          <div className="flex h-12 w-full items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-[18px]">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.12] bg-remotiv-bg" />
            <div className="h-3 w-28 rounded bg-black/[0.06]" />
          </div>
          <div className="flex h-12 w-full items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-[18px]">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.12] bg-remotiv-bg" />
            <div className="h-3 w-32 rounded bg-black/[0.06]" />
          </div>
        </div>
      </section>

      {/* 5 candidate-card skeletons — mirrors SkeletonCard × 5 */}
      <div className="mx-auto flex max-w-[900px] flex-col gap-2.5 px-6 pb-20 pt-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <article
            key={i}
            aria-hidden="true"
            className="grid grid-cols-1 gap-6 rounded-[20px] border border-black/[0.07] bg-white p-6 md:grid-cols-[1fr_auto]"
          >
            {/* Left column: name, role, location, AI-match note, bio, skills, contact chips */}
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2.5">
                <div className="h-4 w-32 rounded bg-black/[0.08]" />
                <div className="h-4 w-14 rounded bg-black/[0.06]" />
              </div>
              <div className="mb-2.5 h-3 w-3/5 rounded bg-black/[0.06]" />
              {/* AI match "why" note block */}
              <div className="mb-2.5 h-12 w-full rounded-[10px] bg-remotiv-green/[0.07]" />
              <div className="mb-3 h-3 w-4/5 rounded bg-black/[0.06]" />
              {/* Skill chips */}
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                <div className="h-5 w-16 rounded bg-black/[0.06]" />
                <div className="h-5 w-20 rounded bg-black/[0.06]" />
                <div className="h-5 w-14 rounded bg-black/[0.06]" />
                <div className="h-5 w-24 rounded bg-black/[0.06]" />
              </div>
              {/* Contact chips (GitHub / LinkedIn / Resume) */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <div className="h-7 w-20 rounded-full bg-black/[0.06]" />
                <div className="h-7 w-24 rounded-full bg-black/[0.06]" />
                <div className="h-7 w-20 rounded-full bg-black/[0.06]" />
              </div>
            </div>

            {/* Right column: score block + View Profile + Save */}
            <div className="flex flex-col items-stretch gap-2">
              <div className="h-[88px] w-[100px] rounded-[14px] bg-black/[0.06]" />
              <div className="h-9 w-full rounded-xl bg-remotiv-purple/20" />
              <div className="h-9 w-full rounded-xl border border-black/[0.08]" />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
