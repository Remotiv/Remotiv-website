"use client";

import "./browse-talent.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Navbar } from "@/components/navbar";
import { cn } from "@/lib/utils";

// Phase 4 Bundle C: code-split modals.
// PricingModal only opens on a paywall-trigger click, so loading its bundle
// up-front penalises every visitor. ssr:false is safe — never visible during SSR.
const PricingModal = dynamic(() => import("@/components/pricing-modal"), {
  ssr: false,
});
// ProfileModal only opens when the user clicks a card. Lives in its own file
// (./_profile-modal) and is fetched on first card-open.
const ProfileModal = dynamic(() => import("./_profile-modal"), {
  ssr: false,
});
import {
  fetchProfileDetail,
  getCvSignedUrl,
  refreshTier,
  toggleSave,
  unlockCandidate,
  type ProfileDetail,
  type UnlockResult,
} from "./actions";
import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import { useFocusTrap } from "@/hooks/use-focus-trap";

// ── Types ────────────────────────────────────────────────────

// Phase 4 Lean Projection: list-projection row shape. The columns
// previously here (industry, degree, institution, experience) moved to
// fetchProfileDetail (actions.ts) and are no longer in the SSR payload.
export type TalentRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  role_category: string | null;
  years_experience: number | null;
  city: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  cv_url: string | null;
  skills: string[] | null;
  summary: string | null;
  availability: string | null;
  work_type: string | null;
  notice_period: string | null;
  work_location: string | null;
  salary_min: number | null;
  salary_max: number | null;
  avatar_url: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  approved_at: string | null;
  created_at: string | null;
};

export type RoleType =
  | "Engineer" | "SDR" | "CS" | "Design" | "Data"
  | "DevOps" | "QA" | "Marketing" | "Ops" | "Finance";

export type ExperienceItem = {
  title: string;
  company: string;
  dates: string;
  skills: string[];
};

// Phase 4 Bundle C: exported so the extracted _profile-modal.tsx and
// _blurred-preview.ts can reference the same Card shape.
// Phase 4 Lean Projection: detail-only fields (degree, institution,
// experience) removed from Card — they live on ProfileDetail (./actions)
// and arrive via fetchProfileDetail when the modal opens. `industry` was
// dead (mapped but never displayed) and is dropped. `education` (demo-only
// composite string) retained for static preview data in _blurred-preview.
export type Card = {
  id: string;
  name: string;
  initials: string;
  role: string;
  type: RoleType;
  skills: string[];
  location: string;
  exp: string;                    // "7 years" or "—"
  yearsExperience?: number | null; // numeric form for "X years experience in …"
  available: boolean;
  score: number;
  highlights: string[];
  bio: string;
  fullTime: boolean;
  partTime: boolean;
  remote: boolean;
  contract?: boolean;
  hybrid?: boolean;
  onsite?: boolean;
  education?: string;             // demo data only ("Degree — Institution")
  lastActive: string;
  github: string | null;
  linkedin: string | null;
  email?: string | null;          // admin preview only
  phone?: string | null;          // admin preview only
  cvUrl?: string | null;          // admin preview only
};

// ── BT_ROLE_CFG (verbatim from HTML) ─────────────────────────

const TOAST_DURATION_MS = 3500;

const isFreeViewer = (tier: string): boolean => tier === "free";

export const ROLE_CFG: Record<RoleType, { c: string; bg: string; b: string; label: string }> = {
  Engineer:  { c: "#60a5fa", bg: "rgba(96,165,250,0.08)",  b: "rgba(96,165,250,0.3)",  label: "Engineer" },
  SDR:       { c: "#a78bfa", bg: "rgba(167,139,250,0.08)", b: "rgba(167,139,250,0.3)", label: "Sales / SDR" },
  CS:        { c: "#34d399", bg: "rgba(52,211,153,0.08)",  b: "rgba(52,211,153,0.3)",  label: "Customer Success" },
  Design:    { c: "#fb923c", bg: "rgba(251,146,60,0.08)",  b: "rgba(251,146,60,0.3)",  label: "Design & UX" },
  Data:      { c: "#818cf8", bg: "rgba(129,140,248,0.08)", b: "rgba(129,140,248,0.3)", label: "Data & AI" },
  DevOps:    { c: "#22d3ee", bg: "rgba(34,211,238,0.08)",  b: "rgba(34,211,238,0.3)",  label: "DevOps & Cloud" },
  QA:        { c: "#f87171", bg: "rgba(248,113,113,0.08)", b: "rgba(248,113,113,0.3)", label: "QA" },
  Marketing: { c: "#fbbf24", bg: "rgba(251,191,36,0.08)",  b: "rgba(251,191,36,0.3)",  label: "Marketing" },
  Ops:       { c: "#c084fc", bg: "rgba(192,132,252,0.08)", b: "rgba(192,132,252,0.3)", label: "Business & Ops" },
  Finance:   { c: "#34d399", bg: "rgba(52,211,153,0.08)",  b: "rgba(52,211,153,0.3)",  label: "Finance" },
};

const ROLE_FILTERS: Array<{ key: "All" | RoleType; label: string; count: string; dot: string }> = [
  { key: "All",       label: "All Talent",            count: "50K+",  dot: "#49D7A7" },
  { key: "Engineer",  label: "Software Engineers",    count: "18.4K", dot: "#60a5fa" },
  { key: "SDR",       label: "SDR / Sales",           count: "12K",   dot: "#a78bfa" },
  { key: "CS",        label: "Customer Success",      count: "9.8K",  dot: "#34d399" },
  { key: "Design",    label: "Design & UX",           count: "6.2K",  dot: "#fb923c" },
  { key: "Data",      label: "Data & AI",             count: "5.1K",  dot: "#818cf8" },
  { key: "DevOps",    label: "DevOps & Cloud",        count: "4.8K",  dot: "#22d3ee" },
  { key: "QA",        label: "Quality Assurance",     count: "3.9K",  dot: "#f87171" },
  { key: "Marketing", label: "Marketing & Growth",    count: "4.2K",  dot: "#fbbf24" },
  { key: "Ops",       label: "Business & Ops",        count: "3.4K",  dot: "#c084fc" },
  { key: "Finance",   label: "Finance & Accounting",  count: "2.8K",  dot: "#34d399" },
];

// Phase 4 Bundle C: BLURRED_PREVIEW_CARDS moved to ./_blurred-preview.
// It's dynamic-imported below inside BrowseClient when shouldShowPaywall is
// true, so subscribers never download the ~6–10 KB fake-candidate payload.

// ── Helpers ──────────────────────────────────────────────────

function getInitials(name: string): string {
  return name.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase() ?? "").join("") || "?";
}

function fmtDaysAgo(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function isRoleType(value: string | null | undefined): value is RoleType {
  return !!value && value in ROLE_CFG;
}

/** Pull a 4-digit year out of "2021", "Jan 2021", "2021 – 2024", etc. */
function extractYear(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = value.match(/(19|20)\d{2}/);
  return m ? Number.parseInt(m[0], 10) : null;
}

/**
 * Derive total years of experience from a JSONB experience array.
 *   - Earliest start year → latest end year
 *   - "Present" or empty end falls back to current year
 *   - Returns null when no usable years can be parsed
 */
function deriveYears(
  experience: Array<{ start?: string; end?: string; dates?: string }> | null | undefined,
): number | null {
  if (!experience || experience.length === 0) return null;
  const now = new Date().getFullYear();
  const starts: number[] = [];
  const ends: number[] = [];
  for (const e of experience) {
    const s = extractYear(e.start) ?? extractYear(e.dates?.split(/[–-]/)[0]);
    if (s !== null) starts.push(s);
    if (e.end && /present/i.test(e.end)) {
      ends.push(now);
    } else {
      const en = extractYear(e.end) ?? extractYear(e.dates?.split(/[–-]/)[1]) ?? now;
      ends.push(en);
    }
  }
  if (starts.length === 0) return null;
  const earliest = Math.min(...starts);
  const latest   = ends.length > 0 ? Math.max(...ends) : now;
  return Math.max(0, latest - earliest);
}

function rowToCard(r: TalentRow): Card {
  const fullName = `${r.first_name} ${r.last_name ?? ""}`.trim();
  const type: RoleType = isRoleType(r.role_category) ? r.role_category : "Engineer";
  const skills = (r.skills ?? []).slice(0, 8);

  // Phase 4 Lean Projection: experience JSONB is no longer in the list payload.
  // Card-display fields that previously read from r.experience (latestExp title
  // and derivedYears) now fall back to r.job_title and r.years_experience.
  const derivedRole = r.job_title || "—";
  const derivedYears = r.years_experience ?? null;

  const score = Math.min(99, 70 + (derivedYears ?? 0) * 2 + skills.length);
  const available = (r.availability ?? "").toLowerCase().includes("available");
  const highlights = [
    r.work_type && r.work_type !== "Any" ? r.work_type : null,
    r.notice_period,
    r.work_location,
  ].filter(Boolean) as string[];
  return {
    id: r.id,
    name: fullName || "Unnamed",
    initials: getInitials(fullName),
    role: derivedRole,
    type,
    skills,
    location: [r.city, r.country].filter(Boolean).join(", ") || "—",
    exp: derivedYears != null ? `${derivedYears} years` : "—",
    yearsExperience: derivedYears,
    available,
    score,
    highlights,
    bio: r.summary ?? "",
    fullTime: (r.work_type ?? "").toLowerCase().includes("full"),
    partTime: (r.work_type ?? "").toLowerCase().includes("part"),
    contract: (r.work_type ?? "").toLowerCase().includes("contract"),
    remote:   (r.work_location ?? "").toLowerCase().includes("remote"),
    hybrid:   (r.work_location ?? "").toLowerCase().includes("hybrid"),
    onsite:   (r.work_location ?? "").toLowerCase().includes("onsite"),
    // Phase 4 Lean Projection: degree/institution/experience now populated
    // via fetchProfileDetail when ProfileModal opens. Left undefined here.
    lastActive: fmtDaysAgo(r.created_at),
    github: r.github_url,
    linkedin: r.linkedin_url,
    email: r.email,
    phone: r.phone,
    cvUrl: r.cv_url,
  };
}

// ── Inline SVG icons (verbatim from HTML btRenderList SVGs) ──

function GhSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="GitHub">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function LiSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="LinkedIn">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// ── btScore() helper — verbatim from HTML ────────────────────

export function BtMatchBadge({ score }: { score: number }) {
  const c = score >= 95 ? "#49D7A7" : score >= 90 ? "#60a5fa" : "#fb923c";
  return (
    <div
      className="bt-match-badge"
      style={{ background: `${c}12`, borderColor: `${c}40`, color: c }}
    >
      <svg width="8" height="8" viewBox="0 0 10 10" fill={c} role="img" aria-label="Match score">
        <polygon points="5,0 6.2,3.8 10,3.8 7,6.1 8.1,10 5,7.6 1.9,10 3,6.1 0,3.8 3.8,3.8" />
      </svg>
      {score}%
    </div>
  );
}

// ── Card item (matches .bt-cand-card structure exactly) ──────

export type EffectiveContact = {
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  cvUrl: string | null;
  github: string | null;
};

// Phase 4 D1: memoized. With useCallback'd handlers + stable c/saved/flag props
// per candidate, typing in the search input no longer re-renders every card —
// only cards whose isUnlocking/isSaving/isViewingCv actually flip will repaint.
const CardItem = memo(function CardItem({
  c,
  saved,
  onView,
  onSave,
  onLocked,
  onViewCv,
  index,
  isUnlocked,
  canUnlock,
  onUnlock,
  effectiveContact,
  isUnlocking = false,
  isSaving = false,
  isViewingCv = false,
}: {
  c: Card;
  saved: boolean;
  onView: () => void;
  onSave: () => void;
  onLocked: () => void;
  onViewCv: () => void;
  index: number;
  isUnlocked: boolean;
  canUnlock: boolean;
  onUnlock: () => void;
  effectiveContact: EffectiveContact;
  isUnlocking?: boolean;
  isSaving?: boolean;
  isViewingCv?: boolean;
}) {
  const cfg = ROLE_CFG[c.type];
  return (
    <div
      className="bt-cand-card"
      onClick={onView}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open profile for ${c.name || "candidate"}`}
      style={{ animation: `btFadeIn .35s ease ${index * 0.04}s both` }}
    >
      <div className="bt-card-left">
        <div className="bt-cand-row1">
          <span className="bt-cand-name">{c.name}</span>
          <span
            className="bt-role-badge"
            style={{ color: cfg.c, borderColor: cfg.b, background: cfg.bg }}
          >
            {cfg.label}
          </span>
          <span className={c.available ? "bt-avail-yes" : "bt-avail-no"}>
            {c.available ? "● Available" : "○ Unavailable"}
          </span>
          <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#888", fontFamily: "'DM Sans',sans-serif" }}>
            {c.lastActive}
          </span>
        </div>
        <div className="bt-cand-row2">
          {c.role} · <span aria-hidden="true">📍</span> {c.location} · {c.exp} exp
        </div>
        {c.bio && <div className="bt-cand-bio">{c.bio}</div>}
        <div className="bt-skills-row">
          {c.skills.map((s) => (
            <span key={s} className="bt-skill-tag">{s}</span>
          ))}
        </div>
        {c.highlights.length > 0 && (
          <div className="bt-highlights-row">
            {c.highlights.map((h) => (
              <span key={h} className="bt-hl-tag"><span aria-hidden="true">✦</span> {h}</span>
            ))}
          </div>
        )}
        <div className="bt-card-links" onClick={(e) => e.stopPropagation()} role="presentation">
          {/* GitHub — always available if present (Q11: not stripped) */}
          {c.github && (
            isUnlocked ? (
              <a
                className="bt-clink"
                href={ensureHttpUrl(effectiveContact.github ?? c.github) ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
              >
                <GhSvg />
                GitHub
              </a>
            ) : canUnlock ? (
              <button
                type="button"
                className="bt-clink"
                onClick={onUnlock}
                title="Use 1 credit to unlock all contact details"
              >
                <GhSvg />
                GitHub <span style={{ opacity: 0.7, fontSize: "0.7rem" }}>· 1 credit</span>
              </button>
            ) : (
              <button type="button" className="bt-clink" onClick={onLocked}>
                <GhSvg />
                GitHub
              </button>
            )
          )}
          {/* LinkedIn */}
          {isUnlocked && effectiveContact.linkedin ? (
            <a
              className="bt-clink"
              href={ensureHttpUrl(effectiveContact.linkedin) ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              <LiSvg />
              LinkedIn
            </a>
          ) : canUnlock ? (
            <button
              type="button"
              className="bt-clink"
              onClick={onUnlock}
              title="Use 1 credit to unlock all contact details"
            >
              <LiSvg />
              LinkedIn <span style={{ opacity: 0.7, fontSize: "0.7rem" }}>· 1 credit</span>
            </button>
          ) : (
            <button type="button" className="bt-clink" onClick={onLocked}>
              <LiSvg />
              LinkedIn
            </button>
          )}
          {/* Resume */}
          {isUnlocked && effectiveContact.cvUrl ? (
            <button
              type="button"
              className="bt-clink"
              onClick={onViewCv}
              disabled={isViewingCv}
              style={{ minWidth: 100 }}
              aria-busy={isViewingCv}
            >
              {isViewingCv ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading CV" /> : "Resume ✦"}
            </button>
          ) : canUnlock ? (
            <button
              type="button"
              className="bt-clink"
              onClick={onUnlock}
              title="Use 1 credit to unlock all contact details"
              disabled={isUnlocking}
              style={{ minWidth: 120 }}
              aria-busy={isUnlocking}
            >
              {isUnlocking ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-label="Unlocking" />
              ) : (
                <>Resume <span style={{ opacity: 0.7, fontSize: "0.7rem" }}>· 1 credit</span></>
              )}
            </button>
          ) : (
            <button type="button" className="bt-clink" onClick={onLocked}>
              Resume ✦
            </button>
          )}
        </div>
      </div>
      <div className="bt-card-right">
        <BtMatchBadge score={c.score} />
        <button
          type="button"
          className="bt-view-btn"
          onClick={(e) => { e.stopPropagation(); onView(); }}
        >
          View Profile
        </button>
        <button
          type="button"
          className={cn("bt-save-btn", saved && "saved")}
          onClick={(e) => { e.stopPropagation(); onSave(); }}
          disabled={isSaving}
          style={{ minWidth: 88 }}
          aria-pressed={saved}
          aria-busy={isSaving}
          aria-label={saved ? "Saved — click to unsave" : "Save this candidate"}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Saving" />
          ) : saved ? "♥ Saved" : "♡ Save"}
        </button>
      </div>
    </div>
  );
});
CardItem.displayName = "CardItem";

// ── Profile modal (matches .bt-modal-overlay structure) ──────

export function ensureHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("http://") || url.startsWith("https://")
    ? url
    : `https://${url}`;
}

// Phase 4 Bundle C: ProfileModal moved to ./_profile-modal and dynamic-imported
// near the top of this file. Call site (<ProfileModal … />) is unchanged.

// ── Hero (mosaic background, verbatim from HTML #bth-wrap) ───

type HeroCard = {
  initials: string;
  name: string;
  role: string;
  skills: string[];
  avatarBg: string;
  avatarText: string;
  featured?: boolean;
};

const HERO_CARDS: HeroCard[] = [
  { initials: "AK", name: "Ayesha Khan", role: "Full-Stack Engineer · 5 yrs", skills: ["React", "Node.js", "AWS"], avatarBg: "#EDE8FF", avatarText: "#7E47FF", featured: true },
  { initials: "ZM", name: "Zain Malik",  role: "Product Designer · 4 yrs",   skills: ["Figma", "UX Research"],     avatarBg: "#D9F7ED", avatarText: "#1A8F65" },
  { initials: "SR", name: "Sara Raza",   role: "Data Analyst · 3 yrs",       skills: ["Python", "SQL", "Tableau"], avatarBg: "#EDFFD3", avatarText: "#4A7A10" },
];

// Mosaic constants — match the HTML's IIFE (size 80, gap 6, 7 rows).
const MOSAIC_TILE = 80;
const MOSAIC_GAP = 6;
const MOSAIC_ROWS = 7;

function Hero() {
  // Compute the number of mosaic columns based on the rendered width so the
  // pattern stretches edge-to-edge regardless of viewport. Mirrors the HTML
  // <script> at line 4129 — runs once on mount + on resize.
  const [cols, setCols] = useState(24); // SSR-safe default; recalculated on mount

  useEffect(() => {
    function recompute() {
      const w = window.innerWidth || 1440;
      setCols(Math.ceil((w + MOSAIC_GAP) / (MOSAIC_TILE + MOSAIC_GAP)));
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);

  return (
    <section id="bth-wrap">
      <div id="bth-mosaic" aria-hidden>
        {Array.from({ length: MOSAIC_ROWS }).flatMap((_, r) =>
          Array.from({ length: cols }).map((_unused, c) => (
            <div
              key={`tile-${r}-${c}`}
              style={{
                position: "absolute",
                width: MOSAIC_TILE,
                height: MOSAIC_TILE,
                borderRadius: 10,
                background: "#F8F4F1",
                left: c * (MOSAIC_TILE + MOSAIC_GAP),
                top: r * (MOSAIC_TILE + MOSAIC_GAP),
                zIndex: 0,
              }}
            />
          )),
        )}
      </div>

      <div className="bth-center">
        <h1 className="bth-heading">
          <span className="bth-accent">1M+</span> Talent Profiles,
          <br />
          Ready to Join Your Team
        </h1>
        <p className="bth-subtext">
          Browse 1M+ engineers, sales talent, and operators from best companies
          — find your next hire in hours, not weeks.
        </p>
      </div>

      <div className="bth-cards">
        <div className="bth-avail-pill">Available now</div>
        <div className="bth-cards-list">
          {HERO_CARDS.map((card) => (
            <div
              key={card.name}
              className={cn("bth-card", card.featured ? "bth-card-featured" : "bth-card-default")}
            >
              <div
                className="bth-avatar"
                style={{ background: card.avatarBg, color: card.avatarText }}
              >
                {card.initials}
              </div>
              <div className="bth-card-info">
                <div className="bth-card-name">{card.name}</div>
                <div className="bth-card-role">{card.role}</div>
                <div className="bth-card-skills">
                  {card.skills.map((s) => (
                    <span key={s} className="bth-skill-tag">{s}</span>
                  ))}
                </div>
              </div>
              <div className="bth-open-badge">
                <span className="bth-open-dot" />
                Open
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Main client component ────────────────────────────────────

export function BrowseClient({
  realProfiles,
  tier = "free",
  currentPage,
  totalPages,
  totalCount,
  pageSize,
  activeRole,
  activeQuery,
  activeSort,
  unlockedIds,
  creditsRemaining,
  isSavedView,
  savedIds,
}: {
  realProfiles: TalentRow[];
  tier?: "free" | "subscriber";
  currentPage: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  activeRole: "All" | "Engineer" | "SDR" | "CS" | "Design" | "Data" | "DevOps" | "QA" | "Marketing" | "Ops" | "Finance";
  activeQuery: string;
  activeSort: "match" | "name";
  unlockedIds: string[];
  creditsRemaining: number;
  isSavedView: boolean;
  savedIds: string[];
}) {
  const cards: Card[] = useMemo(() => {
    return realProfiles.map(rowToCard);
  }, [realProfiles]);

  const [searchInput, setSearchInput] = useState(activeQuery);
  const [localSavedIds, setLocalSavedIds] = useState<Set<string>>(() => new Set(savedIds));

  // Sync localSavedIds when the savedIds prop changes (page navigation, route refresh)
  useEffect(() => {
    setLocalSavedIds(new Set(savedIds));
  }, [savedIds]);

  const [openCard, setOpenCard] = useState<Card | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unlockedSet, setUnlockedSet] = useState<Set<string>>(() => new Set(unlockedIds));
  const [credits, setCredits] = useState<number>(creditsRemaining);
  const [unlockedContactData, setUnlockedContactData] = useState<Map<string, {
    email: string | null;
    phone: string | null;
    linkedinUrl: string | null;
    cvUrl: string | null;
  }>>(new Map());
  const [isPricingModalOpen, setIsPricingModalOpen] = useState(false);
  // K1/E3/F2: per-candidate in-flight tracking. Prevents double-click races
  // and powers per-button Loader2 spinners.
  const [unlockingIds, setUnlockingIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [viewingCvIds, setViewingCvIds] = useState<Set<string>>(new Set());
  // A2: persistent toast shown when a subscriber hits no_credits.
  const [outOfCreditsToast, setOutOfCreditsToast] = useState<boolean>(false);
  // B3/J2: persistent toast shown when the client tier prop disagrees with
  // the server-side tier (subscription cancelled mid-session).
  const [sessionStaleToast, setSessionStaleToast] = useState<boolean>(false);
  // Phase 4 Lean Projection: session-lifetime cache of full profile detail
  // (summary, experience, education). Populated by ensureProfileDetail on
  // first card open; persists until page refresh. loadingDetailIds tracks
  // in-flight fetches so the modal can render skeletons.
  const [profileDetailCache, setProfileDetailCache] = useState<Map<string, ProfileDetail>>(
    new Map(),
  );
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set());

  // Sync unlock state when server props change (pagination/filter navigation).
  // Merge unlockedContactData instead of replacing it so client-side unlock results
  // survive re-renders. Only drop entries that are no longer in unlockedIds.
  useEffect(() => {
    const newSet = new Set(unlockedIds);
    setUnlockedSet(newSet);
    setCredits(creditsRemaining);
    setUnlockedContactData((prev) => {
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!newSet.has(id)) {
          next.delete(id);
        }
      }
      return next;
    });
  }, [unlockedIds, creditsRemaining]);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const buildUrl = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    // Any filter/sort/search change resets page to 1
    if (!("page" in updates)) {
      params.delete("page");
    }
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [searchParams, pathname]);

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    router.push(buildUrl(updates));
  }, [router, buildUrl]);

  // ESC closes the modal
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenCard(null);
        setDrawerOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Ref-counted body scroll lock — shared counter so opening a card while
  // the filter drawer is open keeps scroll locked until both close.
  useBodyScrollLock(Boolean(openCard));
  useBodyScrollLock(drawerOpen);
  // Phase 5 A6: trap Tab inside the filter drawer while it's open so keyboard
  // users can't accidentally tab into the background page behind it.
  const filterDrawerRef = useRef<HTMLElement>(null);
  useFocusTrap(filterDrawerRef, drawerOpen);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Sync the search input value when the activeQuery prop changes (e.g. user
  // clears the URL, navigates back, or another route updates ?q=).
  useEffect(() => {
    setSearchInput(activeQuery);
  }, [activeQuery]);

  // Debounced search: 300ms after the last keystroke, push the typed value
  // to the URL (which triggers a server re-render with the new filter).
  useEffect(() => {
    if (searchInput === activeQuery) return;
    const handle = setTimeout(() => {
      updateUrl({ q: searchInput || null });
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, activeQuery, updateUrl]);

  // Phase 4 Lean Projection: lazy-load the full profile detail. Idempotent —
  // cache hit / in-flight short-circuit. Called from handleOpenCard below.
  const ensureProfileDetail = useCallback(
    async (candidateId: string): Promise<void> => {
      if (profileDetailCache.has(candidateId)) return;
      if (loadingDetailIds.has(candidateId)) return;
      setLoadingDetailIds((prev) => {
        const next = new Set(prev);
        next.add(candidateId);
        return next;
      });
      try {
        const result = await fetchProfileDetail(candidateId);
        if (result.ok) {
          setProfileDetailCache((prev) => {
            const next = new Map(prev);
            next.set(candidateId, result.detail);
            return next;
          });
        }
        // On error: don't cache; modal renders without the extra detail.
      } finally {
        setLoadingDetailIds((prev) => {
          const next = new Set(prev);
          next.delete(candidateId);
          return next;
        });
      }
    },
    [profileDetailCache, loadingDetailIds],
  );

  // Phase 4 Lean Projection: opens the modal AND fires the detail fetch.
  // Fire-and-forget — modal renders immediately with list-projection data
  // (name, role, skills, location, bio, …) and skeleton-fills the detail
  // sections (experience, education) once fetchProfileDetail resolves.
  const handleOpenCard = useCallback(
    (card: Card) => {
      setOpenCard(card);
      void ensureProfileDetail(card.id);
    },
    [ensureProfileDetail],
  );

  // Phase 4 D1: useCallback so CardItem's memo comparison stays stable. Deps
  // are the values the body actually reads; useState setters are guaranteed
  // stable by React and intentionally omitted.
  const handleToggleSave = useCallback(async (candidateId: string) => {
    if (isFreeViewer(tier)) {
      setIsPricingModalOpen(true);
      return;
    }
    // F2: in-flight guard. Prevent TOCTOU race on rapid double-clicks.
    if (savingIds.has(candidateId)) return;
    setSavingIds((prev) => {
      const next = new Set(prev);
      next.add(candidateId);
      return next;
    });

    const wasSaved = localSavedIds.has(candidateId);

    setLocalSavedIds((prev) => {
      const next = new Set(prev);
      if (wasSaved) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });

    try {
      const result = await toggleSave(candidateId);

      if (!result.success) {
        // Revert optimistic UI.
        setLocalSavedIds((prev) => {
          const next = new Set(prev);
          if (wasSaved) next.add(candidateId);
          else next.delete(candidateId);
          return next;
        });

        // A1/F5: distinct error messages per error type.
        const errorStr = result.error ?? "";
        if (errorStr === "Subscription required") {
          setIsPricingModalOpen(true);
          return;
        }
        if (errorStr === "Not authenticated") {
          // B3/J2: client thinks subscriber but server says not authenticated → session stale.
          if (tier === "subscriber") {
            setSessionStaleToast(true);
          } else {
            setToast("Please sign in to save profiles.");
          }
          return;
        }
        const lower = errorStr.toLowerCase();
        if (errorStr === "Invalid candidate ID") {
          setToast("Invalid candidate. Please refresh.");
        } else if (lower.includes("too many save toggles")) {
          setToast("Slow down — too many save changes. Wait a moment.");
        } else if (lower.includes("could not check saved status")) {
          setToast("Could not verify saved status. Please try again.");
        } else if (lower.includes("could not unsave")) {
          setToast("Could not remove from saved. Please try again.");
        } else if (lower.includes("could not save")) {
          setToast("Could not save. Please try again.");
        } else {
          setToast("Could not update saved status.");
        }
      } else {
        setToast(wasSaved ? "Removed from saved" : "Saved to your list");
      }
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  }, [savingIds, localSavedIds, tier]);

  // Phase B-4: open pricing modal instead of toast for free/anonymous locked actions.
  // Subscribers should never hit this (their flow is handleUnlock). Free users
  // and admins-without-subscription land here and see the pricing modal.
  const handleLockedAction = () => {
    if (tier === "free") {
      setIsPricingModalOpen(true);
    } else {
      // A2: Subscriber out-of-credits → amber persistent toast with Upgrade link.
      setOutOfCreditsToast(true);
    }
  };

  const handleGetStartedFromModal = () => {
    setIsPricingModalOpen(false);
    // Auto-dismiss handled by the [toast] useEffect.
    setToast("🔒 Subscriptions coming soon — payment integration in progress.");
  };

  // Phase 4 D1: useCallback so CardItem's memo stays stable.
  const handleViewCv = useCallback(async (candidateId: string): Promise<void> => {
    // K1: in-flight guard + spinner. Ignore subsequent clicks while a previous
    // request is pending; spinner state lives in viewingCvIds.
    if (viewingCvIds.has(candidateId)) return;
    setViewingCvIds((prev) => {
      const next = new Set(prev);
      next.add(candidateId);
      return next;
    });

    try {
      const result = await getCvSignedUrl(candidateId);
      if (result.ok) {
        const win = window.open(result.url, "_blank", "noopener,noreferrer");
        if (!win) {
          setToast("Pop-up blocked. Allow pop-ups for this site to view CVs.");
        }
        return;
      }
      // B3/J2: client thinks subscriber but server says not authenticated → session stale.
      if (result.error === "not_authenticated" && tier === "subscriber") {
        setSessionStaleToast(true);
        return;
      }
      const errorMessages: Record<string, string> = {
        not_authenticated: "Please log in to view this CV.",
        not_unlocked: "Please unlock this candidate to view their CV.",
        cv_missing: "CV unavailable — please contact support.",
        internal_error: "Could not load CV. Please try again.",
      };
      setToast(errorMessages[result.error] ?? "Could not load CV. Please try again.");
    } finally {
      setViewingCvIds((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  }, [viewingCvIds, tier]);

  // Phase 4 D1: useCallback so CardItem's memo stays stable.
  const handleUnlock = useCallback(async (candidateId: string, candidateName: string): Promise<UnlockResult> => {
    // E3: in-flight guard. Atomic RPC prevents double-charge but the UI would
    // otherwise flicker on parallel requests. Return a placeholder result on
    // dedupe; the caller in BrowseClient doesn't use the return value.
    if (unlockingIds.has(candidateId)) {
      return {
        success: false,
        error: "rate_limited",
        message: "Already in progress.",
      } as UnlockResult;
    }
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
        setCredits(result.creditsRemaining);
        if (!result.alreadyUnlocked) {
          setToast(`✓ Unlocked ${candidateName} · ${result.creditsRemaining} credits left`);
        }
      } else {
        // A2: no_credits → dedicated persistent toast with [Upgrade plan] link.
        if (result.error === "no_credits") {
          setOutOfCreditsToast(true);
          return result;
        }
        // B3/J2: not_subscribed mid-session for a "subscriber" client → session stale.
        if (result.error === "not_subscribed" && tier === "subscriber") {
          setSessionStaleToast(true);
          return result;
        }
        setToast(`✗ ${result.message}`);
      }
      return result;
    } finally {
      setUnlockingIds((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  }, [unlockingIds, tier]);

  // B3/J2: on window focus, re-read tier server-side. If it disagrees with
  // the prop the page was rendered with, the user's subscription changed in
  // another tab/session — show the session-stale toast.
  useEffect(() => {
    if (tier !== "subscriber") return; // only matters for subscribers
    const handler = async () => {
      const fresh = await refreshTier();
      if (fresh.ok && fresh.tier !== tier) {
        setSessionStaleToast(true);
      }
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [tier]);

  function getEffectiveContact(c: Card): {
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    cvUrl: string | null;
    github: string | null;
  } {
    const local = unlockedContactData.get(c.id);
    if (local) {
      return {
        email: local.email,
        phone: local.phone,
        linkedin: local.linkedinUrl,
        cvUrl: local.cvUrl,
        github: c.github,
      };
    }
    return {
      email: c.email ?? null,
      phone: c.phone ?? null,
      linkedin: c.linkedin ?? null,
      cvUrl: c.cvUrl ?? null,
      github: c.github,
    };
  }

  const renderSidebarContent = (onSelect?: () => void) => (
    <>
      <div className="bt-sbox">
        <div className="bt-sbox-title">Talent Pool</div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Total Candidates</span>
          <span className="bt-pool-val" style={{ color: "#49D7A7" }}>50,000+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Engineers</span>
          <span className="bt-pool-val" style={{ color: "#60a5fa" }}>18,400+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">SDR / Sales</span>
          <span className="bt-pool-val" style={{ color: "#a78bfa" }}>12,000+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Customer Success</span>
          <span className="bt-pool-val" style={{ color: "#34d399" }}>9,800+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Designers</span>
          <span className="bt-pool-val" style={{ color: "#fb923c" }}>6,200+</span>
        </div>
        <div className="bt-pool-stat">
          <span className="bt-pool-label">Available Now</span>
          <span className="bt-pool-val" style={{ color: "#49D7A7" }}>31,200+</span>
        </div>
      </div>

      <div className="bt-sbox">
        <div className="bt-sbox-title">Role Type</div>
        {ROLE_FILTERS.map((r) => (
          <button
            key={r.key}
            type="button"
            className={cn("bt-role-chip", activeRole === r.key && "sel")}
            onClick={() => { updateUrl({ role: r.key === "All" ? null : r.key }); onSelect?.(); }}
            aria-pressed={activeRole === r.key}
          >
            <div className="bt-rc-left">
              <span className="bt-rc-dot" style={{ background: r.dot }} />
              <span className="bt-rc-name">{r.label}</span>
            </div>
            <span className="bt-rc-count">{r.count}</span>
          </button>
        ))}
      </div>
    </>
  );

  const isFiltered = activeRole !== "All" || activeQuery !== "";
  const visibleCards = cards;
  const shouldShowPaywall = tier === "free" && realProfiles.length > 0;

  // Phase 4 Bundle C: lazy-load the blurred preview data ONLY when this
  // viewer actually needs it (free tier hitting the paywall). The dynamic
  // import returns a Promise; we mirror it into state so the JSX can render
  // the cards once they're available. Subscribers never enter the effect.
  const [blurredCards, setBlurredCards] = useState<Card[] | null>(null);
  useEffect(() => {
    if (!shouldShowPaywall || blurredCards) return;
    let cancelled = false;
    import("./_blurred-preview").then((mod) => {
      if (!cancelled) setBlurredCards(mod.BLURRED_PREVIEW_CARDS);
    });
    return () => {
      cancelled = true;
    };
  }, [shouldShowPaywall, blurredCards]);
  const rangeStart = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, totalCount);
  const candidateWord = totalCount === 1 ? "candidate" : "candidates";

  return (
    <>
      <Navbar />
      <main className="bg-white">
        <Hero />

        <div className="bt-page-wrap">
          {/* ── SIDEBAR ── */}
          <aside className="bt-sidebar">
            {renderSidebarContent()}
          </aside>

          {/* ── MAIN ── */}
          <div className="bt-main">
            <div className="bt-mobile-toolbar">
              <button
                type="button"
                className="bt-filters-trigger"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open filters"
              >
                <span aria-hidden="true">☰</span>
                Filters
              </button>
            </div>
            <div className="bt-search-bar">
              <div className="bt-search-wrap">
                <span className="bt-search-icon">⌕</span>
                <input
                  className="bt-search-input"
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by name, role, or skill (e.g. React, Salesforce, Gainsight)..."
                  aria-label="Search candidates"
                />
              </div>
              <select
                className="bt-sort-select"
                value={activeSort}
                onChange={(e) => updateUrl({ sort: e.target.value === "name" ? "name" : null })}
                aria-label="Sort candidates"
              >
                <option value="match">Match Score</option>
                <option value="name">Name A-Z</option>
              </select>
            </div>

            <div className="bt-result-meta">
              <p className="bt-result-count">
                {totalCount === 0 ? (
                  <>No candidates found</>
                ) : (
                  <>
                    Showing <strong>{rangeStart}{rangeStart !== rangeEnd ? `–${rangeEnd}` : ""}</strong> of <strong>{totalCount.toLocaleString()}</strong> {candidateWord}
                    {isFiltered && <span className="bt-filtered-tag">(filtered)</span>}
                  </>
                )}
              </p>
              {tier === "subscriber" ? (
                <span className="bt-credit-counter">
                  💳 <strong>{credits}</strong> credits remaining
                </span>
              ) : (
                <span className="bt-unlock-hint"><span aria-hidden="true">🔒</span> Subscribe to unlock contact details</span>
              )}
            </div>

            {tier === "subscriber" && currentPage > 1 && (
              <div className="bt-prev-page">
                <button
                  type="button"
                  className="bt-prev-btn"
                  onClick={() => updateUrl({ page: currentPage === 2 ? null : String(currentPage - 1) })}
                >
                  ← Back to page {currentPage - 1}
                </button>
              </div>
            )}

            {isSavedView && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, padding: "16px 20px", background: "#fff", border: "1px solid #e8e0db", borderRadius: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 22 }} aria-hidden="true">❤️</span>
                    <h3 style={{ fontSize: 18, fontWeight: 500, margin: 0, color: "#111" }}>Saved profiles</h3>
                  </div>
                  <p style={{ fontSize: 13, color: "#666", margin: "4px 0 0 32px" }}>
                    Showing {realProfiles.length} saved candidate{realProfiles.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <Link href="/browse-talent" style={{ background: "#fff", color: "#7E47FF", border: "1px solid #d8d2f6", borderRadius: 999, padding: "10px 18px", fontSize: 13, fontWeight: 500, textDecoration: "none" }}>
                  ← Back to all candidates
                </Link>
              </div>
            )}

            <div className="bt-cand-list">
              {isSavedView && cards.length === 0 ? (
                <div className="bt-empty-state">
                  <div className="bt-empty-state-icon" aria-hidden="true">
                    ❤️
                  </div>
                  <h4 className="bt-empty-state-heading">Build your shortlist</h4>
                  <p className="bt-empty-state-subtext">
                    Click the heart icon on any candidate card to save them here for later review.
                  </p>
                  <Link href="/browse-talent" className="bt-empty-state-cta">
                    ← Browse all candidates
                  </Link>
                </div>
              ) : cards.length === 0 ? (
                <div className="bt-empty-state">
                  <div className="bt-empty-state-icon" aria-hidden="true">
                    <Search size={28} color="#7E47FF" />
                  </div>
                  <h4 className="bt-empty-state-heading">No candidates match</h4>
                  <p className="bt-empty-state-subtext" style={{ maxWidth: 400, marginLeft: "auto", marginRight: "auto" }}>
                    We couldn&apos;t find anyone matching your filters. Try different search terms or clear all filters.
                  </p>
                  <Link href={buildUrl({ q: null, role: null, view: null })} className="bt-empty-state-cta">
                    Clear all filters
                  </Link>
                </div>
              ) : (
                <>
                  {visibleCards.map((c, i) => (
                    <CardItem
                      key={c.id}
                      c={c}
                      saved={localSavedIds.has(c.id)}
                      onView={() => handleOpenCard(c)}
                      onSave={() => handleToggleSave(c.id)}
                      onLocked={handleLockedAction}
                      onViewCv={() => { void handleViewCv(c.id); }}
                      index={i}
                      isUnlocked={unlockedSet.has(c.id)}
                      canUnlock={tier === "subscriber" && credits > 0 && !unlockedSet.has(c.id)}
                      onUnlock={() => { void handleUnlock(c.id, c.name); }}
                      effectiveContact={getEffectiveContact(c)}
                      isUnlocking={unlockingIds.has(c.id)}
                      isSaving={savingIds.has(c.id)}
                      isViewingCv={viewingCvIds.has(c.id)}
                    />
                  ))}
                  {tier === "subscriber" && currentPage < totalPages && (
                    <div className="bt-load-more">
                      <button
                        type="button"
                        className="bt-load-btn"
                        onClick={() => updateUrl({ page: String(currentPage + 1) })}
                      >
                        Load more candidates
                      </button>
                      <p className="bt-load-note">
                        Page {currentPage} of {totalPages}
                      </p>
                    </div>
                  )}
                  {tier === "subscriber" && currentPage === totalPages && totalPages > 1 && (
                    <div className="bt-load-more">
                      <p className="bt-load-note">
                        You&apos;ve viewed all {totalCount} candidates · Page {currentPage} of {totalPages}
                      </p>
                    </div>
                  )}
                  {shouldShowPaywall && (
                    <div className="bt-blurred-section">
                      <div
                        className="bt-blurred-cards"
                        aria-hidden="true"
                        inert
                      >
                        {/* Phase 4 Bundle C: blurredCards arrives from a
                            dynamic import once shouldShowPaywall flips true.
                            Until it loads, the overlay still renders on its
                            own (the cards are decorative, behind a blur). */}
                        {(blurredCards ?? []).map((c, i) => (
                          <CardItem
                            key={`blur-${c.id}`}
                            c={c}
                            saved={false}
                            onView={() => {}}
                            onSave={() => {}}
                            onLocked={() => {}}
                            onViewCv={() => {}}
                            index={i + 15}
                            isUnlocked={false}
                            canUnlock={false}
                            onUnlock={() => {}}
                            effectiveContact={{ email: null, phone: null, linkedin: null, cvUrl: null, github: null }}
                            isUnlocking={false}
                            isSaving={false}
                            isViewingCv={false}
                          />
                        ))}
                      </div>
                      <div
                        className="bt-paywall-overlay"
                        role="region"
                        aria-label="Subscription required"
                      >
                        <div className="bt-paywall-icon" aria-hidden="true">🔒</div>
                        <div className="bt-paywall-title">10+ more candidates</div>
                        <div className="bt-paywall-sub">
                          Subscribe to unlock the full talent pool
                        </div>
                        <button
                          type="button"
                          className="bt-paywall-cta"
                          onClick={handleLockedAction}
                        >
                          Subscribe to View
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>
      </main>

      {drawerOpen && (
        <>
          <div
            className="bt-drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
            role="presentation"
          />
          <aside
            ref={filterDrawerRef}
            className="bt-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
          >
            <div className="bt-drawer-header">
              <span className="bt-drawer-title">Filters</span>
              <button
                type="button"
                className="bt-drawer-close"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close filters"
              >
                ×
              </button>
            </div>
            <div className="bt-drawer-body">
              {renderSidebarContent(() => setDrawerOpen(false))}
            </div>
            <div className="bt-drawer-footer">
              <button
                type="button"
                className="bt-drawer-apply"
                onClick={() => setDrawerOpen(false)}
              >
                Apply Filters
              </button>
            </div>
          </aside>
        </>
      )}

      {openCard && (
        <ProfileModal
          c={openCard}
          saved={localSavedIds.has(openCard.id)}
          tier={tier}
          isUnlocked={unlockedSet.has(openCard.id)}
          canUnlock={tier === "subscriber" && credits > 0 && !unlockedSet.has(openCard.id)}
          onUnlock={() => { void handleUnlock(openCard.id, openCard.name); }}
          effectiveContact={getEffectiveContact(openCard)}
          onSave={() => {
            const candidateId = openCard.id;
            setOpenCard(null);
            handleToggleSave(candidateId);
          }}
          onClose={() => setOpenCard(null)}
          onLocked={() => {
            setOpenCard(null);
            handleLockedAction();
          }}
          onViewCv={() => { void handleViewCv(openCard.id); }}
          isUnlocking={unlockingIds.has(openCard.id)}
          isSaving={savingIds.has(openCard.id)}
          isViewingCv={viewingCvIds.has(openCard.id)}
          detail={profileDetailCache.get(openCard.id) ?? null}
          isLoadingDetail={loadingDetailIds.has(openCard.id)}
        />
      )}

      {toast && (
        <div
          className="bt-toast"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {toast}
        </div>
      )}

      {outOfCreditsToast && (
        <div
          className="bt-toast"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          style={{
            bottom: 80,
            background: "#FEF3C7",
            color: "#78350F",
            border: "1px solid #FCD34D",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span>Out of credits this month.</span>
          <Link
            href="/pricing"
            style={{
              color: "#78350F",
              fontWeight: 600,
              textDecoration: "underline",
            }}
          >
            Upgrade plan
          </Link>
          <button
            type="button"
            onClick={() => setOutOfCreditsToast(false)}
            aria-label="Dismiss"
            style={{
              marginLeft: 4,
              background: "transparent",
              border: "none",
              color: "#78350F",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {sessionStaleToast && (
        <div
          className="bt-toast"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          style={{
            bottom: outOfCreditsToast ? 136 : 80,
            background: "#FEF3C7",
            color: "#78350F",
            border: "1px solid #FCD34D",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span>Your subscription has changed.</span>
          <button
            type="button"
            onClick={() => {
              setSessionStaleToast(false);
              router.refresh();
            }}
            style={{
              background: "#78350F",
              color: "#FEF3C7",
              border: "none",
              borderRadius: 6,
              padding: "4px 10px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSessionStaleToast(false)}
            aria-label="Dismiss"
            style={{
              marginLeft: 4,
              background: "transparent",
              border: "none",
              color: "#78350F",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      <PricingModal
        isOpen={isPricingModalOpen}
        onClose={() => setIsPricingModalOpen(false)}
        onGetStarted={handleGetStartedFromModal}
      />

    </>
  );
}
