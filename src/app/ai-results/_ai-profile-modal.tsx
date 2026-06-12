"use client";

// In-place profile modal for /ai-results. Replaces the prior "View Profile →
// /browse-talent?id=" navigation: navigating away + back re-runs Claude (costs
// money + burns a daily search slot). This modal lives on the AI Matching page
// and consumes the per-result state the page already maintains, so opening it
// is free.
//
// Visual identity intentionally matches the existing /ai-results card design
// (Tailwind tokens: rounded-[20px], border-black/[0.07], remotiv-green/purple)
// — NOT browse-talent's bt-* CSS language. No coupling to _browse-client.tsx.

import { Bookmark, Loader2, MapPin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchProfileDetail } from "@/app/browse-talent/actions";
import {
  type EnrichedMatch,
  GithubIcon,
  LinkedinIcon,
  LockedContactLink,
  ROLE_CONFIG,
  ScoreBadge,
  UnlockedContactLink,
  deriveType,
  ensureHttpUrl,
  initialsOf,
  isAvailableNow,
} from "./_shared";

type ProfileDetail = {
  summary: string | null;
  experience: Array<{
    title: string | null;
    company: string | null;
    dates: string | null;
    skills: string[];
  }>;
  degree: string | null;
  institution: string | null;
};

type Props = {
  match: EnrichedMatch;
  isUnlocked: boolean;
  isUnlocking: boolean;
  isSaving: boolean;
  isViewingCv: boolean;
  saved: boolean;
  effectiveContact: {
    github: string | null;
    linkedin: string | null;
    cvUrl: string | null;
  } | null;
  unlockNote: string | null;
  onClose: () => void;
  onToggleSave: (id: string) => void;
  onUnlock: (id: string) => void;
  onViewCv: (id: string) => void;
};

function formatSalary(min: number | null, max: number | null): string | null {
  // Treat 0 as absent — talent_profiles sometimes stores 0 as placeholder
  // rather than null, and "$0" would mislead.
  let lo = min && min > 0 ? min : null;
  let hi = max && max > 0 ? max : null;
  if (lo == null && hi == null) return null;
  // Defensive swap if the data has them reversed (low–high should always read
  // left to right).
  if (lo != null && hi != null && lo > hi) [lo, hi] = [hi, lo];
  const fmt = (n: number) => `$${n.toLocaleString("en-US")}`;
  if (lo != null && hi != null) return `${fmt(lo)} – ${fmt(hi)}`;
  if (lo != null) return `${fmt(lo)}+`;
  if (hi != null) return `up to ${fmt(hi)}`;
  return null;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2.5 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-remotiv-green">
      <span aria-hidden className="block h-px w-4 bg-remotiv-green" />
      {children}
    </div>
  );
}

function ExperienceSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-3.5 w-1/2 motion-safe:animate-pulse rounded bg-black/[0.06]" />
          <div className="h-3 w-1/3 motion-safe:animate-pulse rounded bg-black/[0.05]" />
          <div className="h-3 w-1/4 motion-safe:animate-pulse rounded bg-black/[0.05]" />
        </div>
      ))}
    </div>
  );
}

export default function AIProfileModal({
  match,
  isUnlocked,
  isUnlocking,
  isSaving,
  isViewingCv,
  saved,
  effectiveContact,
  unlockNote,
  onClose,
  onToggleSave,
  onUnlock,
  onViewCv,
}: Props) {
  const p = match.profile;
  const type = deriveType(p.role_category);
  const cfg = ROLE_CONFIG[type];

  const name = `${p.first_name}${p.last_name ? ` ${p.last_name}` : ""}`.trim() || "Talent";
  const role = p.job_title || p.role_category || "Talent";
  const location = [p.city, p.country].filter(Boolean).join(", ") || "Remote";
  const exp =
    p.years_experience != null ? `${p.years_experience} years experience` : null;
  const salary = formatSalary(p.salary_min, p.salary_max);
  const available = isAvailableNow(p.availability);

  // Lazy detail (summary + experience + education) — same server action that
  // browse-talent's modal uses. Returns redacted output for non-unlocked viewers.
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);

  // Entry fade — backdrop + panel transition in over 150ms after first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingDetail(true);
    fetchProfileDetail(match.candidate_id)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDetail(result.detail);
      })
      .catch(() => {
        /* keep the rest of the modal usable on detail-fetch failure */
      })
      .finally(() => {
        if (!cancelled) setIsLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [match.candidate_id]);

  // ESC closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Ref-counted body scroll lock — matches HireRequestWizard's pattern so
  // stacked modals (e.g. PricingModal opens over us) don't clobber each other.
  useEffect(() => {
    const count = Number.parseInt(document.body.dataset.scrollLocks ?? "0", 10);
    document.body.dataset.scrollLocks = String(count + 1);
    if (count === 0) document.body.style.overflow = "hidden";
    return () => {
      const current = Number.parseInt(document.body.dataset.scrollLocks ?? "1", 10);
      const next = current - 1;
      document.body.dataset.scrollLocks = String(next);
      if (next <= 0) {
        document.body.style.overflow = "";
        delete document.body.dataset.scrollLocks;
      }
    };
  }, []);

  // Initial focus on the close button so keyboard users start inside the modal.
  // Tab/Shift+Tab are trapped by the keydown handler below.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = setTimeout(() => closeBtnRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Focus trap: wrap Tab / Shift+Tab at the modal's first/last focusable.
  // Re-queries on every keypress because the modal content changes as the
  // detail fetch resolves (Experience/Education sections mount in).
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Prefer freshly-fetched (and possibly redacted) summary; fall back to what
  // the API returned in the list payload.
  const summary = (detail?.summary ?? p.summary ?? "").trim();
  const experience = detail?.experience ?? [];
  const hasEducation = !!detail?.degree || !!detail?.institution;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-profile-modal-title"
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/50 p-4"
      style={{ opacity: mounted ? 1 : 0, transition: "opacity 150ms ease-out" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative flex max-h-[92dvh] w-full max-w-[720px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_20px_60px_rgba(0,0,0,0.2)] sm:max-h-[90vh] sm:rounded-[24px]"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? "scale(1)" : "scale(0.97)",
          transition: "opacity 150ms ease-out, transform 150ms ease-out",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Floating close button — always visible regardless of scroll */}
        <button
          ref={closeBtnRef}
          type="button"
          onClick={onClose}
          aria-label="Close profile"
          className="absolute right-3 top-3 z-10 flex size-9 items-center justify-center rounded-full border border-black/[0.08] bg-white text-[#555] shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-colors hover:border-remotiv-purple hover:text-remotiv-purple"
        >
          <X className="size-4" strokeWidth={2} />
        </button>

        <div className="overflow-y-auto px-5 pb-5 pt-6 sm:px-7 sm:pb-6 sm:pt-7">
          <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-[auto_1fr_auto] sm:items-start">
            <div
              className="flex size-16 items-center justify-center rounded-2xl font-heading text-[1.2rem] font-extrabold"
              style={{
                background: cfg.background,
                color: cfg.color,
                border: `1px solid ${cfg.border}`,
              }}
              aria-hidden
            >
              {initialsOf(p.first_name, p.last_name)}
            </div>

            <div className="min-w-0 pr-12 sm:pr-0">
              <h2
                id="ai-profile-modal-title"
                className="font-heading text-[1.3rem] font-bold text-[#111]"
              >
                {name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.85rem] text-[#555]">
                <span>{role}</span>
                <span
                  className="rounded-md border px-2 py-[3px] text-[0.62rem] font-bold uppercase tracking-[0.08em]"
                  style={{
                    color: cfg.color,
                    borderColor: cfg.border,
                    background: cfg.background,
                  }}
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
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.82rem] text-[#666]">
                <MapPin className="size-3.5" />
                <span>{location}</span>
                {exp && (
                  <>
                    <span>·</span>
                    <span>{exp}</span>
                  </>
                )}
              </div>
            </div>

            <div className="hidden sm:block">
              <ScoreBadge score={match.match_percent} />
            </div>
          </div>

          <div className="mb-4 flex justify-center sm:hidden">
            <ScoreBadge score={match.match_percent} />
          </div>

          {match.why && (
            <div className="mb-5 flex items-start gap-2 rounded-[12px] border border-remotiv-green/[0.2] bg-remotiv-green/[0.07] px-4 py-3 font-sans text-[0.85rem] leading-[1.6] text-[#1d8c6b]">
              <span className="shrink-0 font-bold text-remotiv-green">✦</span>
              <span>{match.why}</span>
            </div>
          )}

          {(p.work_type || salary || p.years_experience != null) && (
            <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {p.work_type && (
                <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] px-3 py-2">
                  <p className="text-[0.6rem] font-bold uppercase tracking-[0.12em] text-[#888]">
                    Work type
                  </p>
                  <p className="mt-0.5 text-[0.85rem] text-[#333]">{p.work_type}</p>
                </div>
              )}
              {p.years_experience != null && (
                <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] px-3 py-2">
                  <p className="text-[0.6rem] font-bold uppercase tracking-[0.12em] text-[#888]">
                    Experience
                  </p>
                  <p className="mt-0.5 text-[0.85rem] text-[#333]">
                    {p.years_experience} years
                  </p>
                </div>
              )}
              {salary && (
                <div className="rounded-xl border border-black/[0.06] bg-black/[0.02] px-3 py-2">
                  <p className="text-[0.6rem] font-bold uppercase tracking-[0.12em] text-[#888]">
                    Expected salary
                  </p>
                  <p className="mt-0.5 text-[0.85rem] text-[#333]">{salary}</p>
                </div>
              )}
            </div>
          )}

          {p.skills && p.skills.length > 0 && (
            <div className="mb-5">
              <SectionLabel>Skills</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {p.skills.map((s) => (
                  <span
                    key={s}
                    className="rounded-md border border-black/[0.07] bg-black/[0.03] px-2 py-[3px] text-[0.72rem] font-medium text-[#555]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {summary && (
            <div className="mb-5">
              <SectionLabel>About</SectionLabel>
              <p className="whitespace-pre-wrap font-sans text-[0.88rem] leading-[1.65] text-[#555]">
                {summary}
              </p>
            </div>
          )}

          {(isLoadingDetail || experience.length > 0) && (
            <div className="mb-5">
              <SectionLabel>Experience</SectionLabel>
              {isLoadingDetail ? (
                <ExperienceSkeleton />
              ) : (
                <div className="flex flex-col gap-3">
                  {experience.map((exp, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: experience lacks a stable id
                      key={i}
                      className="rounded-xl border-l-[3px] border-l-remotiv-purple bg-black/[0.02] px-4 py-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="font-heading text-[0.95rem] font-bold text-[#111]">
                          {exp.title || "Role"}
                        </p>
                        {exp.dates && (
                          <p className="text-[0.72rem] text-[#999]">{exp.dates}</p>
                        )}
                      </div>
                      {exp.company && (
                        <p className="mt-0.5 text-[0.82rem] text-[#666]">
                          {exp.company}
                        </p>
                      )}
                      {exp.skills && exp.skills.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {exp.skills.map((s) => (
                            <span
                              key={s}
                              className="rounded-md bg-remotiv-purple/[0.06] px-1.5 py-[2px] text-[0.68rem] font-medium text-remotiv-purple"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasEducation && (
            <div className="mb-5">
              <SectionLabel>Education</SectionLabel>
              <div className="rounded-xl bg-black/[0.02] px-4 py-3">
                {detail?.degree && (
                  <p className="font-heading text-[0.9rem] font-bold text-[#111]">
                    {detail.degree}
                  </p>
                )}
                {detail?.institution && (
                  <p className="mt-0.5 text-[0.82rem] text-[#666]">
                    {detail.institution}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="mb-2">
            <SectionLabel>Contact</SectionLabel>
            {isUnlocked && effectiveContact ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-remotiv-green/[0.12] px-2 py-[3px] text-[0.65rem] font-bold uppercase tracking-[0.08em] text-[#1d8c6b]">
                  ✓ Unlocked
                </span>
                {unlockNote && (
                  <span className="text-[0.7rem] text-[#1d8c6b]">{unlockNote}</span>
                )}
                {effectiveContact.github &&
                  (() => {
                    const url = ensureHttpUrl(effectiveContact.github);
                    return url ? (
                      <UnlockedContactLink
                        href={url}
                        label="GitHub"
                        icon={<GithubIcon />}
                      />
                    ) : (
                      <span className="text-[0.8rem] text-gray-400">
                        GitHub unavailable
                      </span>
                    );
                  })()}
                {effectiveContact.linkedin &&
                  (() => {
                    const url = ensureHttpUrl(effectiveContact.linkedin);
                    return url ? (
                      <UnlockedContactLink
                        href={url}
                        label="LinkedIn"
                        icon={<LinkedinIcon />}
                      />
                    ) : (
                      <span className="text-[0.8rem] text-gray-400">
                        LinkedIn unavailable
                      </span>
                    );
                  })()}
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
              <div className="flex flex-wrap gap-1.5">
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
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-black/[0.07] bg-white px-5 py-3 sm:px-7 sm:py-4">
          <button
            type="button"
            onClick={() => onToggleSave(match.candidate_id)}
            disabled={isSaving}
            className={`flex items-center justify-center gap-1.5 rounded-xl border px-5 py-2.5 text-[0.85rem] font-semibold transition-colors disabled:cursor-wait disabled:opacity-70 ${
              saved
                ? "border-remotiv-purple bg-remotiv-purple/[0.08] text-remotiv-purple"
                : "border-black/[0.1] bg-white text-[#555] hover:border-remotiv-purple hover:text-remotiv-purple"
            }`}
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Bookmark className={`size-4 ${saved ? "fill-current" : ""}`} />
            )}
            {saved ? "Saved" : "Save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-remotiv-purple px-6 py-2.5 font-heading text-[0.85rem] font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
