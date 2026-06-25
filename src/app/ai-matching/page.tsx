"use client";

import { Search, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { Navbar } from "@/components/navbar";

const SUGGESTIONS = [
  "Senior React Developer in Lahore",
  "DevOps Engineer with 4+ years AWS experience",
  "UI/UX Designer based in Karachi, available immediately",
  "Full Stack Developer Node.js React 6 years",
  "Data Scientist Python Islamabad mid-level",
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
    body: "Our engine reads our talent pool and scores each candidate against your exact requirements in seconds.",
  },
  {
    step: "03",
    title: "Unlock & Hire",
    body: "Review ranked matches with AI-generated explanations, unlock contact details, and start interviewing within 24 hours.",
  },
];

const MAX_QUERY_LEN = 500;

export default function AIMatchingPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // F6: Next App Router can restore this client component (with state) when
  // the user hits Back from /ai-results, leaving the submit button stuck on
  // "Searching…". Reset on every mount/restore — runSearch only sets
  // submitting=true immediately before navigating away, so resetting here
  // never interrupts an in-flight search.
  useEffect(() => {
    setSubmitting(false);
  }, []);

  function runSearch(raw: string) {
    const q = raw.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    router.push(`/ai-results?q=${encodeURIComponent(q)}`);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    runSearch(query);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      runSearch(query);
    }
  }

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <Navbar />

      <section id="main" className="relative px-6 pb-10 pt-[72px] text-center">
        <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-remotiv-purple/[0.18] bg-remotiv-purple/[0.08] px-4 py-1.5 font-sans text-[0.8rem] font-medium text-remotiv-purple">
          <span className="size-1.5 motion-safe:animate-[aimPulse_2s_ease-in-out_infinite] rounded-full bg-remotiv-purple" />
          AI Talent Match
        </div>
        <h1 className="mx-auto mb-4 w-full font-heading text-[clamp(2rem,4vw,3rem)] font-bold leading-[1.15] text-[#111]">
          FIND YOUR PERFECT CANDIDATE
          <br />
          IN <em className="not-italic text-remotiv-purple">SECONDS</em>
        </h1>
        <p className="mx-auto mb-10 max-w-[520px] font-sans text-[1.05rem] text-[#777]">
          Describe any role. Remotiv AI scans our talent pool and ranks the best matches —
          no forms, no waiting.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mx-auto mb-7 flex max-w-[760px] flex-col items-stretch overflow-hidden rounded-[20px] border-[1.5px] border-black/[0.09] bg-white px-5 pb-0 pt-5 shadow-[0_8px_32px_rgba(0,0,0,0.07)] motion-safe:transition-all focus-within:border-remotiv-purple focus-within:shadow-[0_0_0_4px_rgba(126,71,255,0.1),0_8px_32px_rgba(0,0,0,0.07)]"
        >
          <div className="mb-2.5 flex items-center gap-2">
            <Search className="size-4 shrink-0 text-[#aaa]" strokeWidth={2} />
            <label
              htmlFor="ai-query"
              className="font-sans text-[0.65rem] font-bold uppercase tracking-[0.16em] text-remotiv-green"
            >
              Describe the role you are hiring for
            </label>
          </div>
          <textarea
            id="ai-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            maxLength={MAX_QUERY_LEN}
            placeholder="e.g. Senior React developer, 5+ years, AWS knowledge preferred, Lahore based, US timezone comfortable…"
            className="min-h-[100px] w-full resize-y border-none bg-transparent py-2.5 text-left font-sans text-base leading-[1.7] text-[#111] outline-none placeholder:text-[#bbb] sm:text-[0.95rem]"
          />
          <div className="mb-2 text-right font-sans text-[0.7rem] text-[#aaa]">
            {query.length}/{MAX_QUERY_LEN}
          </div>
          <button
            type="submit"
            disabled={!query.trim() || submitting}
            className="-mx-5 mt-0 flex items-center justify-center gap-2 border-t border-black/[0.06] bg-remotiv-purple p-[15px] font-heading text-[0.9rem] font-semibold text-white motion-safe:transition-all motion-safe:hover:-translate-y-px hover:bg-[#6a38e0] motion-safe:active:translate-y-0 disabled:cursor-not-allowed disabled:bg-[#bbb] disabled:hover:translate-y-0"
          >
            <Zap className="size-4" strokeWidth={2.2} />
            {submitting ? "Searching…" : <>✦ &nbsp;Find Best Matches</>}
          </button>
        </form>

        <div className="mx-auto flex max-w-[760px] flex-wrap justify-center gap-2.5">
          <p className="mb-0 w-full text-center font-sans text-[0.9rem] text-[#666]">
            Try searching for:
          </p>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuery(s);
                runSearch(s);
              }}
              className="min-h-11 cursor-pointer rounded-full border-[1.5px] border-black/[0.09] bg-white px-[18px] py-[9px] font-sans text-[0.84rem] text-[#555] motion-safe:transition-all hover:border-remotiv-purple hover:bg-remotiv-purple/[0.04] hover:text-remotiv-purple"
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
          <ol className="grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
            {HOW_IT_WORKS.map((item, i) => (
              <li
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
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
