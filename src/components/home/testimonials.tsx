"use client";

import Image from "next/image";
import { useState } from "react";

const TESTIMONIALS = [
  {
    text: "Remotiv delivered a senior React developer within 18 hours. We were blown away by the quality and speed. This is how hiring should work.",
    name: "James Carter",
    role: "CTO, Stackflow",
  },
  {
    text: "We've tried Upwork, Toptal, and others. Remotiv is the only platform that actually pre-vets talent properly. Saved us months of interviews.",
    name: "Sarah Mitchell",
    role: "Head of Engineering, Buildify",
  },
  {
    text: "Incredible value. The engineers we hired through Remotiv are among the best we've ever worked with — and at a fraction of the cost.",
    name: "Omar Farooq",
    role: "CEO, NovaSoft",
  },
  {
    text: "The AI matching is genuinely impressive. It didn't just find us candidates — it found us the right candidates for our specific stack.",
    name: "Priya Nair",
    role: "VP Product, Loopscale",
  },
  {
    text: "Our dedicated team from Remotiv has been with us for 8 months now. Zero turnover, full commitment. Exactly what a growing startup needs.",
    name: "David Lenz",
    role: "Founder, Growthdeck",
  },
  {
    text: "From job post to offer letter in under 24 hours. I thought it was a gimmick — it absolutely wasn't. Remotiv is the real deal.",
    name: "Layla Hassan",
    role: "COO, Fintrax",
  },
  {
    text: "The talent quality is exceptional. We hired 4 engineers who all passed our internal technical bar — something that rarely happens.",
    name: "Tom Eriksson",
    role: "Engineering Manager, Claritex",
  },
  {
    text: "Staff augmentation done right. Remotiv understood our culture and sent us people who actually fit our team, not just the job description.",
    name: "Amara Diallo",
    role: "People Lead, Basecamp Digital",
  },
  {
    text: "We scaled our dev team from 3 to 12 in two months using Remotiv. The process was seamless and every hire has been a keeper.",
    name: "Kevin Walsh",
    role: "CTO, Shiplink",
  },
] as const;

const COLUMNS: [number[], string][] = [
  [[0, 3, 6], "28s"],
  [[1, 4, 7], "22s"],
  [[2, 5, 8], "25s"],
];

function TestimonialCard({ text, name, role }: (typeof TESTIMONIALS)[number]) {
  return (
    <div className="rounded-2xl bg-[#f8f4f1] p-6">
      <p className="text-sm leading-relaxed text-remotiv-text-mid">{text}</p>
      <div className="mt-5 flex items-center gap-3">
        <Image
          src="https://placehold.co/40x40"
          alt={name}
          width={40}
          height={40}
          className="rounded-full"
          unoptimized
        />
        <div>
          <p className="text-sm font-semibold text-remotiv-text-dark">{name}</p>
          <p className="text-xs text-remotiv-text-light">{role}</p>
        </div>
      </div>
    </div>
  );
}

function ScrollColumn({ indices, duration }: { indices: number[]; duration: string }) {
  const [paused, setPaused] = useState(false);

  const cards = indices.map((i) => TESTIMONIALS[i]);

  return (
    <section
      aria-label="Scrolling testimonials"
      className="relative flex flex-col overflow-hidden"
      style={{ height: 600 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        className="flex flex-col gap-5"
        style={{
          animation: `scroll-up ${duration} linear infinite`,
          animationPlayState: paused ? "paused" : "running",
        }}
      >
        {[...cards, ...cards].map((card, idx) => (
          <TestimonialCard key={`${card.name}-${idx < cards.length ? "a" : "b"}`} {...card} />
        ))}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-white to-transparent" />
    </section>
  );
}

export function Testimonials() {
  return (
    <section className="bg-white px-6 pt-0 pb-20 sm:px-16">
      <div className="mx-auto max-w-7xl">
        <div className="mb-14 text-center">
          <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
            What our clients say
          </h2>
          <p className="mt-4 text-base text-remotiv-text-mid">
            See what founders and engineering leaders say about hiring with Remotiv.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {COLUMNS.map(([indices, duration], colIdx) => (
            <div
              key={duration}
              className={colIdx === 1 ? "hidden md:block" : colIdx === 2 ? "hidden lg:block" : ""}
            >
              <ScrollColumn indices={indices} duration={duration} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
