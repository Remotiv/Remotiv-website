"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { Navbar } from "@/components/navbar";
import PricingModal from "@/components/pricing-modal";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { unlockCandidate, type UnlockResult } from "./actions";

// ── Types ────────────────────────────────────────────────────

export type TalentRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  job_title: string | null;
  role_category: string | null;
  years_experience: number | null;
  industry: string | null;
  degree: string | null;
  institution: string | null;
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
  experience: Array<{
    title?: string;
    company?: string;
    start?: string;
    end?: string;
    dates?: string;
    skills?: string[];
  }> | null;
  approved_at: string | null;
  created_at: string | null;
};

type RoleType =
  | "Engineer" | "SDR" | "CS" | "Design" | "Data"
  | "DevOps" | "QA" | "Marketing" | "Ops" | "Finance";

type ExperienceItem = {
  title: string;
  company: string;
  dates: string;
  skills: string[];
};

type Card = {
  id: string;
  name: string;
  initials: string;
  role: string;
  type: RoleType;
  skills: string[];
  location: string;
  exp: string;                    // "7 years" or "—"
  yearsExperience?: number | null; // numeric form for "X years experience in …"
  industry?: string | null;
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
  degree?: string | null;         // real-DB form
  institution?: string | null;    // real-DB form
  lastActive: string;
  github: string | null;
  linkedin: string | null;
  email?: string | null;          // admin preview only
  phone?: string | null;          // admin preview only
  cvUrl?: string | null;          // admin preview only
  experience?: ExperienceItem[];  // demo data only
};

// ── BT_ROLE_CFG (verbatim from HTML) ─────────────────────────

const ROLE_CFG: Record<RoleType, { c: string; bg: string; b: string; label: string }> = {
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

const BLURRED_PREVIEW_CARDS: Card[] = [
  {
    id: "preview-1",
    name: "Bilal R.",
    initials: "BR",
    role: "Senior Software Engineer",
    type: "Engineer",
    skills: ["React", "Node.js", "TypeScript", "AWS"],
    location: "Lahore, Pakistan",
    exp: "6 years",
    available: true,
    score: 92,
    highlights: ["6 yrs experience"],
    bio: "Full-stack engineer with strong product sense.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-2",
    name: "Hira S.",
    initials: "HS",
    role: "Product Designer",
    type: "Design",
    skills: ["Figma", "Design Systems", "User Research"],
    location: "Karachi, Pakistan",
    exp: "5 years",
    available: true,
    score: 88,
    highlights: ["Design systems lead"],
    bio: "Product designer focused on B2B SaaS workflows.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-3",
    name: "Usman K.",
    initials: "UK",
    role: "Sales Development Rep",
    type: "SDR",
    skills: ["HubSpot", "Salesforce", "Cold Outreach"],
    location: "Islamabad, Pakistan",
    exp: "3 years",
    available: true,
    score: 85,
    highlights: ["Top quota attainment"],
    bio: "SDR with consistent quota attainment.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-4",
    name: "Ayesha M.",
    initials: "AM",
    role: "Customer Success Manager",
    type: "CS",
    skills: ["Gainsight", "Onboarding", "QBRs"],
    location: "Multan, Pakistan",
    exp: "4 years",
    available: true,
    score: 90,
    highlights: ["NPS uplift"],
    bio: "CS lead specializing in onboarding US SaaS clients.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "2 days ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-5",
    name: "Tariq H.",
    initials: "TH",
    role: "Data Scientist",
    type: "Data",
    skills: ["Python", "TensorFlow", "SQL"],
    location: "Faisalabad, Pakistan",
    exp: "7 years",
    available: false,
    score: 94,
    highlights: ["ML in production"],
    bio: "Data scientist shipping ML pipelines at scale.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "1 week ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-6",
    name: "Sana A.",
    initials: "SA",
    role: "DevOps Engineer",
    type: "DevOps",
    skills: ["AWS", "Terraform", "Kubernetes"],
    location: "Lahore, Pakistan",
    exp: "5 years",
    available: true,
    score: 87,
    highlights: ["Cut infra cost 35%"],
    bio: "DevOps engineer reducing infra cost via automation.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-7",
    name: "Hassan I.",
    initials: "HI",
    role: "QA Automation Engineer",
    type: "QA",
    skills: ["Cypress", "Selenium", "Jest"],
    location: "Karachi, Pakistan",
    exp: "4 years",
    available: true,
    score: 82,
    highlights: ["80% test coverage"],
    bio: "QA engineer focused on automation frameworks.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-8",
    name: "Mehwish K.",
    initials: "MK",
    role: "Performance Marketing Lead",
    type: "Marketing",
    skills: ["Google Ads", "Meta Ads", "Analytics"],
    location: "Islamabad, Pakistan",
    exp: "6 years",
    available: true,
    score: 89,
    highlights: ["ROAS 4x+"],
    bio: "Performance marketer managing 6-figure ad budgets.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "3 days ago",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-9",
    name: "Faisal Q.",
    initials: "FQ",
    role: "Business Operations Manager",
    type: "Ops",
    skills: ["Notion", "Process Design", "OKRs"],
    location: "Lahore, Pakistan",
    exp: "8 years",
    available: true,
    score: 91,
    highlights: ["Scaled ops 5x"],
    bio: "Ops manager scaling startups from seed to Series B.",
    fullTime: true,
    partTime: false,
    remote: true,
    lastActive: "Today",
    github: null,
    linkedin: null,
  },
  {
    id: "preview-10",
    name: "Zainab N.",
    initials: "ZN",
    role: "Senior Accountant",
    type: "Finance",
    skills: ["QuickBooks", "Xero", "ACCA"],
    location: "Multan, Pakistan",
    exp: "5 years",
    available: true,
    score: 78,
    highlights: ["ACCA qualified"],
    bio: "ACCA-qualified accountant managing remote-client books.",
    fullTime: true,
    partTime: true,
    remote: true,
    lastActive: "Yesterday",
    github: null,
    linkedin: null,
  },
];

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
    const s = extractYear(e.start) ?? extractYear(e.dates?.split(/[–\-]/)[0]);
    if (s !== null) starts.push(s);
    if (e.end && /present/i.test(e.end)) {
      ends.push(now);
    } else {
      const en = extractYear(e.end) ?? extractYear(e.dates?.split(/[–\-]/)[1]) ?? now;
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

  // Derive role + years from the experience JSONB array (the form no longer
  // collects standalone job_title / years_experience / industry).
  // Latest entry = first item (form lists them top-to-bottom newest first).
  const expArr = Array.isArray(r.experience) ? r.experience : [];
  const latestExp = expArr[0];
  const derivedRole = latestExp?.title?.trim() || r.job_title || "—";
  const derivedYears = deriveYears(expArr) ?? r.years_experience ?? null;

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
    industry: r.industry,
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
    degree: r.degree,
    institution: r.institution,
    lastActive: fmtDaysAgo(r.created_at),
    github: r.github_url,
    linkedin: r.linkedin_url,
    email: r.email,
    phone: r.phone,
    cvUrl: r.cv_url,
    experience: Array.isArray(r.experience) && r.experience.length > 0
      ? r.experience.map((e) => ({
          title:   typeof e.title   === "string" ? e.title   : "",
          company: typeof e.company === "string" ? e.company : "",
          dates:   typeof e.dates   === "string" ? e.dates   : "",
          skills:  Array.isArray(e.skills) ? e.skills : [],
        }))
      : undefined,
  };
}

// ── Inline SVG icons (verbatim from HTML btRenderList SVGs) ──

function GhSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function LiSvg() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

// ── btScore() helper — verbatim from HTML ────────────────────

function BtMatchBadge({ score }: { score: number }) {
  const c = score >= 95 ? "#49D7A7" : score >= 90 ? "#60a5fa" : "#fb923c";
  return (
    <div
      className="bt-match-badge"
      style={{ background: `${c}12`, borderColor: `${c}40`, color: c }}
    >
      <svg width="8" height="8" viewBox="0 0 10 10" fill={c}>
        <polygon points="5,0 6.2,3.8 10,3.8 7,6.1 8.1,10 5,7.6 1.9,10 3,6.1 0,3.8 3.8,3.8" />
      </svg>
      {score}%
    </div>
  );
}

// ── Card item (matches .bt-cand-card structure exactly) ──────

type EffectiveContact = {
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  cvUrl: string | null;
  github: string | null;
};

function CardItem({
  c,
  saved,
  onView,
  onSave,
  onLocked,
  index,
  tier = "free",
  isAdmin = false,
  isUnlocked,
  canUnlock,
  onUnlock,
  effectiveContact,
}: {
  c: Card;
  saved: boolean;
  onView: () => void;
  onSave: () => void;
  onLocked: () => void;
  index: number;
  tier?: "free" | "subscriber";
  isAdmin?: boolean;
  isUnlocked: boolean;
  canUnlock: boolean;
  onUnlock: () => void;
  effectiveContact: EffectiveContact;
}) {
  const cfg = ROLE_CFG[c.type];
  return (
    <div
      className="bt-cand-card"
      onClick={onView}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onView(); } }}
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
          <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "#ccc", fontFamily: "'DM Sans',sans-serif" }}>
            {c.lastActive}
          </span>
        </div>
        <div className="bt-cand-row2">
          {c.role} · 📍 {c.location} · {c.exp} exp
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
              <span key={h} className="bt-hl-tag">✦ {h}</span>
            ))}
          </div>
        )}
        <div className="bt-card-links" onClick={(e) => e.stopPropagation()} role="presentation">
          {/* GitHub — always available if present (Q11: not stripped) */}
          {c.github && (
            (isAdmin || isUnlocked) ? (
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
          {(isAdmin || isUnlocked) && effectiveContact.linkedin ? (
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
          {(isAdmin || isUnlocked) && effectiveContact.cvUrl ? (
            <a
              className="bt-clink"
              href={effectiveContact.cvUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Resume ✦
            </a>
          ) : canUnlock ? (
            <button
              type="button"
              className="bt-clink"
              onClick={onUnlock}
              title="Use 1 credit to unlock all contact details"
            >
              Resume <span style={{ opacity: 0.7, fontSize: "0.7rem" }}>· 1 credit</span>
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
        >
          {saved ? "♥ Saved" : "♡ Save"}
        </button>
      </div>
    </div>
  );
}

// ── Profile modal (matches .bt-modal-overlay structure) ──────

function ensureHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("http://") || url.startsWith("https://")
    ? url
    : `https://${url}`;
}

function ProfileModal({
  c,
  saved,
  tier = "free",
  isAdmin = false,
  isUnlocked,
  canUnlock,
  onUnlock,
  effectiveContact,
  onSave,
  onClose,
  onLocked,
}: {
  c: Card;
  saved: boolean;
  tier?: "free" | "subscriber";
  isAdmin?: boolean;
  isUnlocked: boolean;
  canUnlock: boolean;
  onUnlock: () => void;
  effectiveContact: EffectiveContact;
  onSave: () => void;
  onClose: () => void;
  onLocked: () => void;
}) {
  const cfg = ROLE_CFG[c.type];

  // Resolve degree + institution from either the demo string ("Degree — School")
  // or the real-DB fields.
  let degree = "";
  let school = "";
  if (c.education) {
    const [d, s] = c.education.split("—");
    degree = d?.trim() ?? "";
    school = s?.trim() ?? "";
  } else {
    degree = c.degree ?? "";
    school = c.institution ?? "";
  }
  const hasEducation = Boolean(degree || school);
  const eduInline = c.education ?? [c.degree, c.institution].filter(Boolean).join(" — ");
  // Experience: always render the JSONB array if present. Empty array →
  // explicit "No work experience added" empty state.
  const hasExperienceArray = !!c.experience && c.experience.length > 0;

  return (
    <div
      className="bt-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="bt-modal-panel" onClick={(e) => e.stopPropagation()} role="presentation">
        {tier === "subscriber" && (
          <div className="bt-admin-banner" role="status">
            <span aria-hidden>🔓</span>
            Admin Preview — viewing unlocked content
          </div>
        )}
        <div className="bt-modal-header">
          <div>
            <div
              className="bt-modal-avatar"
              style={{ background: cfg.bg, borderColor: cfg.b, color: cfg.c }}
            >
              {c.initials}
            </div>
          </div>
          <div className="bt-modal-meta">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <div className="bt-modal-name">{c.name}</div>
              <BtMatchBadge score={c.score} />
            </div>
            <div className="bt-modal-role">{c.role}</div>
            <div className="bt-modal-info">
              📍 {c.location} · {c.exp} experience{eduInline ? ` · ${eduInline}` : ""}
            </div>
            <div className="bt-profile-links">
              {c.github && (
                (isAdmin || isUnlocked) ? (
                  <a
                    className="bt-plink"
                    href={ensureHttpUrl(effectiveContact.github ?? c.github) ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </a>
                ) : canUnlock ? (
                  <button type="button" className="bt-plink" onClick={onUnlock} title="Use 1 credit to unlock all contact details">
                    GitHub · 1 credit
                  </button>
                ) : (
                  <button type="button" className="bt-plink" onClick={onLocked}>GitHub</button>
                )
              )}
              {(isAdmin || isUnlocked) && effectiveContact.linkedin ? (
                <a
                  className="bt-plink"
                  href={ensureHttpUrl(effectiveContact.linkedin) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  LinkedIn
                </a>
              ) : canUnlock ? (
                <button type="button" className="bt-plink" onClick={onUnlock} title="Use 1 credit to unlock all contact details">
                  LinkedIn · 1 credit
                </button>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>LinkedIn</button>
              )}
              {(isAdmin || isUnlocked) && effectiveContact.cvUrl ? (
                <a
                  className="bt-plink"
                  href={effectiveContact.cvUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Resume ✦
                </a>
              ) : canUnlock ? (
                <button type="button" className="bt-plink" onClick={onUnlock} title="Use 1 credit to unlock all contact details">
                  Resume · 1 credit
                </button>
              ) : (
                <button type="button" className="bt-plink" onClick={onLocked}>Resume ✦</button>
              )}
            </div>
          </div>
          <button
            type="button"
            className="bt-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div className="bt-modal-body">
          {c.bio && (
            <>
              <div className="bt-modal-sec-title">Summary</div>
              <p
                style={{
                  margin: "0 0 20px",
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.85rem",
                  color: "#555",
                  lineHeight: 1.7,
                  whiteSpace: "pre-line",
                }}
              >
                {c.bio}
              </p>
            </>
          )}

          <div className="bt-modal-sec-title">Experience</div>
          <div style={{ marginBottom: 20 }}>
            {hasExperienceArray ? (
              c.experience?.map((exp, i) => (
                <div key={`${exp.company}-${i}`} className="bt-exp-item">
                  <div className="bt-exp-logo">🏢</div>
                  <div style={{ flex: 1 }}>
                    <div className="bt-exp-title">{exp.title}</div>
                    <div className="bt-exp-company">{exp.company}</div>
                    <div className="bt-exp-dates">{exp.dates}</div>
                    <div className="bt-exp-skills">
                      {(exp.skills ?? []).map((s, j) => (
                        <span key={`${s}-${j}`} className="bt-exp-skill">{s}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p
                style={{
                  margin: 0,
                  padding: "16px 18px",
                  border: "1px dashed rgba(0,0,0,0.1)",
                  borderRadius: 12,
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: "0.82rem",
                  color: "#aaa",
                  textAlign: "center",
                }}
              >
                No work experience added
              </p>
            )}
          </div>

          {hasEducation && (
            <>
              <div className="bt-modal-sec-title">Education</div>
              <div style={{ marginBottom: 20 }}>
                <div className="bt-edu-row">
                  {degree && <div className="bt-edu-degree">{degree}</div>}
                  {school && <div className="bt-edu-school">{school}</div>}
                </div>
              </div>
            </>
          )}

          <div className="bt-modal-sec-title">Skills</div>
          <div className="bt-modal-skills">
            {c.skills.map((s) => (
              <span key={s} className="bt-modal-skill">{s}</span>
            ))}
          </div>

          <div className="bt-modal-sec-title">Open To</div>
          <div className="bt-open-to" style={{ marginBottom: 20 }}>
            {c.fullTime && (
              <span className="bt-ot-tag" style={{ color: "#49D7A7", borderColor: "rgba(73,215,167,.3)", background: "rgba(73,215,167,.08)" }}>
                Full-time
              </span>
            )}
            {c.partTime && (
              <span className="bt-ot-tag" style={{ color: "#34d399", borderColor: "rgba(52,211,153,.3)", background: "rgba(52,211,153,.07)" }}>
                Part-time
              </span>
            )}
            {c.contract && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Contract
              </span>
            )}
            {c.remote && (
              <span className="bt-ot-tag" style={{ color: "#a78bfa", borderColor: "rgba(167,139,250,.3)", background: "rgba(167,139,250,.07)" }}>
                Remote
              </span>
            )}
            {c.hybrid && (
              <span className="bt-ot-tag" style={{ color: "#fb923c", borderColor: "rgba(251,146,60,.3)", background: "rgba(251,146,60,.07)" }}>
                Hybrid
              </span>
            )}
            {c.onsite && (
              <span className="bt-ot-tag" style={{ color: "#60a5fa", borderColor: "rgba(96,165,250,.3)", background: "rgba(96,165,250,.07)" }}>
                Onsite
              </span>
            )}
          </div>

          {(isAdmin || isUnlocked) ? (
            <div className="bt-unlocked-box">
              <div className="bt-unlocked-head">
                <span aria-hidden>🔓</span>
                <div>
                  <div className="bt-unlocked-title">Contact Details</div>
                  <div className="bt-unlocked-sub">Contact details unlocked</div>
                </div>
              </div>
              <div className="bt-unlocked-rows">
                {effectiveContact.email && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Email</span>
                    <a href={`mailto:${effectiveContact.email}`} className="bt-unlocked-link">{effectiveContact.email}</a>
                  </div>
                )}
                {effectiveContact.phone && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">Phone</span>
                    <a href={`tel:${effectiveContact.phone}`} className="bt-unlocked-link">{effectiveContact.phone}</a>
                  </div>
                )}
                {effectiveContact.linkedin && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">LinkedIn</span>
                    <a
                      href={ensureHttpUrl(effectiveContact.linkedin) ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bt-unlocked-link"
                    >
                      {effectiveContact.linkedin}
                    </a>
                  </div>
                )}
                {effectiveContact.cvUrl && (
                  <div className="bt-unlocked-row">
                    <span className="bt-unlocked-label">CV</span>
                    <a
                      href={effectiveContact.cvUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bt-unlocked-link"
                    >
                      View CV
                    </a>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bt-locked-box">
              <div className="bt-locked-icon">🔒</div>
              <div>
                <div className="bt-locked-title">Unlock Full Contact Details</div>
                <div className="bt-locked-sub">
                  {tier === "subscriber"
                    ? "Use 1 credit to reveal phone, email, LinkedIn, and CV"
                    : "Subscribe to view phone, email, LinkedIn, and references"}
                </div>
              </div>
            </div>
          )}

          <div className="bt-modal-actions">
            {!isAdmin && !isUnlocked && (
              canUnlock ? (
                <button
                  type="button"
                  className="bt-btn-unlock"
                  onClick={() => onUnlock()}
                >
                  Unlock contact · 1 credit
                </button>
              ) : tier === "free" ? (
                <button
                  type="button"
                  className="bt-btn-unlock"
                  onClick={() => { onClose(); onLocked(); }}
                >
                  Subscribe to Unlock
                </button>
              ) : (
                <div className="bt-out-of-credits">
                  <p>You&apos;ve used all your credits this month.</p>
                  <button
                    type="button"
                    className="bt-btn-unlock"
                    onClick={() => { onClose(); onLocked(); }}
                  >
                    Upgrade to Pro for 300 credits/month
                  </button>
                </div>
              )
            )}
            <button
              type="button"
              className={cn("bt-btn-save-modal", saved && "saved")}
              onClick={onSave}
            >
              {saved ? "♥ Saved" : "♡ Save Profile"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  isAdmin = false,
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
  isAdmin?: boolean;
  isSavedView: boolean;
  savedIds: string[];
}) {
  const cards: Card[] = useMemo(() => {
    return realProfiles.map(rowToCard);
  }, [realProfiles]);

  const [searchInput, setSearchInput] = useState(activeQuery);
  const [localSavedIds, setLocalSavedIds] = useState<Set<string>>(() => new Set(savedIds));
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

  // Sync unlock state when server props change (pagination/filter navigation).
  useEffect(() => {
    setUnlockedSet(new Set(unlockedIds));
    setCredits(creditsRemaining);
    setUnlockedContactData(new Map());
  }, [unlockedIds, creditsRemaining]);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const buildUrl = (updates: Record<string, string | null>) => {
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
  };

  const updateUrl = (updates: Record<string, string | null>) => {
    router.push(buildUrl(updates));
  };

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

  // Body scroll lock when modal open
  useEffect(() => {
    if (!openCard) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [openCard]);

  // Body scroll lock when drawer open
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, activeQuery]);

  const handleToggleSave = async (candidateId: string) => {
    // Free tier (or anonymous) → open pricing modal instead of saving
    if (tier === "free") {
      setIsPricingModalOpen(true);
      return;
    }
    const supabase = createClient();
    const isSaved = localSavedIds.has(candidateId);
    if (isSaved) {
      setLocalSavedIds((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
      await supabase.from("saved_profiles").delete().eq("candidate_id", candidateId);
      setToast("Removed from saved");
    } else {
      setLocalSavedIds((prev) => new Set(prev).add(candidateId));
      await supabase.from("saved_profiles").insert({ candidate_id: candidateId });
      setToast("✓ Saved");
    }
    setTimeout(() => setToast(null), 2500);
  };

  // Phase B-4: open pricing modal instead of toast for free/anonymous locked actions
  const handleLockedAction = () => {
    // Subscribers should never hit this (their flow is handleUnlock); admins bypass everything
    if (tier === "free") {
      setIsPricingModalOpen(true);
    } else {
      // Out-of-credits subscriber edge case → keep existing toast for clarity
      setToast("🔒 You're out of credits this month.");
      setTimeout(() => setToast(null), 3500);
    }
  };

  const handleGetStartedFromModal = () => {
    setIsPricingModalOpen(false);
    setToast("🔒 Subscriptions coming soon — payment integration in progress.");
    setTimeout(() => setToast(null), 3500);
  };

  const lockedAction = () => handleLockedAction();

  async function handleUnlock(candidateId: string, candidateName: string): Promise<UnlockResult> {
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
      setToast(`✗ ${result.message}`);
    }
    return result;
  }

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
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by name, role, or skill (e.g. React, Salesforce, Gainsight)..."
                />
              </div>
              <select
                className="bt-sort-select"
                value={activeSort}
                onChange={(e) => updateUrl({ sort: e.target.value === "name" ? "name" : null })}
              >
                <option value="match">Sort: Match Score</option>
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
              {isAdmin ? null : tier === "subscriber" ? (
                <span className="bt-credit-counter">
                  💳 <strong>{credits}</strong> credits remaining
                </span>
              ) : (
                <span className="bt-unlock-hint">🔒 Subscribe to unlock contact details</span>
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
                    <span style={{ fontSize: 22 }}>❤️</span>
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
                <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 12, padding: "48px 24px", textAlign: "center" }}>
                  <div style={{ width: 64, height: 64, margin: "0 auto 16px auto", borderRadius: "50%", background: "#EEEDFE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32 }}>
                    ❤️
                  </div>
                  <h4 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 8px 0", color: "#111" }}>Build your shortlist</h4>
                  <p style={{ fontSize: 14, color: "#666", margin: "0 0 24px 0", lineHeight: 1.5 }}>
                    Click the heart icon on any candidate card to save them here for later review.
                  </p>
                  <Link href="/browse-talent" style={{ background: "#7E47FF", color: "#fff", border: "none", borderRadius: 999, padding: "12px 24px", fontSize: 13, fontWeight: 600, textDecoration: "none", display: "inline-block" }}>
                    ← Browse all candidates
                  </Link>
                </div>
              ) : cards.length === 0 ? (
                <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 12, padding: "48px 24px", textAlign: "center" }}>
                  <div style={{ width: 64, height: 64, margin: "0 auto 16px auto", borderRadius: "50%", background: "#EEEDFE", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Search size={28} color="#7E47FF" />
                  </div>
                  <h4 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 8px 0", color: "#111" }}>No candidates match</h4>
                  <p style={{ fontSize: 14, color: "#666", margin: "0 0 24px 0", lineHeight: 1.5, maxWidth: 400, marginLeft: "auto", marginRight: "auto" }}>
                    We couldn&apos;t find anyone matching your filters. Try different search terms or clear all filters.
                  </p>
                  <Link href="/browse-talent" style={{ background: "#7E47FF", color: "#fff", border: "none", borderRadius: 999, padding: "12px 24px", fontSize: 13, fontWeight: 600, textDecoration: "none", display: "inline-block" }}>
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
                      onView={() => setOpenCard(c)}
                      onSave={() => handleToggleSave(c.id)}
                      onLocked={handleLockedAction}
                      index={i}
                      tier={tier}
                      isAdmin={isAdmin}
                      isUnlocked={unlockedSet.has(c.id)}
                      canUnlock={tier === "subscriber" && !isAdmin && credits > 0 && !unlockedSet.has(c.id)}
                      onUnlock={() => { void handleUnlock(c.id, c.name); }}
                      effectiveContact={getEffectiveContact(c)}
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
                        {BLURRED_PREVIEW_CARDS.map((c, i) => (
                          <CardItem
                            key={`blur-${c.id}`}
                            c={c}
                            saved={false}
                            onView={() => {}}
                            onSave={() => {}}
                            onLocked={() => {}}
                            index={i + 15}
                            tier={tier}
                            isAdmin={false}
                            isUnlocked={false}
                            canUnlock={false}
                            onUnlock={() => {}}
                            effectiveContact={{ email: null, phone: null, linkedin: null, cvUrl: null, github: null }}
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
          <aside className="bt-drawer" role="dialog" aria-label="Filters">
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
          isAdmin={isAdmin}
          isUnlocked={unlockedSet.has(openCard.id)}
          canUnlock={tier === "subscriber" && !isAdmin && credits > 0 && !unlockedSet.has(openCard.id)}
          onUnlock={() => { void handleUnlock(openCard.id, openCard.name); }}
          effectiveContact={getEffectiveContact(openCard)}
          onSave={() => handleToggleSave(openCard.id)}
          onClose={() => setOpenCard(null)}
          onLocked={handleLockedAction}
        />
      )}

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: 24,
            zIndex: 1000,
            background: "#111",
            color: "#fff",
            padding: "12px 16px",
            borderRadius: 12,
            fontFamily: "'DM Sans',sans-serif",
            fontSize: ".85rem",
            fontWeight: 500,
            boxShadow: "0 8px 32px rgba(0,0,0,.15)",
          }}
        >
          {toast}
        </div>
      )}

      <PricingModal
        isOpen={isPricingModalOpen}
        onClose={() => setIsPricingModalOpen(false)}
        onGetStarted={handleGetStartedFromModal}
      />

      {/* ─────────── Verbatim CSS from HTML <style> block ─────────── */}
      <style jsx global>{`
        /* ── Hero (mosaic background) — verbatim from HTML #page-browse ── */
        #bth-wrap {
          width: 100%;
          min-height: 596px;
          background: #FFFFFF;
          position: relative;
          overflow: hidden;
          box-sizing: border-box;
          isolation: isolate;
          z-index: 1;
        }
        #bth-mosaic {
          position: absolute;
          inset: 0;
          z-index: 0;
        }
        .bth-center {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }
        .bth-heading {
          font-family: 'Sora', sans-serif;
          font-size: 52px;
          font-weight: 700;
          line-height: 1.08;
          color: #111;
          margin-bottom: 20px;
          letter-spacing: -1.5px;
        }
        .bth-heading .bth-accent { color: #9886FE; }
        .bth-subtext {
          font-family: 'DM Sans', sans-serif;
          font-size: 16px;
          color: #888;
          line-height: 1.65;
          max-width: 520px;
          font-weight: 400;
          margin: 0;
        }
        .bth-cards {
          position: absolute;
          top: 50%;
          right: 40px;
          transform: translateY(-50%);
          width: 280px;
          z-index: 2;
        }
        .bth-avail-pill {
          position: absolute;
          top: -14px;
          left: 50%;
          transform: translateX(-50%);
          background: #7E47FF;
          color: #fff;
          font-size: 11px;
          font-family: 'DM Sans', sans-serif;
          font-weight: 600;
          border-radius: 20px;
          padding: 4px 14px;
          white-space: nowrap;
          z-index: 4;
        }
        .bth-cards-list { display: flex; flex-direction: column; gap: 10px; }
        .bth-card {
          background: #fff;
          border-radius: 14px;
          padding: 13px 15px;
          display: flex;
          align-items: center;
          gap: 11px;
        }
        .bth-card.bth-card-featured { border: 1.5px solid #c8b5ff; }
        .bth-card.bth-card-default  { border: 0.5px solid #e5e0da; }
        .bth-avatar {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          flex-shrink: 0;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-info { flex: 1; min-width: 0; }
        .bth-card-name {
          font-size: 13px;
          font-weight: 600;
          color: #1a1a1a;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-role {
          font-size: 11px;
          color: #aaa;
          margin-top: 1px;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-card-skills {
          display: flex;
          gap: 4px;
          margin-top: 5px;
          flex-wrap: wrap;
        }
        .bth-skill-tag {
          font-size: 10px;
          background: #F8F4F1;
          color: #777;
          border-radius: 4px;
          padding: 2px 6px;
          border: 0.5px solid #e5e0da;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-open-badge {
          display: flex;
          align-items: center;
          gap: 4px;
          background: #F0EBFF;
          color: #7E47FF;
          font-size: 10px;
          font-weight: 600;
          border-radius: 20px;
          padding: 3px 9px;
          flex-shrink: 0;
          font-family: 'DM Sans', sans-serif;
        }
        .bth-open-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #49D7A7;
          display: inline-block;
        }
        .bt-filters-trigger { display: none; }
        .bt-drawer-backdrop { display: none; }
        .bt-drawer { display: none; }
        @keyframes bt-drawer-in {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        @media (max-width: 1024px) {
          .bth-cards { display: none; }
          .bth-heading { font-size: 40px; }
        }

        .bt-page-wrap { display: grid; grid-template-columns: 240px 1fr; min-height: 80vh; background: #ffffff; position: relative; z-index: 1; }
        .bt-sidebar { border-right: 1px solid rgba(126,71,255,0.12); position: sticky; top: 80px; height: calc(100vh - 80px); overflow-y: auto; scrollbar-width: none; background: #ffffff; }
        .bt-sidebar::-webkit-scrollbar { display: none; }
        .bt-sbox { border-bottom: 1px solid rgba(126,71,255,0.08); padding: 16px 18px; }
        .bt-sbox-title { font-family: "DM Sans",sans-serif; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: #7E47FF; padding: 10px 0; display: flex; align-items: center; gap: 8px; }
        .bt-sbox-title::before { content: ""; width: 12px; height: 1px; background: #7E47FF; }
        .bt-pool-stat { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid rgba(0,0,0,0.04); }
        .bt-pool-stat:last-child { border-bottom: none; }
        .bt-pool-label { font-family: "DM Sans",sans-serif; font-size: 0.72rem; color: #777; }
        .bt-pool-val { font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 700; }
        .bt-role-chip { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 7px 8px; border: none; background: none; cursor: pointer; transition: background 0.15s; margin-bottom: 1px; border-radius: 8px; }
        .bt-role-chip:hover { background: rgba(126,71,255,0.07); }
        .bt-role-chip.sel { background: rgba(126,71,255,0.1); }
        .bt-rc-left { display: flex; align-items: center; gap: 8px; }
        .bt-rc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
        .bt-rc-name { font-family: "DM Sans",sans-serif; font-size: 0.78rem; color: #555; }
        .bt-role-chip.sel .bt-rc-name { color: #7E47FF; font-weight: 600; }
        .bt-rc-count { font-family: "DM Sans",sans-serif; font-size: 0.65rem; color: #aaa; background: rgba(0,0,0,0.04); padding: 1px 6px; border-radius: 4px; }
        .bt-role-chip.sel .bt-rc-count { color: #7E47FF; background: rgba(126,71,255,0.1); }
        .bt-main { padding: 28px 32px 80px; min-width: 0; background: #ffffff; }
        .bt-search-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; border-bottom: 1px solid rgba(126,71,255,0.1); padding-bottom: 16px; }
        .bt-search-wrap { flex: 1; position: relative; }
        .bt-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #aaa; pointer-events: none; font-size: 1rem; }
        .bt-search-input { width: 100%; padding: 11px 12px 11px 36px; border: 1px solid rgba(126,71,255,0.18); border-radius: 10px; background: #fff; color: #111; font-family: "DM Sans",sans-serif; font-size: 0.88rem; outline: none; transition: border-color 0.2s; }
        .bt-search-input:focus { border-color: #7E47FF; }
        .bt-search-input::placeholder { color: #bbb; }
        .bt-sort-select { padding: 11px 14px; border: 1px solid rgba(126,71,255,0.18); border-radius: 10px; background: #fff; color: #555; font-family: "DM Sans",sans-serif; font-size: 0.84rem; cursor: pointer; outline: none; }
        .bt-result-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .bt-result-count { font-family: "DM Sans",sans-serif; font-size: 0.82rem; color: #777; }
        .bt-result-count strong { color: #111; }
        .bt-filtered-tag {
          margin-left: 6px;
          font-family: "DM Sans",sans-serif;
          font-size: 0.75rem;
          font-style: italic;
          color: #9886fe;
        }
        .bt-unlock-hint { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #9886fe; }
        .bt-credit-counter {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.78rem;
          font-weight: 500;
          color: #7E47FF;
          background: rgba(126, 71, 255, 0.08);
          padding: 6px 14px;
          border-radius: 999px;
          border: 1px solid rgba(126, 71, 255, 0.2);
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }
        .bt-credit-counter strong {
          font-weight: 600;
          color: #7E47FF;
        }
        .bt-out-of-credits {
          display: flex;
          flex-direction: column;
          gap: 10px;
          align-items: stretch;
          padding: 14px;
          background: rgba(255, 200, 100, 0.08);
          border: 1px solid rgba(255, 200, 100, 0.25);
          border-radius: 12px;
          width: 100%;
        }
        .bt-out-of-credits p {
          font-family: 'DM Sans', sans-serif;
          font-size: 0.85rem;
          color: #555;
          margin: 0;
          text-align: center;
        }
        .bt-cand-list { display: flex; flex-direction: column; gap: 10px; }
        .bt-blurred-section {
          position: relative;
          margin-top: 12px;
        }
        .bt-blurred-cards {
          display: flex;
          flex-direction: column;
          gap: 10px;
          filter: blur(8px);
          opacity: 0.6;
          pointer-events: none;
          user-select: none;
        }
        .bt-paywall-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: linear-gradient(
            180deg,
            rgba(255,255,255,0.5) 0%,
            rgba(255,255,255,0.95) 35%,
            rgba(255,255,255,0.95) 65%,
            rgba(255,255,255,0.5) 100%
          );
          padding: 24px;
          text-align: center;
          border-radius: 16px;
        }
        .bt-paywall-icon { font-size: 28px; margin-bottom: 8px; }
        .bt-paywall-title {
          font-family: "Sora",sans-serif;
          font-size: 1.05rem;
          font-weight: 700;
          color: #111;
          margin-bottom: 4px;
        }
        .bt-paywall-sub {
          font-family: "DM Sans",sans-serif;
          font-size: 0.85rem;
          color: #555;
          margin-bottom: 14px;
          max-width: 280px;
        }
        .bt-paywall-cta {
          padding: 11px 22px;
          background: #7E47FF;
          color: #fff;
          border: none;
          border-radius: 10px;
          font-family: "DM Sans",sans-serif;
          font-size: 0.88rem;
          font-weight: 700;
          cursor: pointer;
        }
        .bt-paywall-cta:hover { background: #6f3aef; }
        .bt-cand-card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 16px; padding: 22px 24px; display: grid; grid-template-columns: 1fr auto; gap: 20px; cursor: pointer; transition: border-color 0.2s, box-shadow 0.2s, transform 0.18s; position: relative; overflow: hidden; }
        .bt-cand-card::before { content: ""; position: absolute; top: 0; left: 0; width: 3px; height: 0; background: #49D7A7; border-radius: 0 0 3px 3px; transition: height 0.28s; }
        .bt-cand-card:hover { border-color: #49D7A7; box-shadow: 0 8px 32px rgba(73,215,167,0.1); transform: translateY(-1px); }
        .bt-cand-card:hover::before { height: 100%; }
        .bt-card-right { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; min-width: 140px; flex-shrink: 0; }
        .bt-cand-row1 { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
        .bt-cand-name { font-family: "Sora",sans-serif; font-size: 1rem; font-weight: 700; color: #111; }
        .bt-role-badge { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 2px 9px; border: 1px solid; border-radius: 999px; }
        .bt-avail-yes { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; color: #49D7A7; }
        .bt-avail-no { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 600; color: #aaa; }
        .bt-cand-row2 { font-family: "DM Sans",sans-serif; font-size: 0.8rem; color: #888; margin-bottom: 8px; }
        .bt-cand-bio { font-size: 0.85rem; color: #555; line-height: 1.7; margin-bottom: 10px; }
        .bt-skills-row { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
        .bt-skill-tag { font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 500; padding: 3px 9px; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; color: #666; background: #f5f5f5; transition: all 0.15s; cursor: default; }
        .bt-skill-tag:hover { border-color: #49D7A7; color: #49D7A7; background: rgba(73,215,167,0.07); }
        .bt-highlights-row { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 10px; }
        .bt-hl-tag { font-family: "DM Sans",sans-serif; font-size: 0.68rem; font-weight: 600; color: #49D7A7; background: rgba(73,215,167,0.08); border: 1px solid rgba(73,215,167,0.25); padding: 2px 9px; border-radius: 6px; }
        .bt-card-links { display: flex; gap: 6px; flex-wrap: wrap; }
        .bt-clink { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 600; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; color: #888; background: transparent; transition: all 0.15s; cursor: pointer; }
        .bt-clink:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-clink svg { width: 11px; height: 11px; flex-shrink: 0; }
        .bt-match-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 700; border: 1px solid; border-radius: 8px; }
        .bt-view-btn { font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; padding: 9px 18px; background: #49D7A7; color: #111; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; white-space: nowrap; }
        .bt-view-btn:hover { background: #3bc495; }
        .bt-save-btn { font-family: "DM Sans",sans-serif; font-size: 0.75rem; font-weight: 500; color: #bbb; border: none; background: none; cursor: pointer; transition: color 0.18s; padding: 4px; }
        .bt-save-btn:hover { color: #49D7A7; }
        .bt-save-btn.saved { color: #49D7A7; }
        .bt-load-more { text-align: center; margin-top: 24px; padding-top: 20px; border-top: 1px solid rgba(126,71,255,0.1); }
        .bt-load-btn { font-family: "DM Sans",sans-serif; font-size: 0.82rem; font-weight: 600; padding: 12px 32px; border: 1.5px solid rgba(126,71,255,0.3); border-radius: 10px; background: transparent; color: #7E47FF; cursor: pointer; transition: all 0.18s; }
        .bt-load-btn:hover { border-color: #7E47FF; background: rgba(126,71,255,0.06); color: #7E47FF; }
        .bt-load-note { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #bbb; margin-top: 10px; }
        .bt-prev-page {
          text-align: left;
          margin-bottom: 16px;
          padding-bottom: 12px;
        }
        .bt-prev-btn {
          background: transparent;
          border: 1px solid rgba(126, 71, 255, 0.2);
          color: #7E47FF;
          padding: 8px 16px;
          border-radius: 8px;
          font-family: 'DM Sans', sans-serif;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .bt-prev-btn:hover {
          background: rgba(126, 71, 255, 0.05);
          border-color: rgba(126, 71, 255, 0.4);
        }
        .bt-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; z-index: 500; padding: 20px; }
        .bt-modal-panel { background: #fff; border: 1px solid rgba(0,0,0,0.1); border-radius: 20px; width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.15); }
        .bt-modal-panel::-webkit-scrollbar { width: 4px; }
        .bt-modal-panel::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }
        .bt-modal-header { padding: 24px 28px 20px; border-bottom: 1px solid rgba(0,0,0,0.07); display: flex; gap: 16px; align-items: flex-start; }
        .bt-modal-avatar { width: 52px; height: 52px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-family: "Sora",sans-serif; font-size: 1rem; font-weight: 700; flex-shrink: 0; border: 1px solid; }
        .bt-modal-meta { flex: 1; }
        .bt-modal-name { font-family: "Sora",sans-serif; font-size: 1.15rem; font-weight: 700; color: #111; }
        .bt-modal-role { font-family: "DM Sans",sans-serif; font-size: 0.82rem; color: #777; margin-bottom: 4px; }
        .bt-modal-info { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #aaa; }
        .bt-modal-close { width: 32px; height: 32px; background: rgba(0,0,0,0.05); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; cursor: pointer; font-size: 1.1rem; color: #888; display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0; }
        .bt-modal-close:hover { background: rgba(0,0,0,0.1); color: #111; }
        .bt-profile-links { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
        .bt-plink { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; font-family: "DM Sans",sans-serif; font-size: 0.72rem; font-weight: 600; border: 1px solid rgba(0,0,0,0.1); border-radius: 7px; color: #888; background: transparent; transition: all 0.15s; cursor: pointer; }
        .bt-plink:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-modal-body { padding: 22px 28px; }
        .bt-modal-sec-title { font-family: "DM Sans",sans-serif; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #49D7A7; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
        .bt-modal-sec-title::before { content: ""; width: 12px; height: 1px; background: #49D7A7; }
        .bt-exp-item { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
        .bt-exp-item:last-child { border-bottom: none; }
        .bt-exp-logo { width: 36px; height: 36px; background: #f5f5f5; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0; }
        .bt-exp-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #111; margin-bottom: 2px; }
        .bt-exp-company { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #777; }
        .bt-exp-dates { font-family: "DM Sans",sans-serif; font-size: 0.68rem; color: #bbb; margin-top: 2px; }
        .bt-exp-skills { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
        .bt-exp-skill { font-family: "DM Sans",sans-serif; font-size: 0.65rem; padding: 2px 7px; border: 1px solid rgba(0,0,0,0.1); border-radius: 5px; color: #888; background: #f8f8f8; }
        .bt-edu-row { padding: 10px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
        .bt-edu-row:last-child { border-bottom: none; }
        .bt-edu-degree { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #111; }
        .bt-edu-school { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #777; margin-top: 3px; }
        .bt-modal-skills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 20px; }
        .bt-modal-skill { font-family: "DM Sans",sans-serif; font-size: 0.75rem; padding: 4px 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 7px; color: #666; background: #f8f8f8; }
        .bt-open-to { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 20px; }
        .bt-ot-tag { font-family: "DM Sans",sans-serif; font-size: 0.68rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding: 3px 10px; border: 1px solid; border-radius: 6px; }
        .bt-locked-box { border: 1px solid rgba(73,215,167,0.25); background: rgba(73,215,167,0.05); padding: 16px 18px; border-radius: 12px; margin-bottom: 18px; display: flex; gap: 14px; align-items: center; }
        .bt-locked-icon { font-size: 1.5rem; flex-shrink: 0; }
        .bt-locked-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #49D7A7; margin-bottom: 3px; }
        .bt-locked-sub { font-family: "DM Sans",sans-serif; font-size: 0.75rem; color: #888; }

        .bt-admin-banner { display: flex; align-items: center; gap: 8px; padding: 10px 18px; font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; color: #1a4f3a; background: linear-gradient(90deg, rgba(73,215,167,0.18), rgba(73,215,167,0.08)); border-bottom: 1px solid rgba(73,215,167,0.3); }
        .bt-unlocked-box { border: 1px solid rgba(73,215,167,0.35); background: rgba(73,215,167,0.05); padding: 16px 18px; border-radius: 12px; margin-bottom: 18px; }
        .bt-unlocked-head { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px dashed rgba(73,215,167,0.3); }
        .bt-unlocked-head > span { font-size: 1.25rem; }
        .bt-unlocked-title { font-family: "Sora",sans-serif; font-size: 0.82rem; font-weight: 700; color: #1a9e73; }
        .bt-unlocked-sub { font-family: "DM Sans",sans-serif; font-size: 0.7rem; color: #888; margin-top: 2px; }
        .bt-unlocked-rows { display: flex; flex-direction: column; gap: 8px; }
        .bt-unlocked-row { display: flex; gap: 14px; align-items: baseline; font-family: "DM Sans",sans-serif; font-size: 0.78rem; }
        .bt-unlocked-label { flex: 0 0 64px; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #999; }
        .bt-unlocked-link { color: #1a9e73; font-weight: 600; word-break: break-all; }
        .bt-unlocked-link:hover { text-decoration: underline; }
        .bt-modal-actions { display: flex; gap: 8px; }
        .bt-btn-unlock { flex: 1; padding: 13px; font-family: "DM Sans",sans-serif; font-size: 0.82rem; font-weight: 700; background: #49D7A7; color: #111; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; }
        .bt-btn-unlock:hover { background: #3bc495; }
        .bt-btn-save-modal { padding: 13px 20px; font-family: "DM Sans",sans-serif; font-size: 0.78rem; font-weight: 600; background: transparent; color: #888; border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; cursor: pointer; transition: all 0.18s; }
        .bt-btn-save-modal:hover { border-color: #49D7A7; color: #49D7A7; }
        .bt-btn-save-modal.saved { color: #49D7A7; border-color: #49D7A7; }
        @keyframes btFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @media (max-width: 1024px) {
          .bt-page-wrap { grid-template-columns: 1fr; }
          .bt-sidebar { position: relative; top: 0; height: auto; border-right: none; border-bottom: 1px solid rgba(0,0,0,0.08); }
          .bt-sidebar { display: none; }
          .bt-mobile-toolbar { padding: 14px 0 10px; }
          .bt-filters-trigger {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 16px;
            background: #7E47FF;
            color: #fff;
            border: none;
            border-radius: 10px;
            font-family: "DM Sans",sans-serif;
            font-size: 0.85rem;
            font-weight: 600;
            cursor: pointer;
            min-height: 40px;
          }
          .bt-filters-trigger:hover {
            background: #6f3aef;
          }
          .bt-drawer-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 400;
          }
          .bt-drawer {
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            height: 100vh;
            height: 100dvh;
            width: 78%;
            max-width: 320px;
            background: #fff;
            z-index: 401;
            flex-direction: column;
            box-shadow: 4px 0 24px rgba(0,0,0,0.18);
            animation: bt-drawer-in 0.22s ease-out;
          }
          .bt-drawer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 14px 18px;
            border-bottom: 1px solid rgba(126,71,255,0.12);
          }
          .bt-drawer-title {
            font-family: "Sora",sans-serif;
            font-size: 0.95rem;
            font-weight: 700;
            color: #111;
          }
          .bt-drawer-close {
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.05);
            border: 1px solid rgba(0,0,0,0.1);
            border-radius: 8px;
            cursor: pointer;
            font-size: 1.1rem;
            color: #888;
          }
          .bt-drawer-body {
            flex: 1;
            overflow-y: auto;
          }
          .bt-drawer-footer {
            padding: 12px 18px;
            border-top: 1px solid rgba(126,71,255,0.12);
          }
          .bt-drawer-apply {
            width: 100%;
            padding: 13px;
            background: #7E47FF;
            color: #fff;
            border: none;
            border-radius: 10px;
            font-family: "DM Sans",sans-serif;
            font-size: 0.85rem;
            font-weight: 700;
            cursor: pointer;
          }
          .bt-drawer-apply:hover { background: #6f3aef; }
        }
        @media (max-width: 768px) {
          .bt-main { padding: 20px; }
          .bt-search-bar { flex-direction: column; }
          .bt-search-wrap { width: 100%; }
          .bt-cand-card { grid-template-columns: 1fr; }
          .bt-card-right { align-items: flex-start; flex-direction: row; flex-wrap: wrap; }
          #bth-wrap { min-height: 420px; }
          .bt-search-input { font-size: 16px; }
          .bt-sort-select { font-size: 16px; width: 100%; }
          .bt-result-meta { flex-direction: column; align-items: flex-start; gap: 6px; }
          .bt-role-chip { padding: 10px 8px; }
          .bt-save-btn { padding: 8px 12px; min-height: 40px; }
        }
        @media (max-width: 480px) {
          .bth-heading { font-size: 32px; letter-spacing: -1px; }
          .bt-cand-card { padding: 18px; }
          .bt-modal-header { padding: 18px 18px 16px; }
          .bt-modal-body { padding: 18px; }
          .bt-modal-close { width: 36px; height: 36px; }
          .bt-profile-links { flex-wrap: wrap; }
        }
      `}</style>
    </>
  );
}
