"use client";

import { Check } from "lucide-react";

const CARDS = [
  {
    number: "01",
    tag: "Quality assured",
    title: "Pre-vetted talent only",
    description:
      "Every candidate passes our 4-stage AI + human vetting before you ever see their profile. No guesswork, no surprises.",
  },
  {
    number: "02",
    tag: "Lightning fast",
    title: "Precision Speed (24-Hour Turnaround)",
    description:
      "Receive a curated shortlist of top candidates within 24 hours of sharing your brief. It is the fastest turnaround in the industry.",
  },
  {
    number: "03",
    tag: "Zero risk",
    title: "The Zero-Risk Performance Guarantee",
    description:
      "You only pay when you make a successful hire. No retainer fees, no hidden markups, and zero risk to your operating budget.",
  },
  {
    number: "04",
    tag: "Your terms",
    title: "No Lock-In Contracts",
    description:
      "Full-time, part-time, or contract. Scale your engineering capacity up or down as your product roadmap demands.",
  },
  {
    number: "05",
    tag: "World-class",
    title: "Global expertise",
    description:
      "Pakistan's top 1% — engineers and professionals ready to collaborate with global teams from day one.",
  },
] as const;

export function WhyRemotiv() {
  return (
    <section className="bg-white px-6 pt-24 pb-[120px] sm:px-[60px]">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[1fr_1fr] lg:gap-[72px]">
        {/* Left column */}
        <div className="lg:sticky lg:top-[60px] lg:self-start">
          <span className="mb-3 inline-block text-sm font-medium tracking-wide text-remotiv-text-light uppercase">
            Why choose us
          </span>
          <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
            Why Founders Choose <span className="text-remotiv-purple-light">Remotiv</span>?
          </h2>
          <p className="mt-4 max-w-md text-base leading-relaxed text-remotiv-text-mid">
            We don&apos;t just find talent — we deliver the right fit, fast. No hire, no fee.
            Here&apos;s what sets us apart from every other hiring platform.
          </p>

          {/* Guarantee box */}
          <div className="mt-10 rounded-2xl bg-[#111] p-7">
            <span className="mb-4 inline-block rounded-full bg-remotiv-green px-4 py-1.5 text-xs font-semibold text-white">
              Our guarantee
            </span>
            <p className="text-lg font-medium leading-snug text-white">
              &ldquo;You only pay when you hire successfully.&rdquo;
            </p>
            <p className="mt-4 text-sm text-white/50">
              No placement, no invoice. Zero risk to your budget.
            </p>
          </div>
        </div>

        {/* Right column — stacking sticky cards */}
        <div className="flex flex-col gap-6">
          {CARDS.map((card, i) => (
            <div
              key={card.number}
              className="rounded-2xl bg-[#c9ff85] p-7 lg:sticky"
              style={{ top: `${(i + 1) * 18}px` }}
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="font-heading text-sm font-bold text-black/30">{card.number}</span>
                <span className="flex size-8 items-center justify-center rounded-full bg-black/10">
                  <Check className="size-4 text-black" />
                </span>
              </div>
              <span className="mb-3 inline-block rounded-full bg-black px-4 py-1.5 text-xs font-semibold text-white">
                {card.tag}
              </span>
              <h3 className="font-heading text-xl font-bold text-remotiv-text-dark">
                {card.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-remotiv-text-mid">
                {card.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
