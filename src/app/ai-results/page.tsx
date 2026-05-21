"use client";

import { ArrowLeft, Bookmark, Lock, MapPin } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Navbar } from "@/components/navbar";
import { ROLE_CONFIG, type TalentType } from "@/lib/talent-pool";

// ── API contract ─────────────────────────────────────────────

type CandidateProfile = {
  id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  role_category: string | null;
  skills: string[];
  city: string | null;
  country: string | null;
  years_experience: number | null;
  summary: string | null;
  availability: string | null;
  work_type: string | null;
  github_url: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  status: string;
  salary_min: number | null;
  salary_max: number | null;
};

type EnrichedMatch = {
  candidate_id: string;
  match_percent: number;
  why: string;
  profile: CandidateProfile;
};

type ApiTier = "anonymous" | "free" | "subscriber";

type ApiSuccess = {
  results: EnrichedMatch[];
  tier: ApiTier;
  cached: boolean;
  used: number;
  limit: number;
};

type ApiRateLimit = {
  error: "rate_limit";
  used: number;
  limit: number;
  tier: ApiTier;
};

// ── Helpers ──────────────────────────────────────────────────

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

function LockedContactLink({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled
      title="Sign up to unlock contact details"
      className="flex cursor-not-allowed items-center gap-1.5 rounded-full border border-black/[0.08] bg-black/[0.02] px-3 py-1.5 text-[0.72rem] font-medium text-[#aaa]"
    >
      <Lock className="size-3" strokeWidth={2} />
      {icon}
      {label}
    </button>
  );
}

function scoreStars(score: number): string {
  const filled = score >= 95 ? 5 : score >= 88 ? 4 : score >= 75 ? 3 : score >= 60 ? 2 : 1;
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

function deriveType(roleCategory: string | null): TalentType {
  const r = (roleCategory ?? "").toLowerCase();
  if (/engineer|developer|software|devops|backend|frontend|fullstack|full[- ]?stack/.test(r)) return "Eng";
  if (/design|ui|ux/.test(r)) return "Design";
  if (/data|analyst|scientist|ml|machine learning/.test(r)) return "Data";
  if (/product|manager|^pm$|owner/.test(r)) return "PM";
  if (/ops|operations|support|customer|success/.test(r)) return "Ops";
  return "Eng";
}

function initialsOf(first: string, last: string | null): string {
  const a = first?.[0] ?? "";
  const b = last?.[0] ?? "";
  return `${a}${b}`.toUpperCase() || "??";
}

function isAvailableNow(availability: string | null): boolean {
  if (!availability) return false;
  return availability.toLowerCase().includes("available");
}

// ── Loading steps animation ─────────────────────────────────

const STEPS = [
  "Reading your requirements",
  "Scanning thousands of profiles",
  "Scoring with AI",
  "Ranking your matches",
];
const STEP_DURATION_MS = 900;

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

function LoadingPanel({ query }: { query: string }) {
  const [activeStep, setActiveStep] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      i = Math.min(i + 1, STEPS.length - 1);
      setActiveStep(i);
      if (i < STEPS.length - 1) {
        setTimeout(tick, STEP_DURATION_MS);
      }
    };
    const t = setTimeout(tick, STEP_DURATION_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  return (
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
  );
}

// ── Card components ─────────────────────────────────────────

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
  match,
  index,
  saved,
  onToggleSave,
}: {
  match: EnrichedMatch;
  index: number;
  saved: boolean;
  onToggleSave: (id: string) => void;
}) {
  const p = match.profile;
  const type = deriveType(p.role_category);
  const cfg = ROLE_CONFIG[type];
  const name = `${p.first_name}${p.last_name ? ` ${p.last_name}` : ""}`.trim() || "Talent";
  const role = p.job_title || p.role_category || "Talent";
  const location = [p.city, p.country].filter(Boolean).join(", ") || "Remote";
  const exp =
    p.years_experience != null ? `${p.years_experience} years` : "Experience not specified";
  const available = isAvailableNow(p.availability);
  const bio = (p.summary ?? "").trim();
  const why = (match.why ?? "").trim();

  return (
    <article
      className="grid grid-cols-1 gap-6 rounded-[20px] border border-black/[0.07] bg-white p-6 transition-all hover:-translate-y-px hover:shadow-[0_12px_40px_rgba(0,0,0,0.08)] md:grid-cols-[1fr_auto]"
      style={{ animation: `btFadeIn .35s ease ${index * 0.04}s both` }}
    >
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <span className="font-heading text-[1.05rem] font-bold text-[#111]">{name}</span>
          <span
            className="rounded-md border px-2 py-[3px] text-[0.65rem] font-bold uppercase tracking-[0.08em]"
            style={{ color: cfg.color, borderColor: cfg.border, background: cfg.background }}
          >
            {cfg.label}
          </span>
          {p.availability && (
            <span
              className={`text-[0.72rem] font-semibold ${
                available ? "text-remotiv-green" : "text-[#bbb]"
              }`}
            >
              {available ? "● Available" : "○ Unavailable"}
            </span>
          )}
        </div>

        <div className="mb-2.5 flex flex-wrap items-center gap-1 font-sans text-[0.85rem] text-[#555]">
          <span>{role}</span>
          <span>·</span>
          <MapPin className="size-3" />
          <span>{location}</span>
          <span>·</span>
          <span>{exp}</span>
        </div>

        {why && (
          <div className="mb-2.5 flex items-start gap-2 rounded-[10px] border border-remotiv-green/[0.2] bg-remotiv-green/[0.07] px-3.5 py-2.5 font-sans text-[0.8rem] leading-[1.6] text-[#1d8c6b]">
            <span className="shrink-0 font-bold text-remotiv-green">✦</span>
            {why}
          </div>
        )}

        {bio && (
          <p className="mb-3 font-sans text-[0.82rem] leading-[1.65] text-[#777]">{bio}</p>
        )}

        {p.skills && p.skills.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {p.skills.map((s) => (
              <span
                key={s}
                className="rounded-md border border-black/[0.07] bg-black/[0.03] px-2 py-[3px] text-[0.7rem] font-medium text-[#555]"
              >
                {s}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          <LockedContactLink label="GitHub" icon={<GithubIcon />} />
          <LockedContactLink label="LinkedIn" icon={<LinkedinIcon />} />
          <LockedContactLink label="Resume ✦" />
        </div>
      </div>

      <div className="flex flex-row items-start gap-2 md:flex-col md:items-stretch">
        <ScoreBadge score={match.match_percent} />
        <button
          type="button"
          disabled
          title="Full profile view coming soon"
          className="cursor-not-allowed rounded-xl bg-remotiv-purple/40 px-5 py-2.5 font-heading text-[0.8rem] font-semibold text-white"
        >
          View Profile
        </button>
        <button
          type="button"
          onClick={() => onToggleSave(match.candidate_id)}
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

// ── Non-result states ───────────────────────────────────────

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

function RateLimitState({ used, limit }: { used: number; limit: number }) {
  return (
    <div className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">⏳</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">
        You&apos;ve used all {limit} free searches today
      </h3>
      <p className="mb-7 font-sans text-[#777]">
        {used}/{limit} searches used. Sign up for unlimited AI matching, faster results, and
        contact unlock.
        <br />
        Free searches reset at midnight UTC.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/pricing"
          className="inline-flex items-center gap-2 rounded-[14px] bg-remotiv-purple px-7 py-3 font-heading text-[0.9rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
        >
          See plans
        </Link>
        <Link
          href="/ai-matching"
          className="inline-flex items-center gap-2 rounded-[14px] border border-black/[0.1] bg-white px-6 py-3 font-heading text-[0.9rem] font-semibold text-[#555] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple"
        >
          <ArrowLeft className="size-4" /> New Search
        </Link>
      </div>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">⚠️</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">
        Something went wrong
      </h3>
      <p className="mb-7 font-sans text-[#777]">
        We couldn&apos;t complete your search. Please try again in a moment.
      </p>
      <Link
        href="/ai-matching"
        className="inline-flex items-center gap-2 rounded-[14px] bg-remotiv-purple px-7 py-3 font-heading text-[0.9rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
      >
        <ArrowLeft className="size-4" /> New Search
      </Link>
    </div>
  );
}

// ── Main results content ────────────────────────────────────

type ErrorKind = "none" | "empty" | "rate_limit" | "error";

function ResultsContent() {
  const params = useSearchParams();
  const query = (params.get("q") ?? "").trim();

  const [results, setResults] = useState<EnrichedMatch[]>([]);
  const [tier, setTier] = useState<ApiTier>("anonymous");
  const [used, setUsed] = useState<number>(0);
  const [limit, setLimit] = useState<number>(3);
  const [, setCached] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorState, setErrorState] = useState<ErrorKind>("none");

  const [shortlist, setShortlist] = useState<Set<string>>(new Set());
  const [showOnlySaved, setShowOnlySaved] = useState(false);

  // Guard against React strict-mode double-invocation of effects in dev.
  const lastFetchedQuery = useRef<string | null>(null);

  useEffect(() => {
    if (!query) {
      setLoading(false);
      setErrorState("empty");
      setResults([]);
      return;
    }
    // Strict-mode rerun guard: same query already fetched this mount.
    if (lastFetchedQuery.current === query) return;
    lastFetchedQuery.current = query;

    setLoading(true);
    setErrorState("none");

    // Stale-response detection uses the ref (not a closured cancelled flag).
    // If the user navigates to a different ?q= mid-flight, the ref will have
    // been updated by the new effect run and this resolver bails. Within a
    // single query, the strict-mode rerun is a no-op (ref guard above).
    fetch("/api/ai-matching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
      .then(async (res) => {
        if (lastFetchedQuery.current !== query) return;
        const body = (await res.json().catch(() => null)) as
          | ApiSuccess
          | ApiRateLimit
          | null;
        if (lastFetchedQuery.current !== query) return;
        if (res.status === 429 && body && "error" in body && body.error === "rate_limit") {
          setTier(body.tier);
          setUsed(body.used);
          setLimit(body.limit);
          setErrorState("rate_limit");
          setResults([]);
          return;
        }
        if (!res.ok || !body || "error" in body) {
          setErrorState("error");
          setResults([]);
          return;
        }
        const success = body as ApiSuccess;
        setTier(success.tier);
        setUsed(success.used);
        setLimit(success.limit);
        setCached(success.cached);
        setResults(success.results);
        setErrorState(success.results.length === 0 ? "empty" : "none");
      })
      .catch(() => {
        if (lastFetchedQuery.current !== query) return;
        setErrorState("error");
        setResults([]);
      })
      .finally(() => {
        if (lastFetchedQuery.current === query) setLoading(false);
      });
  }, [query]);

  const toggleSave = useCallback((id: string) => {
    setShortlist((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visible = showOnlySaved
    ? results.filter((r) => shortlist.has(r.candidate_id))
    : results;

  if (loading) {
    return <LoadingPanel query={query} />;
  }

  if (errorState === "rate_limit") {
    return <RateLimitState used={used} limit={limit} />;
  }

  if (errorState === "error") {
    return <ErrorState />;
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
              Results for:{" "}
              <strong>
                &ldquo;{query.slice(0, 60)}
                {query.length > 60 ? "…" : ""}&rdquo;
              </strong>
              {tier !== "subscriber" && (
                <span className="ml-3 text-[#aaa]">
                  · {used}/{limit} searches today
                </span>
              )}
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
          {visible.map((m, i) => (
            <TalentCard
              key={m.candidate_id}
              match={m}
              index={i}
              saved={shortlist.has(m.candidate_id)}
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
