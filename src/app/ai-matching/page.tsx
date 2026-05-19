"use client";

import { Search, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Navbar } from "@/components/navbar";

const SUGGESTIONS = [
  "Senior React Developer in Lahore",
  "DevOps Engineer with 4+ years AWS experience",
  "UI/UX Designer based in Karachi, available immediately",
  "Full Stack Developer Node.js React 6 years",
  "Data Scientist Python Islamabad mid-level",
];

const STEPS = [
  "Reading your requirements",
  "Scanning 1M+ candidate profiles",
  "Scoring skill & experience match",
  "Ranking top candidates for you",
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Describe Your Role",
    body: "Write in plain English — skills, experience, timezone, budget, culture. No forms, no checkboxes. Just describe what you need.",
  },
  {
    step: "02",
    title: "AI Scans & Ranks",
    body: "Our engine reads 1M+ vetted profiles and scores each candidate against your exact requirements in under 10 seconds.",
  },
  {
    step: "03",
    title: "Unlock & Hire",
    body: "Review ranked matches with AI-generated explanations, unlock contact details, and start interviewing within 24 hours.",
  },
];

const STEP_DURATION_MS = 900;
const TOTAL_ANIMATION_MS = STEPS.length * STEP_DURATION_MS + 200;

function LoadingSteps({ activeStep }: { activeStep: number }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col gap-2">
      {STEPS.map((label, i) => {
        const done = i < activeStep;
        const active = i === activeStep;
        const stateClass = done
          ? "border-[rgba(73,215,167,0.3)] bg-[rgba(73,215,167,0.06)] text-remotiv-green"
          : active
            ? "border-remotiv-green text-[#111]"
            : "border-black/[0.08] text-[#aaa]";
        const checkClass = done
          ? "border-remotiv-green bg-remotiv-green text-[#111]"
          : active
            ? "animate-[aimStepPulse_1s_ease_infinite] border-[#111] bg-[#111] text-white"
            : "border-black/[0.12] bg-remotiv-bg text-inherit";
        return (
          <div
            key={label}
            className={`flex items-center gap-3 rounded-xl border bg-white px-[18px] py-3 font-sans text-[0.78rem] font-semibold transition-all duration-300 ${stateClass}`}
          >
            <div
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.65rem] font-bold transition-all ${checkClass}`}
            >
              {done ? "✓" : i + 1}
            </div>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function AIMatchingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeStep, setActiveStep] = useState(0);

  async function runSearch(raw: string) {
    const q = raw.trim();
    if (!q || loading) return;
    setLoading(true);
    setActiveStep(0);
    for (let i = 1; i <= STEPS.length; i++) {
      await new Promise((r) => setTimeout(r, STEP_DURATION_MS));
      setActiveStep(i);
    }
    await new Promise((r) => setTimeout(r, TOTAL_ANIMATION_MS - STEPS.length * STEP_DURATION_MS));
    router.push(`/ai-results?q=${encodeURIComponent(q)}`);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      runSearch(query);
    }
  }

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <Navbar />

      {loading ? (
        <section className="bg-remotiv-bg px-6 py-16 text-center sm:px-10 sm:py-20">
          <div className="mx-auto mb-7 flex size-[68px] animate-[aimOrbPulse_1.5s_ease-in-out_infinite] items-center justify-center rounded-full bg-remotiv-green text-[1.4rem] font-bold text-[#111]">
            ✦
          </div>
          <h2 className="mb-2 font-heading text-[1.1rem] font-bold text-[#111]">
            Finding Your Best Matches...
          </h2>
          <p className="mb-8 text-[0.82rem] text-[#777]">
            &ldquo;{query.slice(0, 80)}
            {query.length > 80 ? "…" : ""}&rdquo;
          </p>
          <LoadingSteps activeStep={activeStep} />
        </section>
      ) : (
        <>
          <section className="relative px-6 pb-10 pt-[72px] text-center">
            <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-remotiv-purple/[0.18] bg-remotiv-purple/[0.08] px-4 py-1.5 font-sans text-[0.8rem] font-medium text-remotiv-purple">
              <span className="size-1.5 animate-[aimPulse_2s_ease-in-out_infinite] rounded-full bg-remotiv-purple" />
              AI-Powered Talent Matching
            </div>
            <h1 className="mx-auto mb-4 w-full font-heading text-[clamp(2rem,4vw,3rem)] font-bold leading-[1.15] text-[#111]">
              FIND YOUR PERFECT CANDIDATE
              <br />
              IN <em className="not-italic text-remotiv-purple">10 SECONDS</em>
            </h1>
            <p className="mx-auto mb-10 max-w-[520px] font-sans text-[1.05rem] text-[#777]">
              Describe any role. Remotiv AI scans 1M+ profiles and ranks the best matches instantly
              — no forms, no waiting.
            </p>

            <form
              onSubmit={handleSubmit}
              className="mx-auto mb-7 flex max-w-[760px] flex-col items-stretch overflow-hidden rounded-[20px] border-[1.5px] border-black/[0.09] bg-white px-5 pb-0 pt-5 shadow-[0_8px_32px_rgba(0,0,0,0.07)] transition-all focus-within:border-remotiv-purple focus-within:shadow-[0_0_0_4px_rgba(126,71,255,0.1),0_8px_32px_rgba(0,0,0,0.07)]"
            >
              <div className="mb-2.5 flex items-center gap-2">
                <Search className="size-4 shrink-0 text-[#aaa]" strokeWidth={2} />
                <span className="font-sans text-[0.65rem] font-bold uppercase tracking-[0.16em] text-remotiv-green">
                  Describe the role you are hiring for
                </span>
              </div>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={4}
                placeholder="e.g. Senior React developer, 5+ years, AWS knowledge preferred, Lahore based, US timezone comfortable…"
                className="min-h-[100px] w-full resize-y border-none bg-transparent py-2.5 text-left font-sans text-base leading-[1.7] text-[#111] outline-none placeholder:text-[#bbb] sm:text-[0.95rem]"
              />
              <button
                type="submit"
                disabled={!query.trim()}
                className="-mx-5 mt-0 flex items-center justify-center gap-2 border-t border-black/[0.06] bg-remotiv-purple p-[15px] font-heading text-[0.9rem] font-semibold text-white transition-all hover:-translate-y-px hover:bg-[#6a38e0] active:translate-y-0 disabled:cursor-not-allowed disabled:bg-[#bbb] disabled:hover:translate-y-0"
              >
                <Zap className="size-4" strokeWidth={2.2} />✦ &nbsp;Find Best Matches
              </button>
            </form>

            <div className="mx-auto flex max-w-[760px] flex-wrap justify-center gap-2.5">
              <p className="mb-0 w-full text-center font-sans text-[0.9rem] text-[#666]">
                Try a search like:
              </p>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setQuery(s);
                    runSearch(s);
                  }}
                  className="min-h-11 cursor-pointer rounded-full border-[1.5px] border-black/[0.09] bg-white px-[18px] py-[9px] font-sans text-[0.84rem] text-[#555] transition-all hover:border-remotiv-purple hover:bg-remotiv-purple/[0.04] hover:text-remotiv-purple"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section className="border-b border-black/[0.07] bg-remotiv-bg px-6 py-12 sm:px-10 sm:py-14 md:px-14 md:py-16">
            <div className="mx-auto max-w-[1000px]">
              <div className="mb-3 flex items-center gap-2.5 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-remotiv-green">
                <span className="block h-px w-5 bg-remotiv-green" />
                How It Works
              </div>
              <h2 className="mb-10 font-heading text-[clamp(1.8rem,3vw,2.6rem)] font-extrabold tracking-[-0.03em] text-[#111]">
                Three Steps to <span className="text-remotiv-green">Your Next Hire</span>
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {HOW_IT_WORKS.map((item, i) => (
                  <div
                    key={item.step}
                    className="rounded-[20px] border border-black/[0.08] bg-white px-7 py-8"
                  >
                    <div className="mb-4 font-heading text-[3rem] font-extrabold leading-none text-black/[0.06]">
                      {item.step}
                    </div>
                    <div className="mb-3 inline-flex rounded-md border border-remotiv-green/[0.25] bg-remotiv-green/[0.1] px-2.5 py-[3px] text-[0.65rem] font-bold uppercase tracking-[0.1em] text-remotiv-green">
                      Step {i + 1}
                    </div>
                    <div className="mb-2.5 font-heading text-[0.9rem] font-bold text-[#111]">
                      {item.title}
                    </div>
                    <div className="text-[0.85rem] leading-[1.75] text-[#777]">{item.body}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

    </div>
  );
}
