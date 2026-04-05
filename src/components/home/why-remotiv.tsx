"use client";

import { Check } from "lucide-react";

const CARDS = [
  {
    number: "01",
    tag: "Pre-vetted talent",
    title: "Only the Top 1% Make It Through",
    description:
      "Every engineer passes a rigorous multi-stage vetting process — technical interviews, live coding, and real-world project simulations. You get battle-tested talent, not résumé padding.",
  },
  {
    number: "02",
    tag: "24-Hour Turnaround",
    title: "Matched Within a Day, Not Months",
    description:
      "Submit your requirements and receive curated engineer profiles in under 24 hours. No recruiter runaround, no weeks of waiting.",
  },
  {
    number: "03",
    tag: "Zero-Risk Guarantee",
    title: "Try Risk-Free for 2 Weeks",
    description:
      "If your engineer isn't the right fit within the first two weeks, we replace them at no cost — or you walk away with a full refund. Zero risk, full confidence.",
  },
  {
    number: "04",
    tag: "No Lock-In",
    title: "Month-to-Month, Cancel Anytime",
    description:
      "We don't trap you in long-term contracts. Scale up, scale down, or pause — your team, your terms.",
  },
  {
    number: "05",
    tag: "Global expertise",
    title: "Senior Engineers Across Every Stack",
    description:
      "React, Node, Python, Go, AWS, Kubernetes — our global network spans 40+ countries and 100+ technologies so you always find the exact skill set you need.",
  },
] as const;

export function WhyRemotiv() {
  return (
    <section className="bg-white px-6 py-16 sm:px-[60px] sm:py-24">
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
            We built Remotiv for teams that can&apos;t afford to waste time on bad hires.
            Here&apos;s what sets us apart.
          </p>

          {/* Guarantee box */}
          <div className="mt-10 rounded-2xl bg-[#111] p-7">
            <span className="mb-4 inline-block rounded-full bg-remotiv-green px-4 py-1.5 text-xs font-semibold text-white">
              Our guarantee
            </span>
            <p className="text-lg font-medium leading-snug text-white">
              &ldquo;If you&apos;re not completely satisfied with your engineer within the first two
              weeks, we&apos;ll replace them — or give you a full refund.&rdquo;
            </p>
            <p className="mt-4 text-sm text-white/50">No questions asked. No hidden clauses.</p>
          </div>
        </div>

        {/* Right column — stacking sticky cards */}
        <div className="flex flex-col gap-6">
          {CARDS.map((card, i) => (
            <div
              key={card.number}
              className="rounded-2xl bg-[#c9ff85] p-7 lg:sticky"
              style={{ top: `${60 + i * 40}px` }}
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
