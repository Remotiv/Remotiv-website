"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    number: "01",
    title: "Instant AI Sourcing",
    tag: "Every applicant scanned instantly",
    body: "Our AI analyzes thousands of data points across 1M+ profiles to find candidates matching your exact tech stack and seniority depth.",
  },
  {
    number: "02",
    title: "Fluent English & Async Communication Audit",
    tag: "Shortlisted candidates only",
    body: "We manually evaluate professional English fluency, async writing quality, and client-facing readiness. Weak communicators never make it to your inbox.",
  },
  {
    number: "03",
    title: "Live Peer-to-Peer Technical Testing",
    tag: "Only strong matches proceed",
    body: "Candidates are grilled by senior practitioners on live coding problems, system architecture, and real-world edge cases.",
  },
  {
    number: "04",
    title: "Culture & Remote Alignment",
    tag: "Final verified candidates only",
    body: "We validate timezone discipline, remote tooling proficiency, and alignment with fast-paced startup environments. Only the top 1% are handed over to you.",
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
    <section ref={sectionRef} className="bg-white px-6 pt-4 pb-12 md:px-[60px] md:pt-0">
      <div className="max-w-[820px]">
        <div className="mb-7 inline-flex items-center gap-2.5">
          <span className="block h-px w-7 bg-[#111]" />
          <span className="font-sans text-[0.62rem] font-bold uppercase tracking-[0.18em] text-[#111]">
            Our Vetting Process
          </span>
        </div>

        <h2 className="mb-5 font-heading text-[2rem] font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[#111] sm:text-[clamp(2.4rem,4.5vw,4.2rem)]">
          How We Deliver The
          <br />
          <em className="not-italic text-remotiv-green">Top 1% of Talent</em>
          <br />
          To Your Next Hire
        </h2>

        <p className="mb-10 max-w-[520px] font-sans text-[0.95rem] font-normal leading-[1.75] text-[#777] md:mb-16">
          Every candidate goes through our AI-powered 4-stage vetting process. You only see
          who&apos;s already passed.
        </p>

        <div className="relative">
          <div className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-[rgba(126,71,255,0.15)]">
            <div
              className="w-full bg-remotiv-purple ease transition-[height] duration-300"
              style={{ height: `${progressPercent}%` }}
            />
          </div>

          <div className="space-y-10 md:space-y-14">
            {STEPS.map((step, i) => {
              const isActive = i === activeIndex;

              return (
                <div
                  key={step.number}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  className="relative pl-12 md:pl-14"
                >
                  <span
                    className={cn(
                      "absolute left-[-5px] top-1.5 size-3 rounded-full border-2 transition-all duration-300",
                      isActive
                        ? "border-remotiv-purple bg-remotiv-purple shadow-[0_0_16px_rgba(126,71,255,0.35)]"
                        : "border-[rgba(126,71,255,0.2)] bg-white",
                    )}
                  />

                  <div
                    className={cn(
                      "font-sans text-[0.58rem] font-bold uppercase tracking-[0.14em] transition-colors duration-300",
                      isActive ? "text-[rgba(126,71,255,0.45)]" : "text-[rgba(0,0,0,0.18)]",
                    )}
                  >
                    {step.number}
                  </div>

                  <h3
                    className={cn(
                      "mt-2 font-heading text-[clamp(1rem,1.8vw,1.15rem)] font-bold uppercase tracking-[0.04em] transition-colors duration-300",
                      isActive ? "text-remotiv-purple" : "text-[rgba(0,0,0,0.18)]",
                    )}
                  >
                    {step.title}
                  </h3>

                  <div
                    className={cn(
                      "mt-2 font-sans text-[0.6rem] font-bold uppercase tracking-[0.12em] text-remotiv-green transition-opacity duration-300",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  >
                    {step.tag}
                  </div>

                  <div
                    className={cn(
                      "overflow-hidden transition-all duration-500 ease-out",
                      isActive ? "mt-3 max-h-[200px] opacity-100" : "max-h-0 opacity-0",
                    )}
                  >
                    <p className="font-sans text-[0.9rem] font-normal leading-[1.8] text-[#555]">
                      {step.body}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-14 mb-10 rounded-xl border border-remotiv-green/20 bg-remotiv-green/[0.04] px-8 py-7">
          <p className="font-sans text-[0.9rem] font-normal leading-[1.8] text-[#555]">
            Only the <strong className="font-bold text-remotiv-green">top 1% of candidates</strong>{" "}
            reach you — AI-matched, human-verified, and ready from day one.
          </p>
        </div>

        <div>
          <Link
            href="/book-a-meeting"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-remotiv-green px-9 py-4 font-heading text-[0.78rem] font-bold uppercase tracking-[0.08em] text-[#111] transition-colors duration-200 hover:bg-[#3bc495] sm:inline-flex sm:w-auto"
          >
            Get Your Shortlist Now →
          </Link>
        </div>
      </div>
    </section>
  );
}
