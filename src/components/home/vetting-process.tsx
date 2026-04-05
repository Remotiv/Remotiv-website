"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    number: "01",
    title: "Instant AI Sourcing",
    tag: "Automated Discovery",
    body: "Our AI engine scans millions of profiles in seconds, identifying candidates who match your exact tech stack, seniority level, and culture requirements — before a human ever gets involved.",
  },
  {
    number: "02",
    title: "Fluent English & Async Communication Audit",
    tag: "Communication Screening",
    body: "Every candidate completes a rigorous written and verbal English assessment, plus a simulated async collaboration exercise that mirrors real remote work — Slack threads, PR reviews, and stand-up summaries.",
  },
  {
    number: "03",
    title: "Live Peer-to-Peer Technical Testing",
    tag: "Technical Validation",
    body: "Candidates pair-program with senior engineers on real-world problems. We test system design, debugging under pressure, and code quality — not memorized algorithm puzzles.",
  },
  {
    number: "04",
    title: "Culture & Remote Alignment",
    tag: "Soft Skills & Fit",
    body: "A final deep-dive into work style, timezone flexibility, proactive communication habits, and alignment with your team's values. Only candidates who score in the top 1% advance.",
  },
] as const;

export function VettingProcess() {
  const [activeIndex, setActiveIndex] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observers: IntersectionObserver[] = [];

    stepRefs.current.forEach((el, i) => {
      if (!el) return;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveIndex(i);
        },
        { threshold: 0.6, rootMargin: "-10% 0px -40% 0px" },
      );

      observer.observe(el);
      observers.push(observer);
    });

    return () => {
      for (const o of observers) o.disconnect();
    };
  }, []);

  const progressPercent = ((activeIndex + 1) / STEPS.length) * 100;

  return (
    <section ref={sectionRef} className="bg-white px-6 py-20 md:px-16 lg:py-20">
      <div className="mx-auto max-w-[820px]">
        <span className="mb-4 inline-block rounded-full bg-remotiv-green/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-remotiv-green">
          Our Vetting Process
        </span>
        <h2 className="font-heading text-3xl font-bold leading-tight text-remotiv-text-dark sm:text-4xl lg:text-[2.75rem]">
          How We Deliver The <span className="text-remotiv-green">Top 1% of Talent</span> To Your
          Next Hire
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-remotiv-text-light">
          Every candidate passes through our four-stage AI-augmented vetting pipeline. The result:
          only the highest-calibre engineers make it to your shortlist.
        </p>

        <div className="relative mt-14">
          <div className="absolute left-[15px] top-0 h-full w-[2px] bg-gray-200 md:left-[19px]">
            <div
              className="w-full bg-remotiv-purple transition-all duration-500 ease-out"
              style={{ height: `${progressPercent}%` }}
            />
          </div>

          <div className="space-y-10">
            {STEPS.map((step, i) => {
              const isActive = i <= activeIndex;

              return (
                <div
                  key={step.number}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  className="relative pl-12 md:pl-14"
                >
                  <div
                    className={cn(
                      "absolute left-[9px] top-1 size-[14px] rounded-full border-2 transition-colors duration-300 md:left-[13px]",
                      isActive
                        ? "border-remotiv-purple bg-remotiv-purple"
                        : "border-gray-300 bg-white",
                    )}
                  />

                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "font-heading text-xs font-bold tracking-widest transition-colors duration-300",
                        isActive ? "text-remotiv-purple" : "text-remotiv-text-light",
                      )}
                    >
                      {step.number}
                    </span>
                    <span className="rounded-full bg-gray-100 px-3 py-0.5 text-[11px] font-medium text-remotiv-text-mid">
                      {step.tag}
                    </span>
                  </div>

                  <h3
                    className={cn(
                      "mt-2 font-heading text-lg font-bold transition-colors duration-300",
                      isActive ? "text-remotiv-purple" : "text-remotiv-text-dark",
                    )}
                  >
                    {step.title}
                  </h3>

                  <div
                    className={cn(
                      "overflow-hidden transition-all duration-500 ease-out",
                      isActive ? "mt-2 max-h-40 opacity-100" : "max-h-0 opacity-0",
                    )}
                  >
                    <p className="text-sm leading-relaxed text-remotiv-text-light">{step.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-14 rounded-2xl border border-remotiv-green/20 bg-remotiv-green/5 px-6 py-5">
          <p className="text-sm leading-relaxed text-remotiv-text-mid">
            <span className="font-semibold text-remotiv-green">Only the top 1%</span> of applicants
            pass all four stages. That means every candidate in your shortlist has been technically
            validated, communication-tested, and culture-screened — before you ever see their
            profile.
          </p>
        </div>

        <div className="mt-10">
          <Link
            href="/book-a-meeting"
            className="inline-flex items-center rounded-full bg-remotiv-green px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-remotiv-green/30 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-remotiv-green/40"
          >
            Get Your Shortlist Now →
          </Link>
        </div>
      </div>
    </section>
  );
}
