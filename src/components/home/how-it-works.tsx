"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

function ChatCheck() {
  return (
    <svg
      className="size-4 shrink-0"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="9" fill="#9886FE" opacity="0.15" />
      <path
        d="M6 10l3 3 5-5"
        stroke="#9886FE"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActionOverlap() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="8" height="8" rx="2" fill="#F5C842" />
      <rect x="9" y="9" width="8" height="8" rx="2" fill="#F5C842" opacity="0.7" />
    </svg>
  );
}

function ActionChat() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 4h8a2 2 0 012 2v5a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V6a2 2 0 012-2z"
        fill="#9886FE"
        opacity="0.8"
      />
    </svg>
  );
}

function WhiteCheck() {
  return (
    <svg
      className="size-4 shrink-0"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="9" fill="rgba(255,255,255,0.2)" />
      <path
        d="M6 10l3 3 5-5"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HowItWorks() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!sectionRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className="bg-white px-6 py-[72px] font-[var(--font-sans)] sm:px-12"
    >
      {/* Header */}
      <div className="mb-12 text-center">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
          How it works
        </div>
        <h2 className="mx-auto mb-3 font-heading text-[36px] font-black leading-[1.1] tracking-[-0.03em] text-[#111]">
          How Remotiv works
        </h2>
        <p className="mx-auto max-w-[480px] text-[15px] leading-[1.65] text-[#777]">
          From browsing to building — find and hire top remote talent in days, not months.
        </p>
      </div>

      {/* Top Row - Two Cards */}
      <div className="mx-auto mb-5 grid max-w-[1060px] gap-5 md:grid-cols-[45fr_55fr]">
        {/* Step 01 Card */}
        <div
          className={`flex flex-col rounded-[24px] bg-[#F8F4F1] p-8 ${visible ? "animate-[btFadeIn_700ms_ease-out_both]" : "opacity-0"}`}
          style={{ animationDelay: visible ? "0ms" : undefined }}
        >
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
            Step 01
          </div>
          <h3 className="mb-2 font-heading text-[20px] font-black leading-[1.15] tracking-[-0.02em] text-[#111]">
            Tell us your requirements
          </h3>
          <p className="mb-4 text-[13px] leading-[1.65] text-[#666]">
            Share your requirements in 2 minutes. No long forms, no back-and-forth.
          </p>
          <ul className="mb-4 flex flex-col gap-2">
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              Define role, seniority & skills
            </li>
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              Set budget and timezone
            </li>
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              Remote or on-site preferences
            </li>
          </ul>

          {/* Chat UI Mockup */}
          <div className="mt-auto rounded-[16px] bg-white p-3 shadow-sm">
            <div className="mb-2 flex gap-2">
              <div className="flex flex-col items-center gap-1">
                <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#e8e0f8]">
                  {/* biome-ignore lint/performance/noImgElement: tiny 1.9KB local WebP, simpler than next/image here */}
                  <img
                    src="/team-avatars/aisha.webp"
                    alt="Aisha"
                    width={38}
                    height={38}
                    className="h-full w-full rounded-full object-cover"
                  />
                </div>
                <span className="text-[10px] text-[#888]">Aisha</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#d4ede8]">
                  {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
                  <img
                    src="/team-avatars/rayan.webp"
                    alt="Rayan"
                    width={38}
                    height={38}
                    className="h-full w-full rounded-full object-cover"
                  />
                </div>
                <span className="text-[10px] text-[#888]">Rayan</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex size-[38px] items-center justify-center overflow-hidden rounded-full bg-[#f5e0dc]">
                  {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
                  <img
                    src="/team-avatars/sara.webp"
                    alt="Sara"
                    width={38}
                    height={38}
                    className="h-full w-full rounded-full object-cover"
                  />
                </div>
                <span className="text-[10px] text-[#888]">Sara</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div
                className={`flex items-end gap-1.5 ${visible ? "animate-[popIn_500ms_ease-out_both]" : "opacity-0"}`}
                style={{ animationDelay: visible ? "300ms" : undefined }}
              >
                <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Senior React dev, remote, UTC+5.
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:21</span>
              </div>
              <div
                className={`flex items-end gap-1.5 ${visible ? "animate-[popIn_500ms_ease-out_both]" : "opacity-0"}`}
                style={{ animationDelay: visible ? "500ms" : undefined }}
              >
                <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Budget $4k/mo. Start ASAP.
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:22</span>
              </div>
              <div
                className={`flex flex-row-reverse items-end gap-1.5 ${visible ? "animate-[popIn_500ms_ease-out_both]" : "opacity-0"}`}
                style={{ animationDelay: visible ? "700ms" : undefined }}
              >
                <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-[#C9FF85] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Shortlist ready in 24 hrs!
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:23</span>
              </div>
            </div>
          </div>
        </div>

        {/* Step 02 Card */}
        <div
          className={`flex flex-col rounded-[24px] bg-[#F8F4F1] p-8 ${visible ? "animate-[btFadeIn_700ms_ease-out_both]" : "opacity-0"}`}
          style={{ animationDelay: visible ? "100ms" : undefined }}
        >
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#9886FE]">
            Step 02
          </div>
          <h3 className="mb-2 font-heading text-[20px] font-black leading-[1.15] tracking-[-0.02em] text-[#111]">
            Review your top 5 matches
          </h3>
          <p className="mb-4 text-[13px] leading-[1.65] text-[#666]">
            Within 24 hours, our AI and senior recruiters hand-pick the best-fit candidates.
          </p>
          <ul className="mb-4 flex flex-col gap-2">
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              AI scans thousands of profiles instantly
            </li>
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              Human vetting ensures quality
            </li>
            <li className="flex items-center gap-2 text-[13px] text-[#444]">
              <ChatCheck />
              Matched on skills, timezone & culture fit
            </li>
          </ul>

          {/* Candidate Stack */}
          <div className="mt-auto flex flex-col gap-2.5">
            <div className="flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
              <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#d4ede8]">
                {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
                <img
                  src="/team-avatars/hassan-malik.webp"
                  alt="Hassan Malik"
                  width={36}
                  height={36}
                  className="h-full w-full rounded-full object-cover"
                />
              </div>
              <span className="flex-1 text-[13px] font-medium text-[#111]">Hassan Malik</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionOverlap />
                </button>
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionChat />
                </button>
              </div>
            </div>
            <div className="ml-2.5 flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
              <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#e8e0f8]">
                {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
                <img
                  src="/team-avatars/sara-qureshi.webp"
                  alt="Sara Qureshi"
                  width={36}
                  height={36}
                  className="h-full w-full rounded-full object-cover"
                />
              </div>
              <span className="flex-1 text-[13px] font-medium text-[#111]">Sara Qureshi</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionOverlap />
                </button>
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionChat />
                </button>
              </div>
            </div>
            <div className="ml-5 flex items-center gap-3 rounded-[14px] bg-white px-3.5 py-2.5 shadow-sm">
              <div className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[#f5e0dc]">
                {/* biome-ignore lint/performance/noImgElement: tiny local WebP, simpler than next/image here */}
                <img
                  src="/team-avatars/ali-rehman.webp"
                  alt="Ali Rehman"
                  width={36}
                  height={36}
                  className="h-full w-full rounded-full object-cover"
                />
              </div>
              <span className="flex-1 text-[13px] font-medium text-[#111]">Ali Rehman</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionOverlap />
                </button>
                <button
                  type="button"
                  className="flex size-[30px] items-center justify-center rounded-full bg-[#f2ede8] transition-colors hover:bg-[#e8e0d8]"
                >
                  <ActionChat />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Row - Purple Card */}
      <div className="mx-auto max-w-[1060px]">
        <div
          className={`grid items-center gap-12 rounded-[24px] bg-[#9886FE] px-8 py-12 md:grid-cols-2 md:px-14 ${visible ? "animate-[btFadeIn_700ms_ease-out_both]" : "opacity-0"}`}
          style={{ animationDelay: visible ? "200ms" : undefined }}
        >
          <div>
            <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.18em] text-white/60">
              Step 03
            </div>
            <h3 className="mb-3 font-heading text-[26px] font-black leading-[1.15] tracking-[-0.02em] text-white">
              Interview & Ship Code
            </h3>
            <p className="mb-6 text-[14px] leading-[1.7] text-white/80">
              Meet your shortlisted talent, conduct interviews, and hire. We handle all
              international contracts, payroll compliance, and onboarding.
            </p>
            <ul className="mb-6 flex flex-col gap-2">
              <li className="flex items-center gap-2 text-[13px] text-white/90">
                <WhiteCheck />
                We schedule interviews for you
              </li>
              <li className="flex items-center gap-2 text-[13px] text-white/90">
                <WhiteCheck />
                Offer & contract support included
              </li>
              <li className="flex items-center gap-2 text-[13px] text-white/90">
                <WhiteCheck />
                Replacement guarantee for peace of mind
              </li>
            </ul>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 rounded-full bg-[#111] px-7 py-3.5 font-heading text-[14px] font-bold text-white transition-colors hover:bg-[#333]"
            >
              Get started
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M4 10h12M11 5l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </div>

          {/* Video call mockup — translucent decorative graphic */}
          <div
            className="relative hidden items-center justify-center pr-4 md:flex lg:pr-8"
            aria-hidden="true"
          >
            {/* Outer frosted card — the "video call window" */}
            <div className="relative aspect-[4/3] w-[340px] overflow-hidden rounded-2xl border border-white/15 bg-white/10 shadow-2xl backdrop-blur-md lg:w-[400px]">
              {/* Mac-style window controls */}
              <div className="absolute top-3 left-3 flex gap-1.5">
                <span className="size-2.5 rounded-full bg-white/30" />
                <span className="size-2.5 rounded-full bg-white/30" />
                <span className="size-2.5 rounded-full bg-white/30" />
              </div>

              {/* "REC" / live indicator top-right */}
              <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full border border-red-300/30 bg-red-500/30 px-2 py-0.5 animate-[aimStepPulse_2s_ease-in-out_infinite]">
                <span className="size-1.5 animate-pulse rounded-full bg-red-400" />
                <span className="text-[10px] font-medium tracking-wider text-white/90">LIVE</span>
              </div>

              {/* Two participant tiles, side by side */}
              <div className="absolute inset-0 mx-3 mt-9 mb-9 grid grid-cols-2 gap-2">
                {/* Participant 1 — "You" tile (interviewer photo) */}
                <div className="relative flex items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-purple-300/30 to-purple-500/20 ring-2 ring-remotiv-green/60 ring-offset-0 animate-[aimOrbPulse_2s_ease-in-out_infinite]">
                  <Image
                    src="/team-avatars/interviewer.webp"
                    alt=""
                    width={120}
                    height={120}
                    className="size-3/5 rounded-full object-cover opacity-90"
                  />
                  {/* Name pill */}
                  <div className="absolute bottom-1.5 left-1.5 rounded bg-black/30 px-1.5 py-0.5 backdrop-blur-sm">
                    <span className="text-[9px] font-medium text-white/90">You</span>
                  </div>
                  {/* Mic icon */}
                  <div className="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-white/20">
                    <svg viewBox="0 0 24 24" className="size-2.5 text-white/80" fill="currentColor">
                      <path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
                      <path
                        d="M19 11a7 7 0 01-14 0"
                        stroke="currentColor"
                        strokeWidth="2"
                        fill="none"
                      />
                    </svg>
                  </div>
                </div>

                {/* Participant 2 — "Candidate" tile (candidate photo) */}
                <div className="relative flex items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-green-300/30 to-green-500/20">
                  <Image
                    src="/team-avatars/candidate.webp"
                    alt=""
                    width={120}
                    height={120}
                    className="size-3/5 rounded-full object-cover opacity-90"
                  />
                  <div className="absolute bottom-1.5 left-1.5 rounded bg-black/30 px-1.5 py-0.5 backdrop-blur-sm">
                    <span className="text-[9px] font-medium text-white/90">Candidate</span>
                  </div>
                  <div className="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-white/20">
                    <svg viewBox="0 0 24 24" className="size-2.5 text-white/80" fill="currentColor">
                      <path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
                      <path
                        d="M19 11a7 7 0 01-14 0"
                        stroke="currentColor"
                        strokeWidth="2"
                        fill="none"
                      />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Bottom toolbar — call controls */}
              <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-2">
                {/* Mic */}
                <div className="flex size-7 items-center justify-center rounded-full border border-white/10 bg-white/15 backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" className="size-3.5 text-white/80" fill="currentColor">
                    <path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
                    <path
                      d="M19 11a7 7 0 01-14 0"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                    />
                  </svg>
                </div>
                {/* Video */}
                <div className="flex size-7 items-center justify-center rounded-full border border-white/10 bg-white/15 backdrop-blur-sm">
                  <svg
                    viewBox="0 0 24 24"
                    className="size-3.5 text-white/80"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M23 7l-7 5 7 5V7z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" />
                  </svg>
                </div>
                {/* End call (red) */}
                <div className="flex size-7 items-center justify-center rounded-full border border-red-300/30 bg-red-500/60 backdrop-blur-sm">
                  <svg viewBox="0 0 24 24" className="size-3.5 text-white" fill="currentColor">
                    <path d="M21 15.46l-5.27-.61-2.52 2.52a11.01 11.01 0 01-4.92-4.92l2.53-2.53L10.21 4.7H3.03A18.93 18.93 0 0021 17.97v-2.51z" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
