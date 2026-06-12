"use client";

import { useEffect, useRef, useState } from "react";
import { MARKETING_STATS } from "@/lib/marketing-stats";

// Split helpers so the visual StatCircle (leading + suffix split for animation)
// stays sourced from MARKETING_STATS — touching the constant propagates here.
const POOL_LEADING = MARKETING_STATS.talentPool.replace(/\+$/, "");
const RETENTION_LEADING = MARKETING_STATS.clientRetention.replace(/%$/, "");
const SHORTLIST_LEADING = MARKETING_STATS.shortlistTime.split(" ")[0];
const PLACEMENTS_TARGET = Number.parseInt(MARKETING_STATS.placements, 10);

function useInView(threshold = 0.3) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
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
    if (!active) {
      setValue(0);
      return;
    }

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

const CIRCLE_STYLES: Record<CircleColor, { bg: string; ringBorder: string }> = {
  purple: {
    bg: "bg-remotiv-purple",
    ringBorder: "border-remotiv-purple/25",
  },
  beige: {
    bg: "bg-[#EEEEE8]",
    ringBorder: "border-black/[0.08]",
  },
  green: {
    bg: "bg-remotiv-green",
    ringBorder: "border-remotiv-green/35",
  },
};

type CircleNumberSpec = {
  leading: string;
  suffix: string;
  numberSize: string;
  numberColor: string;
  suffixEm: string;
  suffixColor: string;
  suffixOpacity?: number;
};

function StatCircle({
  label,
  labelColor,
  color,
  size = 220,
  spec,
  animate,
  visible,
}: {
  label: React.ReactNode;
  labelColor: string;
  color: CircleColor;
  size?: number;
  spec: Omit<CircleNumberSpec, "leading"> & { leading?: string };
  animate?: { target: number };
  visible: boolean;
}) {
  const counter = useCounter(animate?.target ?? 0, 1800, visible && !!animate);
  const c = CIRCLE_STYLES[color];

  const leadingText = animate ? String(counter) : (spec.leading ?? "");

  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <div
        className={`absolute inset-0 rounded-full border ${c.ringBorder}`}
        style={{ margin: -12 }}
      />
      <div
        className={`flex flex-col items-center justify-center rounded-full p-7 text-center ${c.bg}`}
        style={{ width: size, height: size }}
      >
        <div
          className="font-heading font-black leading-none tracking-[-0.04em]"
          style={{ fontSize: spec.numberSize, color: spec.numberColor }}
        >
          {leadingText}
          <span
            className="font-black"
            style={{
              fontSize: spec.suffixEm,
              color: spec.suffixColor,
              opacity: spec.suffixOpacity,
            }}
          >
            {spec.suffix}
          </span>
        </div>
        <div
          className="mt-1 font-sans text-[0.72rem] font-semibold leading-[1.4]"
          style={{ color: labelColor }}
        >
          {label}
        </div>
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
  const lineColor =
    color === "purple" ? "var(--color-remotiv-purple)" : "var(--color-remotiv-green)";

  return (
    <div className="relative flex h-px w-full items-center">
      <div
        className="h-px w-full transition-transform ease-[cubic-bezier(0.4,0,0.2,1)] duration-[1300ms]"
        style={{
          backgroundColor: lineColor,
          transformOrigin: direction === "ltr" ? "left" : "right",
          transform: visible ? "scaleX(1)" : "scaleX(0)",
        }}
      />
      <div
        className="absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-opacity ease-[cubic-bezier(0.4,0,0.2,1)] duration-[1300ms]"
        style={{
          backgroundColor: lineColor,
          opacity: visible ? 1 : 0,
          ...(direction === "ltr" ? { right: -5 } : { left: -5 }),
        }}
      />
    </div>
  );
}

function Eyebrow({ label, color }: { label: string; color: string }) {
  return (
    <div className="mb-4 inline-flex items-center gap-2.5">
      <span className="block h-px w-[22px]" style={{ backgroundColor: color }} />
      <span
        className="font-sans text-[0.65rem] font-bold uppercase tracking-[0.2em] sm:text-[0.58rem]"
        style={{ color }}
      >
        {label}
      </span>
    </div>
  );
}

function SectionContent({
  label,
  eyebrowColor,
  headline,
  accentWord,
  accentColor,
  description,
  align = "left",
}: {
  label: string;
  eyebrowColor: string;
  headline: string;
  accentWord: string;
  accentColor: "purple" | "green";
  description: string;
  align?: "left" | "center";
}) {
  const accentClass = accentColor === "purple" ? "text-remotiv-purple" : "text-remotiv-green";
  const parts = headline.split(accentWord);
  const isCenter = align === "center";

  return (
    <div className={`flex flex-col ${isCenter ? "items-center text-center" : "items-start"}`}>
      <Eyebrow label={label} color={eyebrowColor} />
      <h3 className="font-heading text-[clamp(1.4rem,2.2vw,1.9rem)] font-extrabold leading-tight tracking-tight text-[#111]">
        {parts[0]}
        <em className={`not-italic ${accentClass}`}>{accentWord}</em>
        {parts[1] ?? ""}
      </h3>
      <p
        className={`mt-3.5 font-sans text-[0.86rem] font-normal leading-[1.75] text-[#777] ${
          isCenter ? "max-w-[300px]" : "max-w-md"
        }`}
      >
        {description}
      </p>
    </div>
  );
}

function Row1() {
  const { ref, visible } = useInView(0.3);
  return (
    <div ref={ref} className="grid items-center gap-10 lg:grid-cols-[1fr_1fr_220px] lg:gap-8">
      <SectionContent
        label="AI-Powered Talent"
        eyebrowColor="#111"
        headline="The world's most intelligent talent database"
        accentWord="intelligent"
        accentColor="purple"
        description="Our AI scans over 1 million profiles in seconds — matching on skills, experience depth, seniority, and role-fit signals. Only the right candidates make it through."
      />
      <div className="hidden px-6 lg:block">
        <AnimatedLine direction="ltr" color="purple" visible={visible} />
      </div>
      <div className="flex justify-center lg:justify-end">
        <StatCircle
          color="purple"
          spec={{
            leading: POOL_LEADING,
            suffix: "+",
            numberSize: "2.8rem",
            numberColor: "#fff",
            suffixEm: "0.42em",
            suffixColor: "rgba(255,255,255,0.7)",
          }}
          label="Talent Profiles"
          labelColor="rgba(255,255,255,0.85)"
          visible={visible}
        />
      </div>
    </div>
  );
}

function Row2() {
  const { ref, visible } = useInView(0.3);
  return (
    <div
      ref={ref}
      className="grid items-center gap-10 lg:grid-cols-[220px_1fr_220px] lg:gap-12"
    >
      <div className="order-2 flex justify-center lg:justify-start lg:order-none">
        <StatCircle
          color="beige"
          spec={{
            suffix: "+",
            numberSize: "2.8rem",
            numberColor: "#111",
            suffixEm: "0.36em",
            suffixColor: "#AAA",
          }}
          label={
            <>
              Successful
              <br />
              Placements
            </>
          }
          labelColor="#555"
          animate={{ target: PLACEMENTS_TARGET }}
          visible={visible}
        />
      </div>
      <div className="order-1 lg:order-none">
        <SectionContent
          label="Track Record"
          eyebrowColor="var(--color-remotiv-purple)"
          headline="Proven results, global reach"
          accentWord="global reach"
          accentColor="purple"
          description="Over 200+ professionals placed with US, UK, and global companies — from early-stage startups to established enterprises. Every placement backed by our 90-day guarantee."
          align="center"
        />
      </div>
      <div className="order-3 flex justify-center lg:justify-end lg:order-none">
        <StatCircle
          color="beige"
          spec={{
            leading: RETENTION_LEADING,
            suffix: "%",
            numberSize: "2.8rem",
            numberColor: "#111",
            suffixEm: "0.42em",
            suffixColor: "#AAA",
          }}
          label={
            <>
              Client Retention
              <br />
              Rate
            </>
          }
          labelColor="#555"
          visible={visible}
        />
      </div>
    </div>
  );
}

function Row3() {
  const { ref, visible } = useInView(0.3);
  return (
    <div ref={ref} className="grid items-center gap-10 lg:grid-cols-[220px_1fr_1fr] lg:gap-8">
      <div className="flex justify-center lg:justify-start">
        <StatCircle
          color="green"
          spec={{
            leading: SHORTLIST_LEADING,
            suffix: "hrs",
            numberSize: "2.3rem",
            numberColor: "#0A3D2A",
            suffixEm: "0.4em",
            suffixColor: "#0A3D2A",
          }}
          label={
            <>
              Shortlist
              <br />
              Delivery
            </>
          }
          labelColor="#0A3D2A"
          visible={visible}
        />
      </div>
      <div className="hidden px-6 lg:block">
        <AnimatedLine direction="rtl" color="green" visible={visible} />
      </div>
      <div className="flex justify-center lg:justify-end">
        <SectionContent
          label="Speed of Hire"
          eyebrowColor="var(--color-remotiv-green)"
          headline="Your shortlist, in 24 hours"
          accentWord="24 hours"
          accentColor="green"
          description="Share your brief today. By tomorrow, a curated shortlist of pre-vetted, AI-matched candidates is in your inbox — ready to interview, ready to hire."
        />
      </div>
    </div>
  );
}

export function StatsCircles() {
  return (
    <section className="bg-white px-6 py-12 md:py-[72px] lg:px-16">
      <div className="mx-auto space-y-20">
        <Row1 />
        <Row2 />
        <Row3 />
      </div>
    </section>
  );
}
