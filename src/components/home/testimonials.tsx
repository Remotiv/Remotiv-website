"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

const TESTIMONIALS = [
  {
    text: "Remotiv provided candidates faster and of higher quality than most overseas recruiters I've used. Communication was strong, leading to a long working relationship. Very happy with our time working with Remotiv.",
    name: "Daniel Magazu",
    role: "CEO, Ride the Wave",
    img: "/client-avatars/male-001.webp",
  },
  {
    text: "It was a great experience working with the Remotiv team. They were responsive and consistently shared candidate details in a timely manner. The information provided was comprehensive.",
    name: "Sidra Hafeez",
    role: "HR Officer, Terafort Pvt. Ltd",
    img: "/client-avatars/female-001.webp",
  },
  {
    text: "We needed a senior backend engineer in under a week and Remotiv made it happen. The shortlist was tight, the candidates were sharp, and the one we hired is still with us a year later.",
    name: "Ahmed Siddiqui",
    role: "Chief Technology Officer, Karachi Digital Works",
    img: "/client-avatars/male-002.webp",
  },
  {
    text: "I've worked with three other recruiting platforms and none of them screened candidates properly. Remotiv is the first one where every interview felt worth my time.",
    name: "Sarah Whitman",
    role: "Head of Engineering, Northwind Solutions",
    img: "/client-avatars/female-002.webp",
  },
  {
    text: "From brief to first interview in 22 hours. I've never seen turnaround like this. Two weeks later we'd hired two engineers — both still on the team.",
    name: "Bilal Tariq",
    role: "Founder & CEO, Lahore Studio Co.",
    img: "/client-avatars/male-003.webp",
  },
  {
    text: "We're a small agency and every hire matters. Remotiv understood that and only sent us candidates who actually fit our scope and budget. No filler.",
    name: "Michael Brennan",
    role: "Managing Director, Halverson Digital",
    img: "/client-avatars/male-004.webp",
  },
  {
    text: "The cultural fit on Remotiv hires has been better than our local pipeline, honestly. They get what we're building before the first call.",
    name: "Ayesha Malik",
    role: "VP of People, Indus Tech Group",
    img: "/client-avatars/female-003.webp",
  },
  {
    text: "We scaled from 4 engineers to 11 in two months without compromising on quality. Remotiv was the only reason that was possible.",
    name: "Reuben Carter",
    role: "Co-Founder & CTO, Stagehand Labs",
    img: "/client-avatars/male-005.webp",
  },
  {
    text: "What sold me was the no-hire-no-fee model. Removed the entire risk side of trying a new recruiter. Now they're our default for every senior role.",
    name: "Caleb Whitaker",
    role: "Head of Talent Acquisition, Brixton Partners",
    img: "/client-avatars/male-006.webp",
  },
] as const;

type ColumnSpec = {
  indices: number[];
  duration: string;
  mobileDuration?: string;
  visibility: string;
};

const COLUMNS: ColumnSpec[] = [
  { indices: [0, 3, 6], duration: "28s", mobileDuration: "40s", visibility: "flex" },
  { indices: [1, 4, 7], duration: "22s", visibility: "hidden md:flex" },
  { indices: [2, 5, 8], duration: "25s", visibility: "hidden lg:flex" },
];

function TestimonialCard({ text, name, role, img }: (typeof TESTIMONIALS)[number]) {
  return (
    <div className="rounded-[20px] border-[1.5px] border-[#f8f4f1] bg-[#f8f4f1] p-7 shadow-[0_4px_24px_rgba(0,0,0,0.04),0_1px_4px_rgba(0,0,0,0.04)] transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_32px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.06)]">
      <p className="mb-5 font-sans text-[0.9rem] leading-[1.65] text-[#453e40]">{`"${text}"`}</p>
      <div className="flex items-center gap-3">
        <Image
          src={img}
          alt={name}
          width={40}
          height={40}
          className="rounded-full object-cover"
        />
        <div>
          <p className="font-sans text-[0.88rem] font-semibold leading-[1.3] text-[#111]">{name}</p>
          <p className="font-sans text-[0.8rem] leading-[1.3] text-[#111]">{role}</p>
        </div>
      </div>
    </div>
  );
}

function ScrollColumn({
  indices,
  duration,
  mobileDuration,
}: {
  indices: number[];
  duration: string;
  mobileDuration?: string;
}) {
  const [paused, setPaused] = useState(false);
  const [actualDuration, setActualDuration] = useState(duration);

  useEffect(() => {
    if (!mobileDuration) {
      setActualDuration(duration);
      return;
    }

    const mql = window.matchMedia("(max-width: 767px)");
    const apply = () => {
      setActualDuration(mql.matches ? mobileDuration : duration);
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [duration, mobileDuration]);

  const cards = indices.map((i) => TESTIMONIALS[i]);

  return (
    <section
      aria-label="Scrolling testimonials"
      className="relative flex w-[280px] flex-shrink-0 flex-col overflow-hidden sm:w-[300px]"
      style={{ height: 600 }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => setPaused((p) => !p)}
    >
      <div
        className="flex flex-col gap-5"
        style={{
          animation: `scroll-up ${actualDuration} linear infinite`,
          animationPlayState: paused ? "paused" : "running",
        }}
      >
        {[...cards, ...cards].map((card, idx) => (
          <TestimonialCard key={`${card.name}-${idx < cards.length ? "a" : "b"}`} {...card} />
        ))}
      </div>
    </section>
  );
}

export function Testimonials() {
  return (
    <section className="bg-white px-6 py-12 sm:px-16 md:py-[72px]">
      <div className="mx-auto max-w-7xl">
        <div className="mx-auto mb-10 flex max-w-[540px] flex-col items-center gap-4 text-center md:mb-14">
          <h2 className="font-heading text-[clamp(1.8rem,3.5vw,2.8rem)] font-extrabold leading-[1.15] tracking-[-0.03em] text-[#111]">
            What our clients say
          </h2>
          <p className="m-0 font-sans text-[0.95rem] leading-[1.6] text-[#453e40]">
            See what founders and engineering leaders say about hiring with Remotiv.
          </p>
        </div>

        <div className="relative flex max-h-[680px] justify-center gap-5 overflow-hidden">
          {COLUMNS.map((col) => (
            <div key={col.duration} className={col.visibility}>
              <ScrollColumn
                indices={col.indices}
                duration={col.duration}
                mobileDuration={col.mobileDuration}
              />
            </div>
          ))}

          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-gradient-to-b from-white to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-white to-transparent" />
        </div>
      </div>
    </section>
  );
}
