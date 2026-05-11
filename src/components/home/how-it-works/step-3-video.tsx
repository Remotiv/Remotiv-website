import Image from "next/image";
import Link from "next/link";
import { WhiteCheck } from "@/components/icons";

export function Step3Video() {
  return (
    <div className="mx-auto max-w-[1060px]">
      <div className="grid items-center gap-12 rounded-[24px] bg-[#9886FE] px-8 py-12 lg:grid-cols-2 lg:px-14">
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
          className="relative hidden items-center justify-center pr-4 lg:flex lg:pr-8"
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
  );
}
