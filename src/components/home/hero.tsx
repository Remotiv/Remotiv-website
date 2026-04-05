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

const AVATARS = [
  { id: "tl", pos: "top-[12%] left-[8%]", arrow: "rotate-[135deg]", delay: "0s" },
  { id: "tr", pos: "top-[12%] right-[8%]", arrow: "rotate-[225deg]", delay: "0.5s" },
  { id: "bl", pos: "bottom-[18%] left-[10%]", arrow: "rotate-[45deg]", delay: "1s" },
  { id: "br", pos: "bottom-[18%] right-[10%]", arrow: "rotate-[-45deg]", delay: "1.5s" },
];

function HeadlineSecondLine({ text, done }: { text: string; done: boolean }) {
  const hasFast = text.includes("Fast");
  const prefix = text.replace("Fast.", "");

  return (
    <>
      {prefix}
      {hasFast && (
        <>
          <span className="text-remotiv-green">Fast.</span>
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
    <section className="relative flex min-h-[calc(100vh-80px)] items-center justify-center overflow-hidden bg-remotiv-bg">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,0,0,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.07) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />

      <div className="pointer-events-none absolute -top-24 left-1/2 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-remotiv-green/20 blur-[120px]" />

      {AVATARS.map((a) => (
        <div
          key={a.id}
          className={`absolute ${a.pos} hidden items-center gap-2 md:flex`}
          style={{ animation: `float-y 4s ease-in-out ${a.delay} infinite` }}
        >
          <Image
            src="https://placehold.co/80x80"
            alt=""
            width={56}
            height={56}
            className="rounded-full border-2 border-white shadow-md"
            unoptimized
          />
          <span className={`text-remotiv-green ${a.arrow}`} style={{ fontSize: 20 }}>
            ➜
          </span>
        </div>
      ))}

      <div className="relative z-10 flex max-w-2xl flex-col items-center px-6 text-center">
        <span className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-5 py-2 text-sm font-medium text-remotiv-text-mid shadow-sm backdrop-blur-md">
          ⚡ 24-Hour Expert Engineering Matching
        </span>

        <h1 className="font-heading text-4xl font-extrabold leading-tight tracking-tight text-remotiv-text-dark sm:text-5xl lg:text-6xl">
          <span className="block min-h-[1.2em]">{displayed[0]}</span>
          <span className="block min-h-[1.2em]">
            <HeadlineSecondLine text={displayed[1] ?? ""} done={done} />
          </span>
        </h1>

        <p className="mt-6 max-w-lg text-lg leading-relaxed text-remotiv-text-mid">
          Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams —
          without the usual delays.
        </p>

        <Link
          href="/book-a-meeting"
          className="mt-10 inline-flex items-center rounded-full bg-remotiv-green px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-remotiv-green/30 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-remotiv-green/40"
        >
          Find Your Next Hire →
        </Link>
      </div>
    </section>
  );
}
