"use client";

import { useEffect, useRef, useState } from "react";

function useInView(threshold = 0.3) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, visible };
}

function useCounter(target: number, duration = 1800, active = false) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!active) return;

    let start: number | null = null;
    let raf: number;

    function step(ts: number) {
      if (start === null) start = ts;
      const elapsed = ts - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(eased * target));
      if (progress < 1) raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active, target, duration]);

  return value;
}

type CircleColor = "purple" | "beige" | "green";

const CIRCLE_STYLES: Record<CircleColor, { bg: string; ring: string; text: string }> = {
  purple: {
    bg: "bg-remotiv-purple-light",
    ring: "border-remotiv-purple-light/30",
    text: "text-white",
  },
  beige: {
    bg: "bg-[#f5f0eb]",
    ring: "border-[#e0d5c9]",
    text: "text-remotiv-text-dark",
  },
  green: {
    bg: "bg-remotiv-green/15",
    ring: "border-remotiv-green/30",
    text: "text-remotiv-text-dark",
  },
};

function StatCircle({
  value,
  label,
  color,
  size = 220,
  animate,
  visible,
}: {
  value: string;
  label: string;
  color: CircleColor;
  size?: number;
  animate?: { target: number; suffix: string };
  visible: boolean;
}) {
  const counter = useCounter(animate?.target ?? 0, 1800, visible && !!animate);
  const c = CIRCLE_STYLES[color];

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <div className={`absolute inset-0 rounded-full border-2 ${c.ring}`} style={{ margin: -12 }} />
      <div
        className={`flex flex-col items-center justify-center rounded-full ${c.bg} ${c.text}`}
        style={{ width: size, height: size }}
      >
        <span className="font-heading text-4xl font-bold leading-none">
          {animate ? `${counter}${animate.suffix}` : value}
        </span>
        <span className="mt-2 max-w-[140px] text-center text-sm font-medium leading-tight opacity-80">
          {label}
        </span>
      </div>
    </div>
  );
}

function AnimatedLine({
  direction,
  color,
  visible,
}: {
  direction: "ltr" | "rtl";
  color: "purple" | "green";
  visible: boolean;
}) {
  const lineColor = color === "purple" ? "#9886fe" : "#49D7A7";

  return (
    <div className="relative flex h-[2px] w-full items-center">
      <div
        className="h-[2px] w-full transition-transform duration-1000 ease-out"
        style={{
          backgroundColor: lineColor,
          transformOrigin: direction === "ltr" ? "left" : "right",
          transform: visible ? "scaleX(1)" : "scaleX(0)",
        }}
      />
      <div
        className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full transition-opacity duration-500"
        style={{
          backgroundColor: lineColor,
          opacity: visible ? 1 : 0,
          transitionDelay: visible ? "800ms" : "0ms",
          ...(direction === "ltr" ? { right: -6 } : { left: -6 }),
        }}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-3 inline-block rounded-full bg-remotiv-green/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-remotiv-green">
      {children}
    </span>
  );
}

function SectionContent({
  label,
  headline,
  accentColor,
  description,
  accentWord,
}: {
  label: string;
  headline: string;
  accentColor: "purple" | "green";
  description: string;
  accentWord: string;
}) {
  const colorClass = accentColor === "purple" ? "text-[#9886fe]" : "text-remotiv-green";

  const parts = headline.split(accentWord);

  return (
    <div className="flex flex-col">
      <SectionLabel>{label}</SectionLabel>
      <h3 className="font-heading text-2xl font-bold leading-tight text-remotiv-text-dark lg:text-3xl">
        {parts[0]}
        <span className={colorClass}>{accentWord}</span>
        {parts[1] ?? ""}
      </h3>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-remotiv-text-light">{description}</p>
    </div>
  );
}

export function StatsCircles() {
  const row1 = useInView(0.3);
  const row2 = useInView(0.3);
  const row3 = useInView(0.3);

  return (
    <section className="bg-white px-6 py-20 md:px-16 lg:px-16 lg:py-20">
      <div className="mx-auto max-w-6xl space-y-20 lg:space-y-24">
        <div ref={row1.ref} className="grid items-center gap-8 md:grid-cols-[1fr_1fr_auto]">
          <SectionContent
            label="AI-Powered Talent"
            headline="The world's most intelligent talent database"
            accentWord="intelligent"
            accentColor="purple"
            description="Our proprietary AI engine indexes and ranks over a million engineering profiles, so you get the best match — not just the best resume."
          />
          <div className="hidden md:block">
            <AnimatedLine direction="ltr" color="purple" visible={row1.visible} />
          </div>
          <div className="flex justify-center md:justify-end">
            <StatCircle value="1M+" label="Talent Profiles" color="purple" visible={row1.visible} />
          </div>
        </div>

        <div ref={row2.ref} className="grid items-center gap-8 md:grid-cols-3">
          <div className="flex justify-center md:justify-start">
            <StatCircle
              value=""
              label="Successful Placements"
              color="beige"
              animate={{ target: 200, suffix: "+" }}
              visible={row2.visible}
            />
          </div>
          <div className="flex justify-center">
            <SectionContent
              label="Track Record"
              headline="Proven results, global reach"
              accentWord="global"
              accentColor="purple"
              description="We've placed top-tier engineers across 30+ countries, building long-lasting partnerships with every hire."
            />
          </div>
          <div className="flex justify-center md:justify-end">
            <StatCircle
              value="85%"
              label="Client Retention Rate"
              color="beige"
              visible={row2.visible}
            />
          </div>
        </div>

        <div ref={row3.ref} className="grid items-center gap-8 md:grid-cols-[auto_1fr_1fr]">
          <div className="flex justify-center md:justify-start">
            <StatCircle
              value="24hrs"
              label="Shortlist Delivery"
              color="green"
              visible={row3.visible}
            />
          </div>
          <div className="hidden md:block">
            <AnimatedLine direction="rtl" color="green" visible={row3.visible} />
          </div>
          <div className="flex justify-center md:justify-end">
            <SectionContent
              label="Speed of Hire"
              headline="Your shortlist, in 24 hours"
              accentWord="24 hours"
              accentColor="green"
              description="From brief to shortlist in a single day. Our AI pre-screens, ranks, and delivers qualified candidates while you focus on building."
            />
          </div>
        </div>
      </div>
    </section>
  );
}
