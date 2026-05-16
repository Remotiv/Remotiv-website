"use client";

import { ArrowLeft, Bookmark, MapPin } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Navbar } from "@/components/navbar";
import { ROLE_CONFIG, type Talent, TALENT_POOL } from "@/lib/talent-pool";

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function LinkedinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function ContactLink({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-[0.72rem] font-medium text-[#555] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple"
    >
      {icon}
      {label}
    </button>
  );
}

function scoreStars(score: number): string {
  const filled = score >= 95 ? 5 : score >= 88 ? 4 : score >= 75 ? 3 : score >= 60 ? 2 : 1;
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

function rankTalent(query: string): Talent[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return [...TALENT_POOL].sort((a, b) => b.score - a.score);
  return TALENT_POOL.map((t) => {
    const haystack = [
      t.role,
      t.skills.join(" "),
      t.exp,
      t.location,
      t.bio,
      t.highlights.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    const matches = tokens.reduce((acc, tok) => acc + (haystack.includes(tok) ? 1 : 0), 0);
    return { talent: t, matches };
  })
    .filter((x) => x.matches > 0)
    .sort((a, b) => b.matches - a.matches || b.talent.score - a.talent.score)
    .map((x) => x.talent);
}

function ScoreBadge({ score }: { score: number }) {
  return (
    <div className="flex min-w-[100px] flex-col items-center rounded-[14px] border border-remotiv-green/[0.25] bg-remotiv-green/[0.08] px-[18px] py-3.5">
      <div className="font-heading text-[2rem] font-extrabold leading-none text-remotiv-green">
        {score}%
      </div>
      <div className="mt-1 text-[0.6rem] font-bold uppercase tracking-[0.1em] text-[#777]">
        AI Match
      </div>
      <div className="mt-0.5 text-[0.7rem] tracking-[2px] text-remotiv-green">
        {scoreStars(score)}
      </div>
    </div>
  );
}

function TalentCard({
  talent,
  index,
  saved,
  onToggleSave,
}: {
  talent: Talent;
  index: number;
  saved: boolean;
  onToggleSave: (id: number) => void;
}) {
  const cfg = ROLE_CONFIG[talent.type];
  return (
    <article
      className="grid grid-cols-1 gap-6 rounded-[20px] border border-black/[0.07] bg-white p-6 transition-all hover:-translate-y-px hover:shadow-[0_12px_40px_rgba(0,0,0,0.08)] md:grid-cols-[1fr_auto]"
      style={{ animation: `btFadeIn .35s ease ${index * 0.04}s both` }}
    >
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <span className="font-heading text-[1.05rem] font-bold text-[#111]">{talent.name}</span>
          <span
            className="rounded-md border px-2 py-[3px] text-[0.65rem] font-bold uppercase tracking-[0.08em]"
            style={{ color: cfg.color, borderColor: cfg.border, background: cfg.background }}
          >
            {cfg.label}
          </span>
          <span
            className={`text-[0.72rem] font-semibold ${
              talent.available ? "text-remotiv-green" : "text-[#bbb]"
            }`}
          >
            {talent.available ? "● Available" : "○ Unavailable"}
          </span>
          <span className="ml-auto font-sans text-[0.7rem] text-[#ccc]">{talent.lastActive}</span>
        </div>

        <div className="mb-2.5 flex flex-wrap items-center gap-1 font-sans text-[0.85rem] text-[#555]">
          <span>{talent.role}</span>
          <span>·</span>
          <MapPin className="size-3" />
          <span>{talent.location}</span>
          <span>·</span>
          <span>{talent.exp} exp</span>
        </div>

        {talent.why && (
          <div className="mb-2.5 flex items-start gap-2 rounded-[10px] border border-remotiv-green/[0.2] bg-remotiv-green/[0.07] px-3.5 py-2.5 font-sans text-[0.8rem] leading-[1.6] text-[#1d8c6b]">
            <span className="shrink-0 font-bold text-remotiv-green">✦</span>
            {talent.why}
          </div>
        )}

        <p className="mb-3 font-sans text-[0.82rem] leading-[1.65] text-[#777]">{talent.bio}</p>

        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {talent.skills.map((s) => (
            <span
              key={s}
              className="rounded-md border border-black/[0.07] bg-black/[0.03] px-2 py-[3px] text-[0.7rem] font-medium text-[#555]"
            >
              {s}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {talent.highlights.map((h) => (
            <span
              key={h}
              className="rounded-md border border-remotiv-purple/[0.2] bg-remotiv-purple/[0.06] px-2 py-[3px] text-[0.7rem] font-medium text-remotiv-purple"
            >
              ✦ {h}
            </span>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {talent.github && <ContactLink label="GitHub" icon={<GithubIcon />} />}
          <ContactLink label="LinkedIn" icon={<LinkedinIcon />} />
          <ContactLink label="Resume ✦" />
        </div>
      </div>

      <div className="flex flex-row items-start gap-2 md:flex-col md:items-stretch">
        <ScoreBadge score={talent.score} />
        <button
          type="button"
          className="rounded-xl bg-remotiv-purple px-5 py-2.5 font-heading text-[0.8rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
        >
          View Profile
        </button>
        <button
          type="button"
          onClick={() => onToggleSave(talent.id)}
          className={`flex items-center justify-center gap-1.5 rounded-xl border px-5 py-2.5 text-[0.8rem] font-semibold transition-colors ${
            saved
              ? "border-remotiv-purple bg-remotiv-purple/[0.08] text-remotiv-purple"
              : "border-black/[0.1] bg-white text-[#555] hover:border-remotiv-purple hover:text-remotiv-purple"
          }`}
        >
          <Bookmark className={`size-3.5 ${saved ? "fill-current" : ""}`} />
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">🔍</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">No matches found</h3>
      <p className="mb-7 font-sans text-[#777]">
        We couldn&apos;t find profiles matching your exact criteria.
        <br />
        Try broadening your search or register as a talent.
      </p>
      <Link
        href="/ai-matching"
        className="inline-flex items-center gap-2 rounded-[14px] bg-remotiv-purple px-7 py-3 font-heading text-[0.9rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
      >
        <ArrowLeft className="size-4" /> Try Another Search
      </Link>
    </div>
  );
}

function ResultsContent() {
  const params = useSearchParams();
  const query = params.get("q") ?? "";
  const [shortlist, setShortlist] = useState<Set<number>>(new Set());
  const [showOnlySaved, setShowOnlySaved] = useState(false);

  const ranked = useMemo(() => rankTalent(query), [query]);
  const visible = showOnlySaved ? ranked.filter((t) => shortlist.has(t.id)) : ranked;

  function toggleSave(id: number) {
    setShortlist((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] bg-white px-14 py-5">
        <div>
          <div className="font-heading text-[1rem] font-bold text-[#111]">
            Showing <span className="text-remotiv-purple">{visible.length}</span> matched profiles
          </div>
          {query && (
            <div className="mt-0.5 text-[0.78rem] text-[#777]">
              Results for: <strong>&ldquo;{query.slice(0, 60)}{query.length > 60 ? "…" : ""}&rdquo;</strong>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOnlySaved((v) => !v)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] px-4 py-1.5 font-sans text-[0.82rem] font-medium transition-colors ${
              showOnlySaved
                ? "border-remotiv-purple bg-remotiv-purple/[0.08] text-remotiv-purple"
                : "border-black/[0.1] bg-transparent text-[#444] hover:border-remotiv-purple hover:text-remotiv-purple"
            }`}
          >
            <Bookmark className={`size-3.5 ${showOnlySaved ? "fill-current" : ""}`} />
            Shortlist ({shortlist.size})
          </button>
          <Link
            href="/ai-matching"
            className="flex items-center gap-1.5 rounded-full bg-remotiv-purple px-[18px] py-2 font-sans text-[0.82rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            <ArrowLeft className="size-3.5" /> New Search
          </Link>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mx-auto flex max-w-[900px] flex-col gap-2.5 px-6 pb-20 pt-6">
          {visible.map((t, i) => (
            <TalentCard
              key={t.id}
              talent={t}
              index={i}
              saved={shortlist.has(t.id)}
              onToggleSave={toggleSave}
            />
          ))}
        </div>
      )}
    </>
  );
}

export default function AIResultsPage() {
  return (
    <div className="min-h-screen bg-remotiv-bg">
      <Navbar />
      <Suspense
        fallback={
          <div className="px-14 py-12 text-center font-sans text-[#777]">Loading results…</div>
        }
      >
        <ResultsContent />
      </Suspense>
    </div>
  );
}
