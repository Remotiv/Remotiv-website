"use client";

// Consolidated Avatar component - replaces 6 near-identical components
type AvatarVariant = "aisha" | "rayan" | "sara" | "teal" | "purple" | "peach";

const AVATAR_CONFIG: Record<AvatarVariant, { skinTone: string; hairColor: string; size: number }> =
  {
    aisha: { skinTone: "#e8c8d0", hairColor: "#2a2a2a", size: 28 },
    rayan: { skinTone: "#d4b896", hairColor: "#1a1a1a", size: 28 },
    sara: { skinTone: "#f0c8a0", hairColor: "#1a1a1a", size: 28 },
    teal: { skinTone: "#d4b896", hairColor: "#1a1a1a", size: 22 },
    purple: { skinTone: "#e8c8d0", hairColor: "#2a2a2a", size: 22 },
    peach: { skinTone: "#f0c8a0", hairColor: "#1a1a1a", size: 22 },
  };

function Avatar({ variant, customSize }: { variant: AvatarVariant; customSize?: number }) {
  const config = AVATAR_CONFIG[variant];
  const size = customSize ?? config.size;
  const { skinTone, hairColor } = config;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="20" cy="13" rx="5.5" ry="6" fill={skinTone} />
      <path d="M13 10 Q14 4 20 4 Q27 4 27 10" fill={hairColor} />
      <circle cx="17" cy="13" r="1" fill={hairColor} />
      <circle cx="23" cy="13" r="1" fill={hairColor} />
      <path d="M12 22 Q20 38 28 22 Q28 34 20 35 Q12 34 12 22Z" fill={hairColor} />
    </svg>
  );
}

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
  return (
    <section className="bg-white px-6 py-[72px] font-[var(--font-sans)] sm:px-12">
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
        <div className="flex flex-col rounded-[24px] bg-[#F8F4F1] p-8">
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
                <div className="flex size-[38px] items-center justify-center rounded-full bg-[#e8e0f8]">
                  <Avatar variant="aisha" />
                </div>
                <span className="text-[10px] text-[#888]">Aisha</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex size-[38px] items-center justify-center rounded-full bg-[#d4ede8]">
                  <Avatar variant="rayan" />
                </div>
                <span className="text-[10px] text-[#888]">Rayan</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <div className="flex size-[38px] items-center justify-center rounded-full bg-[#f5e0dc]">
                  <Avatar variant="sara" />
                </div>
                <span className="text-[10px] text-[#888]">Sara</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-end gap-1.5">
                <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Senior React dev, remote, UTC+5.
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:21</span>
              </div>
              <div className="flex items-end gap-1.5">
                <div className="max-w-[85%] rounded-[14px] rounded-bl-[4px] bg-[#F9DE6F] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Budget $4k/mo. Start ASAP.
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:22</span>
              </div>
              <div className="flex flex-row-reverse items-end gap-1.5">
                <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-[#C9FF85] px-3 py-2 text-[12px] leading-[1.5] text-[#333]">
                  Shortlist ready in 24 hrs!
                </div>
                <span className="mb-0.5 text-[10px] text-[#aaa]">10:23</span>
              </div>
            </div>
          </div>
        </div>

        {/* Step 02 Card */}
        <div className="flex flex-col rounded-[24px] bg-[#F8F4F1] p-8">
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
              <div className="flex size-9 items-center justify-center rounded-full bg-[#d4ede8]">
                <Avatar variant="teal" />
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
              <div className="flex size-9 items-center justify-center rounded-full bg-[#e8e0f8]">
                <Avatar variant="purple" />
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
              <div className="flex size-9 items-center justify-center rounded-full bg-[#f5e0dc]">
                <Avatar variant="peach" />
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
        <div className="grid items-center gap-12 rounded-[24px] bg-[#9886FE] px-8 py-12 md:grid-cols-2 md:px-14">
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
            <a
              href="#contact"
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
            </a>
          </div>

          {/* Calendar Illustration */}
          <div className="flex items-center justify-center">
            <svg
              width="220"
              height="180"
              viewBox="0 0 220 180"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="20" y="20" width="110" height="90" rx="12" fill="rgba(255,255,255,0.15)" />
              <rect x="20" y="20" width="110" height="28" rx="12" fill="rgba(255,255,255,0.2)" />
              <rect x="20" y="36" width="110" height="12" fill="rgba(255,255,255,0.2)" />
              <text
                x="75"
                y="39"
                textAnchor="middle"
                fontSize="10"
                fill="rgba(255,255,255,0.9)"
                fontWeight="700"
              >
                Interview scheduled
              </text>
              <circle cx="40" cy="70" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="57" cy="70" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="74" cy="70" r="3" fill="#C9FF85" />
              <circle cx="91" cy="70" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="108" cy="70" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="40" cy="88" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="57" cy="88" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="74" cy="88" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="91" cy="88" r="3" fill="rgba(255,255,255,0.4)" />
              <circle cx="108" cy="88" r="3" fill="rgba(255,255,255,0.4)" />
              <rect x="90" y="90" width="110" height="72" rx="12" fill="rgba(255,255,255,0.18)" />
              <rect x="102" y="103" width="60" height="7" rx="3.5" fill="rgba(255,255,255,0.5)" />
              <rect x="102" y="116" width="44" height="6" rx="3" fill="rgba(255,255,255,0.3)" />
              <circle cx="185" cy="96" r="14" fill="#C9FF85" />
              <path
                d="M179 96l4 4 7-7"
                stroke="#111"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <text x="145" y="152" textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.7)">
                Offer accepted
              </text>
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
