"use client";

import Image from "next/image";
import { useState } from "react";

const TESTIMONIALS = [
  {
    text: "Remotiv matched us with a senior React engineer in under 18 hours. He integrated with our team seamlessly and shipped a critical feature within his first week.",
    name: "James Carter",
    role: "CTO, Stackflow",
  },
  {
    text: "We needed three backend engineers for a tight deadline. Remotiv delivered exactly the calibre we needed — no compromises, no delays.",
    name: "Sarah Mitchell",
    role: "Head of Engineering, Buildify",
  },
  {
    text: "As a non-technical founder, I was nervous about hiring engineers remotely. Remotiv handled everything — vetting, onboarding, even the initial sprint planning.",
    name: "Omar Farooq",
    role: "CEO, NovaSoft",
  },
  {
    text: "The zero-risk guarantee gave us the confidence to try it. Three months in, our Remotiv engineers feel like full-time team members.",
    name: "Priya Nair",
    role: "VP Product, Loopscale",
  },
  {
    text: "We scaled from 2 to 8 engineers in a month without sacrificing quality. Remotiv's vetting process is genuinely best-in-class.",
    name: "David Lenz",
    role: "Founder, Growthdeck",
  },
  {
    text: "What impressed me most was the speed. We went from first call to a fully onboarded engineer in 48 hours flat.",
    name: "Layla Hassan",
    role: "COO, Fintrax",
  },
  {
    text: "I've used three staffing platforms before. Remotiv is the only one where every single engineer exceeded expectations.",
    name: "Tom Eriksson",
    role: "Engineering Manager, Claritex",
  },
  {
    text: "Remotiv doesn't just fill seats — they genuinely match talent to culture. Our retention rate with their engineers is 95%.",
    name: "Amara Diallo",
    role: "People Lead, Basecamp Digital",
  },
  {
    text: "We saved roughly 40% compared to local hiring, and the engineers are just as senior. It's a no-brainer for any startup watching burn.",
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
    <section className="bg-white px-6 py-16 sm:px-14 sm:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-14 text-center">
          <h2 className="font-heading text-3xl font-bold tracking-tight text-remotiv-text-dark sm:text-4xl md:text-[42px] md:leading-[1.15]">
            What our clients say
          </h2>
          <p className="mt-4 text-base text-remotiv-text-mid">
            Don&apos;t take our word for it — hear from the founders and engineering leaders who
            trust Remotiv.
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
