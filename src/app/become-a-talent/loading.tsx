// Route-level loading state shown during navigation to /become-a-talent.
// Block-shaped placeholders mirror the real page layout:
//   bat-outer hero band (#F5F1EC, rounded-[32px]) — pill + heading + subtitle + purple stats row
//   bta-steps-bar — sticky white nav with 4 step pills + connecting lines
//   bta-layout grid (1fr 280px) — form card on the left, perks sidebar on the right
// Sidebar is hidden below 1024px, matching the real page's bta-layout breakpoint.

export default function BecomeATalentLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Join as Talent"
      className="min-h-screen bg-white motion-safe:animate-pulse"
    >
      {/* Hero outer wrapper — bat-outer (bg-white, p-6) wrapping bat-wrap (#F5F1EC, rounded) */}
      <div className="bg-white p-6">
        <div
          className="mx-auto flex max-w-[1100px] flex-col items-center overflow-hidden rounded-[32px] px-6 pb-12 pt-[72px]"
          style={{ background: "#F5F1EC" }}
        >
          {/* bat-pill — "Now | Hiring Globally" pill */}
          <div className="mb-8 h-8 w-[200px] rounded-full border border-black/[0.08] bg-white/70" />

          {/* bat-h1 — two-line large heading */}
          <div className="mb-3 h-14 w-[70%] max-w-[600px] rounded-md bg-black/[0.08]" />
          <div className="mb-7 h-14 w-[50%] max-w-[440px] rounded-md bg-black/[0.08]" />

          {/* bat-sub — subtitle paragraph */}
          <div className="mb-2 h-4 w-[55%] max-w-[480px] rounded bg-black/[0.06]" />
          <div className="mb-12 h-4 w-[40%] max-w-[380px] rounded bg-black/[0.06]" />

          {/* bat-stats — purple bar with 4 stat blocks */}
          <div className="flex w-full max-w-[1040px] overflow-hidden rounded-[20px] bg-remotiv-purple/25">
            <div className="flex-1 border-r border-white/20 px-8 py-9">
              <div className="mb-3 h-10 w-[55%] max-w-[80px] rounded bg-white/20" />
              <div className="h-3 w-[70%] max-w-[90px] rounded bg-white/15" />
            </div>
            <div className="flex-1 border-r border-white/20 px-8 py-9">
              <div className="mb-3 h-10 w-[50%] max-w-[70px] rounded bg-white/20" />
              <div className="h-3 w-[75%] max-w-[100px] rounded bg-white/15" />
            </div>
            <div className="flex-1 border-r border-white/20 px-8 py-9">
              <div className="mb-3 h-10 w-[45%] max-w-[60px] rounded bg-white/20" />
              <div className="h-3 w-[80%] max-w-[110px] rounded bg-white/15" />
            </div>
            <div className="flex-1 px-8 py-9">
              <div className="mb-3 h-10 w-[60%] max-w-[75px] rounded bg-white/20" />
              <div className="h-3 w-[70%] max-w-[95px] rounded bg-white/15" />
            </div>
          </div>
        </div>
      </div>

      {/* bta-steps-bar — sticky white nav with 4 step pills + connectors */}
      <div className="sticky top-0 z-50 border-b border-black/[0.07] bg-white">
        <div className="mx-auto flex max-w-[800px] items-center justify-center px-10">
          {/* Step 1 (active) */}
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="size-6 shrink-0 rounded-full border border-remotiv-green bg-remotiv-green/20" />
            <div className="h-3 w-20 rounded bg-black/[0.07]" />
          </div>
          <div className="h-px w-9 bg-black/[0.10]" />
          {/* Step 2 */}
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.15] bg-remotiv-bg" />
            <div className="h-3 w-28 rounded bg-black/[0.06]" />
          </div>
          <div className="h-px w-9 bg-black/[0.10]" />
          {/* Step 3 */}
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.15] bg-remotiv-bg" />
            <div className="h-3 w-24 rounded bg-black/[0.06]" />
          </div>
          <div className="h-px w-9 bg-black/[0.10]" />
          {/* Step 4 */}
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="size-6 shrink-0 rounded-full border border-black/[0.15] bg-remotiv-bg" />
            <div className="h-3 w-16 rounded bg-black/[0.06]" />
          </div>
        </div>
      </div>

      {/* bta-layout — 1fr + 280px sidebar grid */}
      <div
        className="mx-auto grid items-start gap-6 px-10 pb-24 pt-8 bat-loading-grid"
        style={{ maxWidth: 1100, gridTemplateColumns: "1fr 280px" }}
      >
        {/* bta-form-card — cream-bg rounded card */}
        <div
          className="overflow-hidden rounded-[20px] border border-black/[0.08]"
          style={{ background: "#f8f4f1" }}
        >
          {/* bta-form-header: icon circle + step title + subtitle */}
          <div className="flex items-center gap-3.5 border-b border-black/[0.07] bg-white px-8 py-6">
            <div className="size-11 shrink-0 rounded-[10px] border border-remotiv-green/20 bg-remotiv-green/10" />
            <div>
              <div className="mb-1.5 h-4 w-36 rounded bg-black/[0.08]" />
              <div className="h-3 w-56 rounded bg-black/[0.06]" />
            </div>
          </div>

          {/* bta-form-body: section title + two 2-col rows + two full-width inputs */}
          <div className="px-8 py-7">
            <div className="mb-5 h-3 w-24 rounded bg-black/[0.06]" />

            <div className="mb-3.5 grid grid-cols-2 gap-3.5">
              <div>
                <div className="mb-2 h-3 w-16 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
              <div>
                <div className="mb-2 h-3 w-16 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
            </div>

            <div className="mb-3.5 grid grid-cols-2 gap-3.5">
              <div>
                <div className="mb-2 h-3 w-12 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
              <div>
                <div className="mb-2 h-3 w-14 rounded bg-black/[0.06]" />
                <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
              </div>
            </div>

            <div className="mb-3.5">
              <div className="mb-2 h-3 w-20 rounded bg-black/[0.06]" />
              <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
            </div>

            <div>
              <div className="mb-2 h-3 w-16 rounded bg-black/[0.06]" />
              <div className="h-11 w-full rounded-[10px] border border-black/[0.08] bg-white" />
            </div>
          </div>

          {/* bta-form-footer: Back button + Next button */}
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] bg-white px-8 py-5">
            <div className="h-10 w-28 rounded-full bg-black/[0.06]" />
            <div className="h-10 w-44 rounded-full bg-remotiv-green/25" />
          </div>
        </div>

        {/* bta-sidebar — "Why Join Remotiv?" perks card */}
        <div className="bat-loading-sidebar flex flex-col gap-4">
          <div
            className="rounded-[18px] border border-black/[0.08] p-6"
            style={{ background: "#f8f4f1" }}
          >
            <div className="mb-4 h-3 w-32 rounded bg-black/[0.06]" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mb-4 flex items-start gap-3 last:mb-0">
                <div className="size-8 shrink-0 rounded-xl bg-black/[0.06]" />
                <div className="flex-1">
                  <div className="mb-1.5 h-3.5 w-3/4 rounded bg-black/[0.08]" />
                  <div className="h-3 w-full rounded bg-black/[0.06]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Collapse sidebar at the same 1024px breakpoint the real page uses */}
      <style>{`
        @media (max-width: 1024px) {
          .bat-loading-grid { grid-template-columns: 1fr !important; }
          .bat-loading-sidebar { display: none !important; }
        }
        @media (max-width: 768px) {
          .bat-loading-grid { padding-left: 20px !important; padding-right: 20px !important; }
        }
      `}</style>
    </div>
  );
}
