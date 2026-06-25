"use client";

import { ArrowLeft, Bookmark, Loader2, MapPin } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getCvSignedUrl, toggleSave, unlockCandidate } from "@/app/browse-talent/actions";
import { Navbar } from "@/components/navbar";
import {
  type CandidateProfile,
  type EnrichedMatch,
  GithubIcon,
  LinkedinIcon,
  LockedContactLink,
  ROLE_CONFIG,
  ScoreBadge,
  UnlockedContactLink,
  deriveType,
  ensureHttpUrl,
  isAvailableNow,
} from "./_shared";

// Dynamic-imported on first paywall trigger — matches browse-talent's pattern
// so the modal's bundle isn't shipped to subscribers who never see it.
const PricingModal = dynamic(() => import("@/components/pricing-modal"), {
  ssr: false,
});

// In-place profile modal — code-split, only loaded on first View Profile click.
// Replaces the prior deep-link to /browse-talent?id=… (which forced a re-search
// on return, costing a Claude call + a daily quota slot).
const AIProfileModal = dynamic(() => import("./_ai-profile-modal"), {
  ssr: false,
  // Loading shell — same backdrop + panel chrome as the real modal so the
  // first-open chunk fetch gives instant feedback with no layout jump.
  loading: () => (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading profile"
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="min-h-[420px] w-full max-w-[720px] rounded-[20px] bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)] sm:rounded-[24px]" />
    </div>
  ),
});

// ── API contract ─────────────────────────────────────────────
// CandidateProfile + EnrichedMatch live in ./_shared so the AI profile modal
// can import the same shape without a circular dep on this file.

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
  // Present on the daily-limit path; absent on the burst-limit path.
  used?: number;
  limit?: number;
  tier?: ApiTier;
  message?: string;
};

// ── Helpers ──────────────────────────────────────────────────

// Icons, contact links, deriveType, ensureHttpUrl, ScoreBadge, etc. now live
// in ./_shared so the in-place profile modal can render the same primitives.

// ── Loading state ───────────────────────────────────────────
// Animated steps panel on top (brand identity) + skeleton cards below in the
// SAME container the real results use, so the transition from loading →
// results has zero layout shift.

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
            ? "motion-safe:animate-[aimStepPulse_1s_ease_infinite] border-[#111] bg-[#111] text-white"
            : "border-black/[0.12] bg-remotiv-bg text-inherit";
        return (
          <div
            key={label}
            className={`flex items-center gap-3 rounded-xl border bg-white px-[18px] py-3 font-sans text-[0.78rem] font-semibold motion-safe:transition-all duration-300 ${stateClass}`}
          >
            <div
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.65rem] font-bold motion-safe:transition-all ${checkClass}`}
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

function SkeletonBar({ className }: { className: string }) {
  return <div aria-hidden="true" className={`motion-safe:animate-pulse rounded bg-black/[0.06] ${className}`} />;
}

function SkeletonCard() {
  return (
    <article
      aria-hidden="true"
      className="grid grid-cols-1 gap-6 rounded-[20px] border border-black/[0.07] bg-white p-6 md:grid-cols-[1fr_auto]"
    >
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <SkeletonBar className="h-4 w-32" />
          <SkeletonBar className="h-4 w-14" />
        </div>
        <SkeletonBar className="mb-2.5 h-3 w-3/5" />
        <SkeletonBar className="mb-2.5 h-12 w-full" />
        <SkeletonBar className="mb-3 h-3 w-4/5" />
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          <SkeletonBar className="h-5 w-16" />
          <SkeletonBar className="h-5 w-20" />
          <SkeletonBar className="h-5 w-14" />
          <SkeletonBar className="h-5 w-24" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <SkeletonBar className="h-7 w-20 !rounded-full" />
          <SkeletonBar className="h-7 w-24 !rounded-full" />
          <SkeletonBar className="h-7 w-20 !rounded-full" />
        </div>
      </div>
      <div className="flex flex-col items-stretch gap-2">
        <SkeletonBar className="h-[88px] w-[100px] !rounded-[14px]" />
        <SkeletonBar className="h-9 w-full !rounded-xl" />
        <SkeletonBar className="h-9 w-full !rounded-xl" />
      </div>
    </article>
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
    <>
      <section
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="bg-remotiv-bg px-6 py-16 text-center sm:px-10 sm:py-20"
      >
        <div className="mx-auto mb-7 flex size-[68px] motion-safe:animate-[aimOrbPulse_1.5s_ease-in-out_infinite] items-center justify-center rounded-full bg-remotiv-green text-[1.4rem] font-bold text-[#111]">
          ✦
        </div>
        <h2 className="mb-2 font-heading text-[1.1rem] font-bold text-[#111]">
          Finding Your Best Matches…
        </h2>
        <p className="mb-8 text-[0.82rem] text-[#777]">
          &ldquo;{query.slice(0, 80)}
          {query.length > 80 ? "…" : ""}&rdquo;
        </p>
        <LoadingSteps activeStep={activeStep} />
      </section>
      <div className="mx-auto flex max-w-[900px] flex-col gap-2.5 px-6 pb-20 pt-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </>
  );
}

// ── Card components ─────────────────────────────────────────

// ScoreBadge now lives in ./_shared (used by both card + modal).

function TalentCard({
  match,
  index,
  saved,
  isUnlocked,
  isUnlocking,
  isViewingCv,
  effectiveContact,
  unlockNote,
  onToggleSave,
  onUnlock,
  onViewCv,
  onOpenProfile,
}: {
  match: EnrichedMatch;
  index: number;
  saved: boolean;
  isUnlocked: boolean;
  isUnlocking: boolean;
  isViewingCv: boolean;
  effectiveContact: {
    github: string | null;
    linkedin: string | null;
    cvUrl: string | null;
  } | null;
  unlockNote: string | null;
  onToggleSave: (id: string) => void;
  onUnlock: (id: string) => void;
  onViewCv: (id: string) => void;
  onOpenProfile: (id: string) => void;
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
      className="grid grid-cols-1 gap-6 rounded-[20px] border border-black/[0.07] bg-white p-6 motion-safe:transition-all motion-safe:hover:-translate-y-px hover:shadow-[0_12px_40px_rgba(0,0,0,0.08)] md:grid-cols-[1fr_auto]"
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
          <p className="mb-3 line-clamp-3 font-sans text-[0.82rem] leading-[1.65] text-[#777]">{bio}</p>
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

        {isUnlocked && effectiveContact ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-remotiv-green/[0.12] px-2 py-[3px] text-[0.65rem] font-bold uppercase tracking-[0.08em] text-[#1d8c6b]">
              ✓ Unlocked
            </span>
            {unlockNote && (
              <span className="text-[0.7rem] text-[#1d8c6b]">{unlockNote}</span>
            )}
            {effectiveContact.github && (
              <UnlockedContactLink
                href={ensureHttpUrl(effectiveContact.github) ?? "#"}
                label="GitHub"
                icon={<GithubIcon />}
              />
            )}
            {effectiveContact.linkedin && (
              <UnlockedContactLink
                href={ensureHttpUrl(effectiveContact.linkedin) ?? "#"}
                label="LinkedIn"
                icon={<LinkedinIcon />}
              />
            )}
            {/* Resume — the `cvs` bucket is private; cv_url is NOT directly
                clickable. Mirror browse-talent: re-sign per click via the
                server action. `effectiveContact.cvUrl` truthiness only tells
                us a CV exists; the actual URL is fetched on click. */}
            {effectiveContact.cvUrl && (
              <button
                type="button"
                onClick={() => onViewCv(match.candidate_id)}
                disabled={isViewingCv}
                aria-busy={isViewingCv}
                className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-[0.72rem] font-medium text-[#555] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple disabled:cursor-wait disabled:opacity-70"
              >
                {isViewingCv ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>Resume ✦</>
                )}
              </button>
            )}
            {!effectiveContact.github &&
              !effectiveContact.linkedin &&
              !effectiveContact.cvUrl && (
                <span className="text-[0.72rem] text-[#888]">
                  No public contact links shared
                </span>
              )}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <LockedContactLink
              label="GitHub"
              icon={<GithubIcon />}
              onClick={() => onUnlock(match.candidate_id)}
              loading={isUnlocking}
            />
            <LockedContactLink
              label="LinkedIn"
              icon={<LinkedinIcon />}
              onClick={() => onUnlock(match.candidate_id)}
              loading={isUnlocking}
            />
            <LockedContactLink
              label="Resume ✦"
              onClick={() => onUnlock(match.candidate_id)}
              loading={isUnlocking}
            />
          </div>
        )}
      </div>

      <div className="flex flex-col items-stretch gap-2">
        <ScoreBadge score={match.match_percent} />
        <button
          type="button"
          onClick={() => onOpenProfile(match.candidate_id)}
          className="rounded-xl bg-remotiv-purple px-5 py-2.5 text-center font-heading text-[0.8rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
        >
          View Profile
        </button>
        <button
          type="button"
          onClick={() => onToggleSave(match.candidate_id)}
          aria-pressed={saved}
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
    <div role="status" className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">🔍</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">No matches found</h3>
      <p className="mb-7 font-sans text-[#777]">
        We couldn&apos;t find profiles matching your exact criteria.
        <br />
        Try broadening your search or using different keywords.
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

function RateLimitState({
  kind,
  used,
  limit,
}: {
  kind: RateLimitKind;
  used: number;
  limit: number;
}) {
  if (kind === "burst") {
    return (
      <div role="status" className="px-6 py-20 text-center">
        <div className="mb-5 text-5xl">⏳</div>
        <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">
          You&apos;re sending requests too quickly
        </h3>
        <p className="mb-7 font-sans text-[#777]">
          Please wait a minute and try again.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
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
  return (
    <div role="status" className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">⏳</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">
        You&apos;ve used all {limit} free searches today
      </h3>
      <p className="mb-7 font-sans text-[#777]">
        {used}/{limit} searches used. Sign up for unlimited AI Talent Match, faster results, and
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

function NoQueryState() {
  return (
    <div role="status" className="px-6 py-20 text-center">
      <div className="mb-5 text-5xl">✦</div>
      <h3 className="mb-3 font-heading text-[1.3rem] font-bold text-[#111]">Start your search</h3>
      <p className="mb-7 font-sans text-[#777]">
        Describe who you&apos;re hiring for and our AI will rank the best-fit candidates.
      </p>
      <Link
        href="/ai-matching"
        className="inline-flex items-center gap-2 rounded-[14px] bg-remotiv-purple px-7 py-3 font-heading text-[0.9rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
      >
        <ArrowLeft className="size-4" /> Start a search
      </Link>
    </div>
  );
}

function ErrorState() {
  return (
    <div role="alert" className="px-6 py-20 text-center">
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

type ErrorKind = "none" | "empty" | "no_query" | "rate_limit" | "error";
type RateLimitKind = "daily" | "burst";

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
  // F10: distinguish daily-quota 429 from per-minute burst 429 so RateLimitState
  // can show the right copy. Both 429s share the discriminator error: "rate_limit";
  // burst lacks used/limit numbers.
  const [rateLimitKind, setRateLimitKind] = useState<RateLimitKind>("daily");
  // F23: lightweight inline notice for CV-open failures (no toast system on this
  // page; mirrors comingSoonToast's render pattern but with variable text).
  const [cvNotice, setCvNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!cvNotice) return;
    const t = setTimeout(() => setCvNotice(null), 4000);
    return () => clearTimeout(t);
  }, [cvNotice]);

  const [shortlist, setShortlist] = useState<Set<string>>(new Set());
  const [showOnlySaved, setShowOnlySaved] = useState(false);
  const [isPricingModalOpen, setIsPricingModalOpen] = useState(false);
  // In-place profile modal: id of the result whose profile is open, or null.
  const [openProfileId, setOpenProfileId] = useState<string | null>(null);
  // Mirrors browse-talent's "Subscriptions coming soon" toast — shown when the
  // user clicks Get Started inside the PricingModal (Stripe not wired yet).
  const [comingSoonToast, setComingSoonToast] = useState(false);
  useEffect(() => {
    if (!comingSoonToast) return;
    const t = setTimeout(() => setComingSoonToast(false), 3000);
    return () => clearTimeout(t);
  }, [comingSoonToast]);
  // In-flight guard: prevent TOCTOU races on rapid double-clicks of the same row.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // Phase 5C: per-card unlock state. unlockedSet is the canonical truth;
  // unlockedContactData stores the freshly-revealed contact for just-now-unlocked
  // rows (since the initial profile.* fields are null for those rows until the
  // next API call). unlockingIds powers per-card spinner state.
  const [unlockedSet, setUnlockedSet] = useState<Set<string>>(new Set());
  const [unlockedContactData, setUnlockedContactData] = useState<
    Map<
      string,
      {
        email: string | null;
        phone: string | null;
        linkedinUrl: string | null;
        cvUrl: string | null;
      }
    >
  >(new Map());
  const [unlockingIds, setUnlockingIds] = useState<Set<string>>(new Set());
  // Phase 5C fix: in-flight guard for Resume click (signed-URL re-fetch).
  const [viewingCvIds, setViewingCvIds] = useState<Set<string>>(new Set());
  // Per-card unlock note — tells the user whether a credit was charged or
  // the candidate was already unlocked (e.g. from a prior browse-talent unlock).
  const [lastUnlockNote, setLastUnlockNote] = useState<{ id: string; text: string } | null>(null);

  // Guard against React strict-mode double-invocation of effects in dev.
  const lastFetchedQuery = useRef<string | null>(null);
  // M2 + M3: ref to the results h1 so we can move focus when a search resolves
  // successfully. focusedForQueryRef gates the effect to fire ONCE per successful
  // search (not on every render), and resets implicitly when query changes.
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusedForQueryRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !loading &&
      errorState === "none" &&
      results.length > 0 &&
      focusedForQueryRef.current !== query
    ) {
      focusedForQueryRef.current = query;
      resultsHeadingRef.current?.focus();
    }
  }, [loading, errorState, results.length, query]);

  useEffect(() => {
    if (!query) {
      setLoading(false);
      // F11: distinct state — "no_query" means the user landed here without
      // a search, not that their search returned zero matches.
      setErrorState("no_query");
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
          // F10: presence of `limit` on the body discriminates daily-quota
          // (has used/limit/tier) from per-minute burst (none of those).
          if (typeof body.limit === "number") {
            setRateLimitKind("daily");
            if (body.tier) setTier(body.tier);
            setUsed(body.used ?? 0);
            setLimit(body.limit);
          } else {
            setRateLimitKind("burst");
          }
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
        // Phase 5B: reflect real saved state from the DB. The API returns
        // `saved: boolean` per result based on saved_profiles for the current
        // user. Anonymous users always get saved: false (no DB lookup).
        setShortlist(
          new Set(
            success.results.filter((r) => r.saved).map((r) => r.candidate_id),
          ),
        );
        // Phase 5C: reflect real unlock state. Same idea — server determines
        // unlocked-on-load; client tracks just-now-unlocked separately in the
        // Map. Reset the Map on every new search so stale entries from another
        // query don't bleed across queries.
        setUnlockedSet(
          new Set(
            success.results.filter((r) => r.unlocked).map((r) => r.candidate_id),
          ),
        );
        setUnlockedContactData(new Map());
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

  // Mirrors browse-talent/_browse-client.tsx's pattern: pre-check tier for the
  // paywall path (no DB call), then optimistic flip + server toggleSave + rollback
  // on failure. Subscription-required error reopens the pricing modal.
  const handleToggleSave = useCallback(
    async (candidateId: string) => {
      // Non-subscribers (anonymous + free) → open pricing modal, do not call the server.
      if (tier !== "subscriber") {
        setIsPricingModalOpen(true);
        return;
      }
      // In-flight guard against rapid double-clicks on the same row.
      if (savingIds.has(candidateId)) return;
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.add(candidateId);
        return next;
      });

      const wasSaved = shortlist.has(candidateId);

      // Optimistic flip — bookmark icon updates instantly.
      setShortlist((prev) => {
        const next = new Set(prev);
        if (wasSaved) next.delete(candidateId);
        else next.add(candidateId);
        return next;
      });

      try {
        const result = await toggleSave(candidateId);
        if (!result.success) {
          // Roll back the optimistic flip.
          setShortlist((prev) => {
            const next = new Set(prev);
            if (wasSaved) next.add(candidateId);
            else next.delete(candidateId);
            return next;
          });
          // Subscription stale / changed mid-session → re-prompt with pricing.
          if ((result.error ?? "") === "Subscription required") {
            setIsPricingModalOpen(true);
          }
          // Other errors fall through silently for now — the rollback already
          // reverted the UI. Phase 5 polish can add per-error toasts later.
        }
      } finally {
        setSavingIds((prev) => {
          const next = new Set(prev);
          next.delete(candidateId);
          return next;
        });
      }
    },
    [tier, savingIds, shortlist],
  );

  // Phase 5C: unlock click. Mirrors browse-talent's handleUnlock pattern:
  // tier pre-check → in-flight guard → unlockCandidate → on success update
  // unlockedSet + unlockedContactData. On no_credits / not_subscribed errors,
  // open the PricingModal (this file has no toast system; the modal is the
  // unified upgrade prompt).
  const handleUnlock = useCallback(
    async (candidateId: string) => {
      // Non-subscribers (anonymous + free) → open pricing modal, no server call.
      if (tier !== "subscriber") {
        setIsPricingModalOpen(true);
        return;
      }
      // Already unlocked? No-op (button shouldn't be locked, but defensive).
      if (unlockedSet.has(candidateId)) return;
      // In-flight guard against rapid double-clicks on the same card.
      if (unlockingIds.has(candidateId)) return;
      setUnlockingIds((prev) => {
        const next = new Set(prev);
        next.add(candidateId);
        return next;
      });

      try {
        const result = await unlockCandidate(candidateId);
        if (result.success) {
          setUnlockedSet((prev) => {
            const next = new Set(prev);
            next.add(candidateId);
            return next;
          });
          setUnlockedContactData((prev) => {
            const next = new Map(prev);
            next.set(candidateId, {
              email: result.email,
              phone: result.phone,
              linkedinUrl: result.linkedinUrl,
              cvUrl: result.cvUrl,
            });
            return next;
          });
          // Tell the user whether a credit was charged or the unlock was free.
          // alreadyUnlocked = the candidate was previously unlocked (browse-talent
          // shares the same unlock_events table). The RPC explicitly skips the
          // credit decrement in that path.
          setLastUnlockNote({
            id: candidateId,
            text: result.alreadyUnlocked
              ? "Already unlocked — no credit used"
              : `Unlocked · ${result.creditsRemaining} credits left`,
          });
        } else {
          // no_credits = subscriber out of credits this month.
          // not_subscribed = subscription cancelled mid-session (stale prop).
          // Both → PricingModal as the unified upgrade prompt.
          if (result.error === "no_credits" || result.error === "not_subscribed") {
            setIsPricingModalOpen(true);
          }
          // Other errors (candidate_not_found, internal_error, invalid_input,
          // rate_limited): silent revert — the in-flight spinner clears in finally.
        }
      } finally {
        setUnlockingIds((prev) => {
          const next = new Set(prev);
          next.delete(candidateId);
          return next;
        });
      }
    },
    [tier, unlockedSet, unlockingIds],
  );

  // Phase 5C fix: Resume click → fetch a fresh 1-hour signed URL via
  // getCvSignedUrl and open it. Mirrors browse-talent's handleViewCv exactly.
  // The `cvs` storage bucket is private, so the raw cv_url stored on
  // talent_profiles is never directly clickable — must be re-signed per click.
  const handleViewCv = useCallback(
    async (candidateId: string) => {
      if (viewingCvIds.has(candidateId)) return;
      setViewingCvIds((prev) => {
        const next = new Set(prev);
        next.add(candidateId);
        return next;
      });
      try {
        const result = await getCvSignedUrl(candidateId);
        if (result.ok) {
          // Clear any stale CV notice from a prior failed attempt.
          setCvNotice(null);
          window.open(result.url, "_blank", "noopener,noreferrer");
          return;
        }
        // Auth/subscription errors → PricingModal (unified upgrade prompt).
        if (result.error === "not_authenticated" || result.error === "not_unlocked") {
          setIsPricingModalOpen(true);
        } else if (result.error === "cv_missing") {
          setCvNotice("This candidate hasn't uploaded a resume.");
        } else {
          // internal_error or any other unexpected !ok branch.
          setCvNotice("Couldn't open the resume. Please try again.");
        }
      } finally {
        setViewingCvIds((prev) => {
          const next = new Set(prev);
          next.delete(candidateId);
          return next;
        });
      }
    },
    [viewingCvIds],
  );

  const visible = showOnlySaved
    ? results.filter((r) => shortlist.has(r.candidate_id))
    : results;

  if (loading) {
    return <LoadingPanel query={query} />;
  }

  if (errorState === "no_query") {
    return <NoQueryState />;
  }

  if (errorState === "rate_limit") {
    return <RateLimitState kind={rateLimitKind} used={used} limit={limit} />;
  }

  if (errorState === "error") {
    return <ErrorState />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.07] bg-white px-14 py-5">
        <div>
          <h1
            ref={resultsHeadingRef}
            tabIndex={-1}
            className="font-heading text-[1rem] font-bold text-[#111] focus:outline-none"
          >
            Showing <span className="text-remotiv-purple">{visible.length}</span> matched profiles
          </h1>
          {query && (
            <div className="mt-0.5 text-[0.78rem] text-[#777]">
              Results for:{" "}
              <strong>
                &ldquo;{query.slice(0, 60)}
                {query.length > 60 ? "…" : ""}&rdquo;
              </strong>
              {tier !== "subscriber" && (
                <span className="ml-3 text-[#aaa]">
                  · {used} of {limit} free searches today
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowOnlySaved((v) => !v)}
            className={`flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] px-4 py-1.5 font-sans text-[0.82rem] font-medium transition-colors sm:min-h-0 ${
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
            className="flex min-h-11 items-center gap-1.5 rounded-full bg-remotiv-purple px-[18px] py-2 font-sans text-[0.82rem] font-semibold text-white transition-colors hover:bg-[#6a38e0] sm:min-h-0"
          >
            <ArrowLeft className="size-3.5" /> New Search
          </Link>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mx-auto flex max-w-[900px] flex-col gap-2.5 px-6 pb-20 pt-6">
          {visible.map((m, i) => {
            const cardUnlocked = unlockedSet.has(m.candidate_id);
            const local = unlockedContactData.get(m.candidate_id);
            // Effective contact: prefer just-now-unlocked Map (freshest signed
            // CV URL + latest contact); fall back to profile fields (real when
            // the API determined this card was already unlocked on load).
            // GitHub is never returned by unlockCandidate, so use the profile
            // field — null right after a fresh unlock, but real on next fetch.
            const effectiveContact = cardUnlocked
              ? {
                  github: m.profile.github_url ?? null,
                  linkedin:
                    local?.linkedinUrl ?? m.profile.linkedin_url ?? null,
                  cvUrl: local?.cvUrl ?? m.profile.cv_url ?? null,
                }
              : null;
            return (
              <TalentCard
                key={m.candidate_id}
                match={m}
                index={i}
                saved={shortlist.has(m.candidate_id)}
                isUnlocked={cardUnlocked}
                isUnlocking={unlockingIds.has(m.candidate_id)}
                isViewingCv={viewingCvIds.has(m.candidate_id)}
                effectiveContact={effectiveContact}
                unlockNote={
                  lastUnlockNote?.id === m.candidate_id ? lastUnlockNote.text : null
                }
                onToggleSave={handleToggleSave}
                onUnlock={handleUnlock}
                onViewCv={handleViewCv}
                onOpenProfile={setOpenProfileId}
              />
            );
          })}
        </div>
      )}

      <PricingModal
        isOpen={isPricingModalOpen}
        onClose={() => setIsPricingModalOpen(false)}
        // Mirror browse-talent: Stripe isn't wired yet, so the Get Started CTA
        // closes the modal and surfaces a coming-soon toast instead of routing
        // the user to /signup.
        onGetStarted={() => {
          setIsPricingModalOpen(false);
          setComingSoonToast(true);
        }}
      />

      {comingSoonToast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded-xl bg-[#111] px-5 py-3 text-sm font-medium text-white shadow-xl"
        >
          🔒 Subscriptions coming soon. Check back later.
        </div>
      )}

      {cvNotice && (
        <div
          role="alert"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded-xl bg-[#111] px-5 py-3 text-sm font-medium text-white shadow-xl"
        >
          {cvNotice}
        </div>
      )}

      {/* In-place profile modal. Render when an id is open AND that id is
          still in the result set; pass through the SAME per-card state +
          handlers so unlock/save/CV state stays in sync with the card. */}
      {(() => {
        if (!openProfileId) return null;
        const openMatch = results.find((r) => r.candidate_id === openProfileId);
        if (!openMatch) return null;
        const cardUnlocked = unlockedSet.has(openMatch.candidate_id);
        const local = unlockedContactData.get(openMatch.candidate_id);
        const effectiveContact = cardUnlocked
          ? {
              github: openMatch.profile.github_url ?? null,
              linkedin: local?.linkedinUrl ?? openMatch.profile.linkedin_url ?? null,
              cvUrl: local?.cvUrl ?? openMatch.profile.cv_url ?? null,
            }
          : null;
        return (
          <AIProfileModal
            match={openMatch}
            isUnlocked={cardUnlocked}
            isUnlocking={unlockingIds.has(openMatch.candidate_id)}
            isSaving={savingIds.has(openMatch.candidate_id)}
            isViewingCv={viewingCvIds.has(openMatch.candidate_id)}
            saved={shortlist.has(openMatch.candidate_id)}
            effectiveContact={effectiveContact}
            unlockNote={
              lastUnlockNote?.id === openMatch.candidate_id
                ? lastUnlockNote.text
                : null
            }
            onClose={() => setOpenProfileId(null)}
            onToggleSave={handleToggleSave}
            onUnlock={handleUnlock}
            onViewCv={handleViewCv}
          />
        );
      })()}
    </>
  );
}

export default function AIResultsPage() {
  return (
    <div className="min-h-screen bg-remotiv-bg">
      <Navbar />
      <main id="main">
        <Suspense
          fallback={
            <div className="px-14 py-12 text-center font-sans text-[#777]">Loading results…</div>
          }
        >
          <ResultsContent />
        </Suspense>
      </main>
    </div>
  );
}
