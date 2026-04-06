"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

const LINES = ["Build High-Quality Engineering", "Teams, Fast."];
const TYPE_SPEED = 45;
const LINE_PAUSE = 300;

function useTypewriter(lines: string[]) {
  const [lineIndex, setLineIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (done) return;

    const currentLine = lines[lineIndex];

    if (charIndex < currentLine.length) {
      const timer = setTimeout(() => setCharIndex((c) => c + 1), TYPE_SPEED);
      return () => clearTimeout(timer);
    }

    if (lineIndex < lines.length - 1) {
      const timer = setTimeout(() => {
        setLineIndex((l) => l + 1);
        setCharIndex(0);
      }, LINE_PAUSE);
      return () => clearTimeout(timer);
    }

    setDone(true);
  }, [charIndex, lineIndex, lines, done]);

  const displayed = lines.map((line, i) => {
    if (i < lineIndex) return line;
    if (i === lineIndex) return line.slice(0, charIndex);
    return "";
  });

  return { displayed, done };
}

function ArrowRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0" aria-hidden="true">
      <polygon points="0,0 18,9 0,18" fill="#49D7A7" />
    </svg>
  );
}

function ArrowLeft() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      className="shrink-0 rotate-180"
      aria-hidden="true"
    >
      <polygon points="0,0 18,9 0,18" fill="#49D7A7" />
    </svg>
  );
}

const AVATARS = [
  { id: "av1", pos: "top-[10%] left-[9%]", side: "right" as const, delay: "0s" },
  { id: "av2", pos: "top-[10%] right-[9%]", side: "left" as const, delay: "1.2s" },
  { id: "av3", pos: "bottom-[8%] left-[14%]", side: "right" as const, delay: "0.6s" },
  { id: "av4", pos: "bottom-[8%] right-[11%]", side: "left" as const, delay: "1.8s" },
];

function HeadlineSecondLine({ text, done }: { text: string; done: boolean }) {
  const hasFast = text.includes("Fast");
  const prefix = text.replace("Fast.", "");

  return (
    <>
      {prefix}
      {hasFast && (
        <>
          <span className="text-remotiv-green">Fast</span>
          <span className="text-remotiv-text-dark">.</span>
          {done && (
            <span className="ml-1 inline-block size-3 animate-pulse rounded-full bg-remotiv-green align-middle" />
          )}
        </>
      )}
    </>
  );
}

export function Hero() {
  const { displayed, done } = useTypewriter(LINES);

  return (
    <section className="relative flex min-h-[calc(100vh-80px)] flex-col items-center justify-center overflow-hidden bg-remotiv-bg px-6 pb-[140px] pt-[60px]">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,0,0,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.07) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <div
        className="pointer-events-none absolute -top-[10%] left-1/2 h-[600px] w-[900px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(255,255,255,0.55) 0%, transparent 70%)",
        }}
      />

      {AVATARS.map((a) => (
        <div
          key={a.id}
          className={`absolute ${a.pos} hidden items-center gap-2.5 md:flex`}
          style={{ animation: `float-y 4s ease-in-out ${a.delay} infinite` }}
        >
          {a.side === "left" && <ArrowLeft />}
          <div
            className="size-[74px] overflow-hidden rounded-full border-[3px] border-white/90 shadow-[0_8px_28px_rgba(0,0,0,0.15)]"
            style={{ background: "linear-gradient(135deg, #c8d8d0 0%, #a8c0b4 100%)" }}
          >
            <Image
              src="https://placehold.co/600x400"
              alt=""
              width={74}
              height={74}
              className="size-full object-cover object-[center_top]"
              unoptimized
            />
          </div>
          {a.side === "right" && <ArrowRight />}
        </div>
      ))}

      <div className="relative z-10 flex max-w-[800px] flex-col items-center text-center">
        <span className="mb-8 inline-flex items-center gap-2 rounded-full border border-black/[0.09] bg-[rgba(255,255,255,0.65)] px-[18px] py-2 text-[0.85rem] font-medium text-[#444] shadow-[0_2px_12px_rgba(0,0,0,0.06)] backdrop-blur-[12px]">
          ⚡ 24-Hour Expert Engineering Matching
        </span>

        <h1
          className="font-heading font-[800] leading-[1.12] tracking-[-0.03em] text-remotiv-text-dark"
          style={{ fontSize: "clamp(1.9rem, 3.8vw, 3.2rem)" }}
        >
          <span className="block min-h-[1.2em]">{displayed[0]}</span>
          <span className="block min-h-[1.2em]">
            <HeadlineSecondLine text={displayed[1] ?? ""} done={done} />
          </span>
        </h1>

        <p className="mt-6 max-w-[540px] text-[1.05rem] font-normal leading-[1.65] text-[#777]">
          Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams —
          without the usual delays.
        </p>

        <Link
          href="/book-a-meeting"
          className="mt-11 inline-flex items-center gap-3 rounded-xl bg-remotiv-green px-9 py-[17px] text-base font-semibold text-white shadow-[0_8px_32px_rgba(26,92,74,0.28),0_2px_8px_rgba(26,92,74,0.15)] transition-all hover:-translate-y-0.5 hover:bg-remotiv-green-light hover:shadow-[0_12px_40px_rgba(26,92,74,0.35)]"
        >
          Find Your Next Hire
          <span className="text-lg">→</span>
        </Link>
      </div>
    </section>
  );
}
