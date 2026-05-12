import { Check } from "lucide-react";
import type { CSSPropertiesWithVars } from "@/lib/css-types";

const CARDS = [
  {
    num: "01",
    tag: "Quality assured",
    title: "Pre-vetted talent only",
    body: "Every candidate passes our 4-stage AI + human vetting before you ever see their profile. No guesswork, no surprises.",
  },
  {
    num: "02",
    tag: "Lightning fast",
    title: "Precision Speed (24-Hour Turnaround)",
    body: "Receive a curated shortlist of top candidates within 24 hours of sharing your brief. It&apos;s the fastest turnaround in the industry.",
  },
  {
    num: "03",
    tag: "Zero risk",
    title: "The Zero-Risk Performance Guarantee",
    body: "You only pay when you make a successful hire. No retainer fees, no hidden markups, and zero risk to your operating budget.",
  },
  {
    num: "04",
    tag: "Your terms",
    title: "No Lock-In Contracts",
    body: "Full-time, part-time, or contract. Scale your engineering capacity up or down as your product roadmap demands.",
  },
  {
    num: "05",
    tag: "World-class",
    title: "Global expertise",
    body: "Pakistan's top 1% — engineers and professionals ready to collaborate with global teams from day one.",
  },
] as const;

export function WhyRemotiv() {
  return (
    <section className="bg-white px-6 pt-16 pb-20 sm:px-[60px] md:pt-24 md:pb-[120px]">
      <div className="mx-auto grid max-w-7xl items-start gap-12 md:grid-cols-[1fr_1fr] md:gap-[72px]">
        <div className="flex flex-col md:sticky md:top-[60px]">
          <div className="mb-6 flex items-center gap-3">
            <span className="block h-px w-7 bg-black" />
            <span className="font-sans text-[0.62rem] font-bold uppercase tracking-[0.18em] text-[#111]">
              Why choose us
            </span>
          </div>

          <h2 className="mb-[22px] font-heading text-[1.8rem] font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[#111] sm:text-[clamp(2.2rem,3.8vw,3.2rem)]">
            Why founders
            <br />
            <span className="text-remotiv-purple">choose Remotiv?</span>
          </h2>

          <p className="mb-11 max-w-[360px] font-sans text-[0.95rem] leading-[1.75] text-[#777]">
            We don&apos;t just find talent — we deliver the right fit, fast. No hire, no fee.
            Here&apos;s what sets us apart from every other hiring platform.
          </p>

          <div className="rounded-2xl bg-[#111] px-9 py-8">
            <span className="mb-3 block font-sans text-[0.58rem] font-bold uppercase tracking-[0.16em] text-remotiv-green">
              Our guarantee
            </span>
            <p className="mb-2 font-heading text-[1.05rem] font-bold leading-[1.45] text-white">
              &ldquo;You only pay when you hire successfully.&rdquo;
            </p>
            <p className="font-sans text-[0.82rem] text-[#555]">
              No placement, no invoice. Zero risk to your budget.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4" style={{ perspective: "1000px" }}>
          {CARDS.map((card, i) => (
            <div
              key={card.num}
              className="wr-card sticky rounded-[20px] border border-black/[0.07] bg-remotiv-purple-light px-6 py-6 shadow-[0_2px_16px_rgba(0,0,0,0.06)] transition-shadow duration-300 hover:shadow-[0_4px_28px_rgba(73,215,167,0.18),0_1px_4px_rgba(0,0,0,0.08)] [top:var(--card-top)] md:px-9 md:py-8 md:[top:var(--card-top-md)] md:[transform:translateZ(var(--card-z))]"
              style={
                {
                  zIndex: i + 1,
                  "--card-top": `${(i + 1) * 12}px`,
                  "--card-top-md": `${(i + 1) * 18}px`,
                  "--card-z": `${(i + 1) * 12}px`,
                } as CSSPropertiesWithVars
              }
            >
              <div className="mb-3.5 flex items-start justify-between">
                <span className="font-heading text-2xl font-extrabold leading-none text-white">
                  {card.num}
                </span>
                <span className="flex size-9 items-center justify-center rounded-[10px] bg-white/15">
                  <Check className="size-4 text-white" strokeWidth={2.5} />
                </span>
              </div>

              <span className="mb-3 inline-block rounded-full bg-[#111] px-3.5 py-[5px] font-sans text-[0.7rem] font-bold uppercase tracking-[0.06em] text-white md:text-[0.65rem]">
                {card.tag}
              </span>

              <h3 className="mb-2 font-heading text-[1.05rem] font-bold text-white">
                {card.title}
              </h3>

              <p className="font-sans text-[0.88rem] leading-[1.7] text-white/80">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
