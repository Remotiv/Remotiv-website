"use client";

// Shared building blocks for /ai-results.
// Used by both the page (card render) and the in-place profile modal so the
// two surfaces stay visually + behaviourally identical. Pure UI primitives —
// no fetch, no state, no business logic.

import { Loader2, Lock } from "lucide-react";
import { ROLE_CONFIG, type TalentType } from "@/lib/talent-pool";

// ── Types ────────────────────────────────────────────────────

export type CandidateProfile = {
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
  // Contact fields — real strings when subscriber + unlocked; null otherwise.
  email: string | null;
  phone: string | null;
  cv_url: string | null;
  github_url: string | null;
  linkedin_url: string | null;
  avatar_url: string | null;
  status: string;
  salary_min: number | null;
  salary_max: number | null;
};

export type EnrichedMatch = {
  candidate_id: string;
  match_percent: number;
  why: string;
  saved: boolean;
  unlocked: boolean;
  profile: CandidateProfile;
};

// ── Pure utilities ───────────────────────────────────────────

export function deriveType(roleCategory: string | null): TalentType {
  const r = (roleCategory ?? "").toLowerCase();
  if (/engineer|developer|software|devops|backend|frontend|fullstack|full[- ]?stack/.test(r)) return "Eng";
  if (/design|ui|ux/.test(r)) return "Design";
  if (/data|analyst|scientist|ml|machine learning/.test(r)) return "Data";
  if (/product|manager|^pm$|owner/.test(r)) return "PM";
  if (/ops|operations|support|customer|success/.test(r)) return "Ops";
  return "Eng";
}

export function initialsOf(first: string, last: string | null): string {
  const a = first?.[0] ?? "";
  const b = last?.[0] ?? "";
  return `${a}${b}`.toUpperCase() || "??";
}

export function isAvailableNow(availability: string | null): boolean {
  if (!availability) return false;
  return availability.toLowerCase().includes("available");
}

// Prefix `https://` to a bare URL if missing — talent_profiles stores
// LinkedIn/GitHub URLs in inconsistent forms.
export function ensureHttpUrl(url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function scoreStars(score: number): string {
  const filled = score >= 95 ? 5 : score >= 88 ? 4 : score >= 75 ? 3 : score >= 60 ? 2 : 1;
  return "★".repeat(filled) + "☆".repeat(5 - filled);
}

// ── Icon components ──────────────────────────────────────────

export function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export function LinkedinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// ── Contact link buttons ─────────────────────────────────────

export function LockedContactLink({
  label,
  icon,
  onClick,
  loading = false,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title="Unlock to view contact"
      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-black/[0.08] bg-black/[0.02] px-3 py-1.5 text-[0.72rem] font-medium text-[#888] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple disabled:cursor-wait disabled:opacity-60"
    >
      {loading ? <Loader2 className="size-3 animate-spin" /> : <Lock className="size-3" strokeWidth={2} />}
      {icon}
      {label}
    </button>
  );
}

export function UnlockedContactLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-[0.72rem] font-medium text-[#555] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple"
    >
      {icon}
      {label}
    </a>
  );
}

// ── Score badge ──────────────────────────────────────────────

export function ScoreBadge({ score }: { score: number }) {
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

// Re-export ROLE_CONFIG so the modal doesn't also need to know about talent-pool.
export { ROLE_CONFIG };
export type { TalentType };
