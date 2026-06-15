"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Clock,
  Globe,
  Lock,
  MapPin,
  MessageCircle,
  Search,
} from "lucide-react";
import HireRequestWizard from "./_hire-request-wizard";
import { LazyPhoto } from "@/components/lazy-photo";
import { TruncatedDescription } from "@/components/truncated-description";

// ── Types ────────────────────────────────────────────────────

type Job = {
  title: string;
  company: string;
  dates: string;
  description: string;
};

type Project = {
  title: string;
  role: string;
  description: string;
  url?: string;
};

type Language = { name: string; level: string };

type Education = { institution: string; degree: string; dates: string };

type Candidate = {
  id: string;
  initials: string;
  maskedName: string;
  location: string;
  localTime: string;
  jobTitle: string;
  bio: string;
  hourlyRate: number;
  availability: string;
  hours: string;
  workType: string;
  languages: Language[];
  verifications: string[];
  skills: string[];
  employmentHistory: Job[];
  education: Education;
  portfolio: Project[];
  photoUrl: string | null;
};

// ── Real-profile row shape (from hire_remote_profiles) ───────

export type RemoteProfileRow = {
  id: string;
  first_name: string;
  last_name: string;
  city: string | null;
  country: string | null;
  time_zone: string | null;
  job_titles: string | null;
  bio: string | null;
  hourly_rate: number | null;
  hours_per_week: string | null;
  work_type: string | null;
  availability: string | null;
  available_from_date: string | null;
  languages: unknown;
  email_verified: boolean | null;
  id_verified: boolean | null;
  phone_verified: boolean | null;
  photo_path: string | null;
  skills: unknown;
  employment_history: unknown;
  education: unknown;
  portfolio: unknown;
};

function localTimeIn(tz: string | null): string {
  if (!tz) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    })
      .format(new Date())
      .toLowerCase();
  } catch {
    return "";
  }
}

function rowToCandidate(row: RemoteProfileRow): Candidate {
  const firstInitial = (row.first_name?.[0] ?? "").toUpperCase();
  const lastInitial = (row.last_name?.[0] ?? "").toUpperCase();

  const fmtAvailability = (() => {
    const av = row.availability ?? "";
    if (av.toLowerCase().includes("future") && row.available_from_date) {
      return `Available from ${row.available_from_date}`;
    }
    return av || "Available Now";
  })();

  const verifications: string[] = [];
  if (row.email_verified) verifications.push("Email Verified");
  if (row.id_verified) verifications.push("ID Verified");
  if (row.phone_verified) verifications.push("Phone Verified");

  const languages: Language[] = Array.isArray(row.languages)
    ? (row.languages as Array<Record<string, unknown>>)
        .filter((l) => l && typeof l === "object")
        .map((l) => ({
          name: typeof l.name === "string" ? l.name : "",
          level: typeof l.level === "string" ? l.level : "",
        }))
        .filter((l) => l.name)
    : [];

  const skills: string[] = Array.isArray(row.skills)
    ? (row.skills as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const employmentHistory: Job[] = Array.isArray(row.employment_history)
    ? (row.employment_history as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          title:       typeof e.title       === "string" ? e.title       : "",
          company:     typeof e.company     === "string" ? e.company     : "",
          dates:       typeof e.dates       === "string" ? e.dates       : "",
          description: typeof e.description === "string" ? e.description : "",
        }))
    : [];

  const eduRaw = row.education;
  const education: Education =
    eduRaw && typeof eduRaw === "object"
      ? {
          institution:
            typeof (eduRaw as Record<string, unknown>).institution === "string"
              ? ((eduRaw as Record<string, unknown>).institution as string)
              : "",
          degree:
            typeof (eduRaw as Record<string, unknown>).degree === "string"
              ? ((eduRaw as Record<string, unknown>).degree as string)
              : "",
          dates:
            typeof (eduRaw as Record<string, unknown>).dates === "string"
              ? ((eduRaw as Record<string, unknown>).dates as string)
              : "",
        }
      : { institution: "", degree: "", dates: "" };

  const portfolio: Project[] = Array.isArray(row.portfolio)
    ? (row.portfolio as Array<Record<string, unknown>>)
        .filter((p) => p && typeof p === "object")
        .map((p) => ({
          title: typeof p.title === "string" ? p.title : "",
          role: typeof p.role === "string" ? p.role : "",
          description: typeof p.description === "string" ? p.description : "",
          url: typeof p.url === "string" ? p.url : undefined,
        }))
    : [];

  return {
    id: row.id,
    initials: `${firstInitial}${lastInitial}` || "?",
    maskedName: `${row.first_name} ${lastInitial}.`.trim(),
    location: [row.city, row.country].filter(Boolean).join(", "),
    localTime: localTimeIn(row.time_zone),
    jobTitle: row.job_titles ?? "",
    bio: row.bio ?? "",
    hourlyRate: row.hourly_rate ?? 0,
    availability: fmtAvailability,
    hours: row.hours_per_week ?? "",
    workType: row.work_type ?? "",
    languages,
    verifications,
    skills,
    employmentHistory,
    education,
    portfolio,
    photoUrl: (() => {
      const path = ((row as { photo_path?: string | null }).photo_path ?? "").trim();
      if (!path) return null;
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
      return base
        ? `${base}/storage/v1/object/public/talent_photos/${path}`
        : null;
    })(),
  };
}


// ── Helpers ──────────────────────────────────────────────────

const FILTER_ROLES = [
  "All Roles",
  "Engineer",
  "Designer",
  "Sales",
  "Customer Success",
  "Marketing",
  "Data",
  "DevOps",
] as const;

const EXP_FILTERS = ["Any", "0–2 yrs", "3–5 yrs", "6–10 yrs", "10+ yrs"] as const;
const AVAIL_FILTERS = ["Any", "Available Now", "Available Later"] as const;
const ENGLISH_FILTERS = ["Any", "Fluent", "Professional", "Basic"] as const;

// English-proficiency ordering used by the level filter. Higher = more fluent.
// KEEP IN SYNC with the trigger in migration 012 and the server route's
// ENGLISH_LEVEL_RANK constant (src/app/api/hire-remote/candidates/route.ts).
const ENGLISH_LEVEL_RANK: Record<string, number> = {
  Native: 4,
  Fluent: 3,
  Professional: 2,
  Basic: 1,
};

const TOAST_DURATION_MS = 2800;
const RATE_FILTER_MAX = 200;

// Debounce delay for free-text inputs and the rate slider before re-fetching
// from the server. ~350ms is the sweet spot found in /browse-talent — below
// ~300 feels jumpy while typing, above ~500 feels laggy.
const FILTER_DEBOUNCE_MS = 350;

const AVATAR_PALETTE = [
  { bg: "#EDE8FF", text: "#7E47FF" },
  { bg: "#D9F7ED", text: "#1A8F65" },
  { bg: "#FFEDD5", text: "#EA580C" },
  { bg: "#DBEAFE", text: "#2563EB" },
  { bg: "#FCE7F3", text: "#DB2777" },
  { bg: "#E0E7FF", text: "#4338CA" },
  { bg: "#EDFFD3", text: "#4A7A10" },
  { bg: "#CFFAFE", text: "#0E7490" },
];

function avatarColors(id: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length] ?? AVATAR_PALETTE[0];
}

function isAvailable(c: Candidate): boolean {
  return c.availability.toLowerCase().includes("available now");
}

// ── Avatar ───────────────────────────────────────────────────

function Avatar({ candidate, size }: { candidate: Candidate; size: number }) {
  const [errored, setErrored] = useState(false);
  const c = avatarColors(candidate.id);
  const showPhoto = Boolean(candidate.photoUrl) && !errored;

  if (showPhoto && candidate.photoUrl) {
    return (
      <LazyPhoto
        src={candidate.photoUrl}
        alt={candidate.maskedName || candidate.initials}
        size={size}
        rounded="full"
        onError={() => setErrored(true)}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-heading font-bold"
      style={{
        width: size,
        height: size,
        background: c.bg,
        color: c.text,
        fontSize: Math.max(11, size / 2.6),
      }}
    >
      {candidate.initials}
    </span>
  );
}

// ── Card ─────────────────────────────────────────────────────

const CandidateCard = memo(function CandidateCard({
  candidate,
  selected,
  compact,
  onSelect,
}: {
  candidate: Candidate;
  selected: boolean;
  compact: boolean;
  onSelect: (c: Candidate) => void;
}) {
  const available = isAvailable(candidate);
  const visibleSkills = candidate.skills.slice(0, compact ? 4 : 6);
  const extra = Math.max(0, candidate.skills.length - visibleSkills.length);

  return (
    <button
      type="button"
      onClick={() => onSelect(candidate)}
      aria-label={`View ${candidate.maskedName}'s profile, ${candidate.jobTitle}`}
      className={`group flex w-full flex-col gap-3 rounded-2xl border bg-white text-left shadow-[0_2px_10px_rgba(0,0,0,0.04)] motion-safe:transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)] active:scale-[0.98] active:opacity-90 ${
        selected
          ? "border-l-[3px] border-l-remotiv-green border-t-black/[0.06] border-r-black/[0.06] border-b-black/[0.06]"
          : "border-black/[0.06]"
      } ${compact ? "px-5 py-5" : "px-6 py-6"}`}
    >
      <div className="flex items-start gap-4">
        <Avatar candidate={candidate} size={compact ? 48 : 56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2 max-lg:flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`font-heading font-bold text-remotiv-text-dark ${compact ? "text-base" : "text-lg"}`}>
                {candidate.maskedName}
              </p>
              <span className="text-[12px] text-[#888]">· {candidate.location}</span>
            </div>
            <div className="shrink-0 text-right max-lg:flex max-lg:items-center max-lg:gap-2 max-lg:text-left">
              <p className="font-heading text-base font-extrabold text-remotiv-text-dark">${candidate.hourlyRate}/hr</p>
              {available ? (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-remotiv-green/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#1a9e73] max-lg:mt-0">
                  <span className="size-1.5 rounded-full bg-remotiv-green" />
                  Available Now
                </span>
              ) : (
                <span className="mt-1 inline-block rounded-full bg-[#f3f3f3] px-2.5 py-0.5 text-[10px] font-medium text-[#888] max-lg:mt-0">
                  {candidate.availability}
                </span>
              )}
            </div>
          </div>
          <p className="mt-1 truncate text-sm text-[#555]">{candidate.jobTitle}</p>
          <p className={`mt-2 ${compact ? "line-clamp-2" : "line-clamp-3"} text-[13px] leading-[1.7] text-[#666]`}>
            {candidate.bio}
          </p>
        </div>
      </div>

      {visibleSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {visibleSkills.map((s) => (
            <span
              key={s}
              className="rounded-md border border-black/[0.06] bg-[#f5f5f5] px-2 py-0.5 text-[11px] font-medium text-[#666]"
            >
              {s}
            </span>
          ))}
          {extra > 0 && (
            <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-400">
              +{extra}
            </span>
          )}
        </div>
      )}

      <div className="mt-1 flex items-center justify-end">
        <span className="inline-flex items-center justify-center rounded-xl border border-remotiv-green/40 px-3.5 py-1.5 text-xs font-semibold text-[#1a9e73] motion-safe:transition-all group-hover:bg-remotiv-green/10 group-active:scale-[0.98] group-active:opacity-90 max-lg:min-h-[40px] max-lg:px-4 max-lg:py-2">
          View Profile →
        </span>
      </div>
    </button>
  );
});

// ── Drawer (right column on desktop, full-screen modal on mobile) ────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[#1a9e73]">
        <span aria-hidden className="block h-px w-3 bg-remotiv-green" />
        {title}
      </p>
      {children}
    </section>
  );
}

function ProfileDrawer({
  candidate,
  onClose,
  onUnlock,
}: {
  candidate: Candidate;
  onClose: () => void;
  onUnlock: () => void;
}) {
  const c = avatarColors(candidate.id);
  const available = isAvailable(candidate);
  const [drawerPhotoErrored, setDrawerPhotoErrored] = useState(false);
  const showDrawerPhoto =
    Boolean(candidate.photoUrl) && !drawerPhotoErrored;

  const BIO_PREVIEW_CHARS = 250;
  const [bioExpanded, setBioExpanded] = useState(false);
  const candidateBio = candidate.bio ?? "";
  const isBioTruncatable = candidateBio.length > BIO_PREVIEW_CHARS;
  const bioPreview = isBioTruncatable
    ? `${candidateBio.slice(0, BIO_PREVIEW_CHARS).replace(/\s+\S*$/, "")}…`
    : candidateBio;
  const bioDisplay = bioExpanded ? candidateBio : bioPreview;
  return (
    <div className="flex flex-col gap-5 rounded-2xl lg:border lg:border-black/[0.06] lg:bg-white lg:p-6 lg:shadow-[0_4px_16px_rgba(0,0,0,0.05)] max-lg:p-0 max-lg:bg-transparent">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#666] motion-safe:transition-all hover:text-remotiv-text-dark active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3 max-lg:text-sm"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} />
          Back
        </button>
        <button
          type="button"
          onClick={onUnlock}
          className="inline-flex items-center gap-1.5 rounded-xl bg-remotiv-purple px-3.5 py-1.5 text-xs font-semibold text-white motion-safe:transition-all hover:opacity-90 active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3 max-lg:text-sm"
        >
          <MessageCircle className="size-3.5" strokeWidth={2} />
          Connect with Talent
        </button>
      </div>

      <div className="flex items-start gap-4">
        {showDrawerPhoto && candidate.photoUrl ? (
          <LazyPhoto
            src={candidate.photoUrl}
            alt={candidate.maskedName || candidate.initials}
            size={56}
            rounded="2xl"
            onError={() => setDrawerPhotoErrored(true)}
          />
        ) : (
          <span
            className="flex size-14 shrink-0 items-center justify-center rounded-2xl font-heading text-lg font-bold"
            style={{
              background: `linear-gradient(135deg, ${c.bg} 0%, #fff 120%)`,
              color: c.text,
              border: `1px solid ${c.bg}`,
            }}
          >
            {candidate.initials}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-heading text-lg font-bold text-remotiv-text-dark">{candidate.maskedName}</p>
          {available && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-remotiv-green/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[#1a9e73]">
              <span aria-hidden>⚡</span>
              Available Now
            </span>
          )}
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#888]">
            <MapPin className="size-3" strokeWidth={2} />
            {candidate.location}
            <span className="text-[#ccc]">·</span>
            <span>local time {candidate.localTime}</span>
          </p>
          <p className="mt-2 text-sm font-medium text-[#444]">{candidate.jobTitle}</p>
        </div>
      </div>

      <div className="rounded-xl bg-remotiv-green/8 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#1a9e73]">Hourly rate</p>
        <p className="font-heading text-2xl font-extrabold text-[#1a9e73]">${candidate.hourlyRate}/hr</p>
      </div>

      <p className="text-[13px] leading-[1.7] text-[#555]">{bioDisplay}</p>
      {isBioTruncatable && (
        <button
          type="button"
          onClick={() => setBioExpanded((v) => !v)}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-remotiv-purple underline"
          aria-expanded={bioExpanded}
        >
          {bioExpanded ? "Show less" : "Read more"}
        </button>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-black/[0.06] bg-[#f8f8f8] px-4 py-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#888]">
            <Clock className="size-3" strokeWidth={2} />
            Hours
          </p>
          <p className="mt-1 text-xs font-medium text-[#333]">{candidate.hours}</p>
          <p className="text-[11px] text-[#888]">{candidate.workType}</p>
        </div>
        <div className="rounded-xl border border-black/[0.06] bg-[#f8f8f8] px-4 py-3">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#888]">
            <Globe className="size-3" strokeWidth={2} />
            Languages
          </p>
          <div className="mt-1 flex flex-col gap-0.5">
            {candidate.languages.length > 0 ? (
              candidate.languages.map((l) => (
                <p key={l.name} className="text-xs font-medium text-[#333]">
                  {l.name} <span className="text-[#888]">· {l.level}</span>
                </p>
              ))
            ) : (
              <p className="text-xs text-[#aaa]">—</p>
            )}
          </div>
        </div>
      </div>

      {candidate.verifications.length > 0 && (
        <Section title="Verifications">
          <div className="flex flex-wrap gap-1.5">
            {candidate.verifications.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 rounded-full bg-remotiv-green/10 px-2.5 py-1 text-[10px] font-semibold text-[#1a9e73]"
              >
                <span aria-hidden="true">✓</span> {v}
              </span>
            ))}
          </div>
        </Section>
      )}

      {candidate.skills.length > 0 && (
        <Section title="Skills">
          <div className="flex flex-wrap gap-1.5">
            {candidate.skills.map((s) => (
              <span
                key={s}
                className="rounded-md border border-black/[0.06] bg-[#f5f5f5] px-2 py-0.5 text-[11px] font-medium text-[#666]"
              >
                {s}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title="Employment History">
        {candidate.employmentHistory.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            {candidate.employmentHistory.map((j, i) => (
              <div
                key={`${j.company}-${i}`}
                className="rounded-xl border-l-[3px] border-l-remotiv-purple bg-[#f8f8f8] px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-bold text-remotiv-text-dark">{j.title}</p>
                    <p className="text-xs text-[#777]">{j.company}</p>
                  </div>
                  <p className="shrink-0 text-right text-[10px] text-[#aaa]">{j.dates}</p>
                </div>
                <TruncatedDescription
                  text={j.description}
                  className="mt-2 text-[12px] leading-[1.65] text-[#555]"
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-black/10 px-3 py-3 text-center text-[11px] text-[#aaa]">
            No employment history added
          </p>
        )}
      </Section>

      <Section title="Education">
        <div className="rounded-xl bg-[#f8f8f8] px-4 py-3">
          <p className="font-heading text-sm font-bold text-remotiv-text-dark">{candidate.education.degree}</p>
          <p className="text-xs text-[#777]">{candidate.education.institution}</p>
          {candidate.education.dates && (
            <p className="mt-0.5 text-[10px] text-[#aaa]">{candidate.education.dates}</p>
          )}
        </div>
      </Section>

      <Section title="Portfolio">
        {candidate.portfolio.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            {candidate.portfolio.map((p, i) => (
              <div key={`${p.title}-${i}`} className="rounded-xl bg-[#f8f8f8] px-4 py-3">
                <p className="font-heading text-sm font-bold text-remotiv-text-dark">{p.title}</p>
                <p className="text-[11px] text-[#888]">{p.role}</p>
                <p className="mt-1 text-[12px] leading-[1.65] text-[#555]">{p.description}</p>
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-remotiv-purple hover:underline"
                  >
                    Visit Project →<span className="sr-only"> (opens in new tab)</span>
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl bg-[#f8f8f8] px-4 py-3 text-xs text-[#777]">
            Portfolio links unlock once you contact the candidate.
          </p>
        )}
      </Section>

      <div
        className="rounded-2xl px-5 py-5 text-white"
        style={{ background: "linear-gradient(135deg, var(--remotiv-purple) 0%, #5934C4 100%)" }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Lock className="size-4" strokeWidth={2} />
          <p className="font-heading text-sm font-bold">Unlock Contact Details</p>
        </div>
        <p className="mb-4 text-[12px] leading-[1.6] text-white/80">
          Connect with our team and we&apos;ll arrange an introduction.
        </p>
        <button
          type="button"
          onClick={onUnlock}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#111] px-5 py-3 font-heading text-sm font-bold text-white motion-safe:transition-all hover:opacity-90 active:scale-[0.98] active:opacity-90"
        >
          <MessageCircle className="size-4" strokeWidth={2} />
          Connect with Talent
        </button>
      </div>
    </div>
  );
}

// ── Filter Bar ───────────────────────────────────────────────

const SELECT_CLS =
  "h-11 cursor-pointer rounded-xl border border-black/[0.08] bg-white px-3.5 text-sm text-[#333] outline-none motion-safe:transition-colors focus:border-remotiv-purple";

function FilterBar({
  role, setRole,
  skills, setSkills,
  rate, setRate,
  exp, setExp,
  avail, setAvail,
  english, setEnglish,
  query, setQuery,
}: {
  role: string;     setRole:    (v: string) => void;
  skills: string;   setSkills:  (v: string) => void;
  rate: number;     setRate:    (v: number) => void;
  exp: string;      setExp:     (v: string) => void;
  avail: string;    setAvail:   (v: string) => void;
  english: string;  setEnglish: (v: string) => void;
  query: string;    setQuery:   (v: string) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="rounded-2xl bg-white p-3 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
      <div className="mb-2 flex items-center gap-2 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-filter-panel"
          className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs font-semibold text-[#333] motion-safe:transition-all active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3"
        >
          Filters {mobileOpen ? "▴" : "▾"}
        </button>
        <div className="flex flex-1 items-center gap-2 rounded-xl bg-[#f8f8f8] px-3">
          <Search className="size-4 text-[#aaa]" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search candidates"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-[#bbb]"
          />
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-black/[0.06] bg-white px-4 py-3 lg:hidden">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-[#666]">Rate</span>
          <span className="text-sm font-semibold text-remotiv-text-dark">${rate}/hr</span>
        </div>
        <input
          type="range"
          min={0}
          max={RATE_FILTER_MAX}
          value={rate}
          onChange={(e) => setRate(Number.parseInt(e.target.value, 10))}
          aria-label="Maximum hourly rate"
          aria-valuemin={0}
          aria-valuemax={RATE_FILTER_MAX}
          aria-valuenow={rate}
          className="w-full accent-remotiv-green"
        />
      </div>

      <div
        id="mobile-filter-panel"
        className={`grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center lg:gap-2 ${mobileOpen ? "" : "hidden lg:flex"}`}
      >
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Filter by role"
          className={`${SELECT_CLS} lg:w-36`}
        >
          {FILTER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>

        <input
          type="text"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
          placeholder="Skills"
          aria-label="Filter by skill"
          className={`${SELECT_CLS} placeholder:text-[#bbb] lg:w-32`}
        />

        <div className="hidden h-11 items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-3.5 lg:flex lg:w-64">
          <span className="whitespace-nowrap text-xs font-semibold text-[#666]">Rate:</span>
          <input
            type="range"
            min={0}
            max={RATE_FILTER_MAX}
            value={rate}
            onChange={(e) => setRate(Number.parseInt(e.target.value, 10))}
            aria-label="Maximum hourly rate"
            aria-valuemin={0}
            aria-valuemax={RATE_FILTER_MAX}
            aria-valuenow={rate}
            className="flex-1 accent-remotiv-green"
          />
          <span className="whitespace-nowrap text-xs font-bold text-remotiv-text-dark">${rate}/hr</span>
        </div>

        <select
          value={exp}
          onChange={(e) => setExp(e.target.value)}
          aria-label="Filter by experience"
          className={`${SELECT_CLS} lg:w-32`}
        >
          {EXP_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "Experience" : v}</option>)}
        </select>

        <select
          value={avail}
          onChange={(e) => setAvail(e.target.value)}
          aria-label="Filter by availability"
          className={`${SELECT_CLS} lg:w-36`}
        >
          {AVAIL_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "Availability" : v}</option>)}
        </select>

        <select
          value={english}
          onChange={(e) => setEnglish(e.target.value)}
          aria-label="Filter by English level"
          className={`${SELECT_CLS} lg:w-32`}
        >
          {ENGLISH_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "English Level" : v}</option>)}
        </select>

        <div className="hidden flex-1 min-w-0 items-center gap-2 rounded-xl bg-[#f8f8f8] px-3 lg:flex">
          <Search className="size-4 text-[#aaa]" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by role, skill, or keyword…"
            aria-label="Search candidates"
            className="h-11 flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-[#bbb]"
          />
        </div>
      </div>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────

function Toast({ msg }: { msg: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed z-[70] rounded-xl bg-[#111] px-4 py-3 font-sans text-sm font-medium text-white shadow-xl lg:bottom-6 lg:right-6 max-lg:bottom-4 max-lg:left-4 max-lg:right-4"
    >
      {msg}
    </div>
  );
}

// ── Debounce helper ──────────────────────────────────────────

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// ── Filter shape + helpers used by URL sync + fetch ──────────

type Filters = {
  role: string;
  skills: string;
  rate: number;
  exp: string;
  avail: string;
  english: string;
  q: string;
};

const DEFAULT_FILTERS: Filters = {
  role: "All Roles",
  skills: "",
  rate: RATE_FILTER_MAX,
  exp: "Any",
  avail: "Any",
  english: "Any",
  q: "",
};

function filtersFromSearchParams(sp: URLSearchParams): Filters {
  const rateRaw = Number.parseInt(sp.get("rate") ?? "", 10);
  return {
    role: sp.get("role") ?? DEFAULT_FILTERS.role,
    skills: sp.get("skills") ?? DEFAULT_FILTERS.skills,
    rate: Number.isFinite(rateRaw)
      ? Math.max(0, Math.min(rateRaw, RATE_FILTER_MAX))
      : DEFAULT_FILTERS.rate,
    exp: sp.get("exp") ?? DEFAULT_FILTERS.exp,
    avail: sp.get("avail") ?? DEFAULT_FILTERS.avail,
    english: sp.get("english") ?? DEFAULT_FILTERS.english,
    q: sp.get("q") ?? DEFAULT_FILTERS.q,
  };
}

function filtersAreDefault(f: Filters): boolean {
  return (
    f.role === DEFAULT_FILTERS.role &&
    f.skills === DEFAULT_FILTERS.skills &&
    f.rate === DEFAULT_FILTERS.rate &&
    f.exp === DEFAULT_FILTERS.exp &&
    f.avail === DEFAULT_FILTERS.avail &&
    f.english === DEFAULT_FILTERS.english &&
    f.q === DEFAULT_FILTERS.q
  );
}

function buildQueryString(f: Filters, page: number): string {
  const sp = new URLSearchParams();
  if (f.role !== DEFAULT_FILTERS.role) sp.set("role", f.role);
  if (f.skills) sp.set("skills", f.skills);
  if (f.rate < RATE_FILTER_MAX) sp.set("rate", String(f.rate));
  if (f.exp !== DEFAULT_FILTERS.exp) sp.set("exp", f.exp);
  if (f.avail !== DEFAULT_FILTERS.avail) sp.set("avail", f.avail);
  if (f.english !== DEFAULT_FILTERS.english) sp.set("english", f.english);
  if (f.q) sp.set("q", f.q);
  if (page > 1) sp.set("page", String(page));
  return sp.toString();
}

// ── Main ─────────────────────────────────────────────────────

export function HireMarketplace({
  initialCandidates,
  initialTotal,
}: {
  initialCandidates: RemoteProfileRow[];
  initialTotal: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Lazy init filter state from the URL on first render. Subsequent URL
  // changes do NOT re-init state (we own state and write back to the URL
  // via router.replace below).
  const initial = filtersFromSearchParams(new URLSearchParams(searchParams.toString()));

  const [role,    setRole]    = useState<string>(initial.role);
  const [skills,  setSkills]  = useState<string>(initial.skills);
  const [rate,    setRate]    = useState<number>(initial.rate);
  const [exp,     setExp]     = useState<string>(initial.exp);
  const [avail,   setAvail]   = useState<string>(initial.avail);
  const [english, setEnglish] = useState<string>(initial.english);
  const [query,   setQuery]   = useState<string>(initial.q);

  // Debounced versions used by the fetch + URL sync so dragging the slider
  // or typing into a text field doesn't fire one request per keystroke.
  const debouncedSkills = useDebounced(skills, FILTER_DEBOUNCE_MS);
  const debouncedRate   = useDebounced(rate,   FILTER_DEBOUNCE_MS);
  const debouncedQuery  = useDebounced(query,  FILTER_DEBOUNCE_MS);

  const [candidates, setCandidates] = useState<RemoteProfileRow[]>(initialCandidates);
  const [total,      setTotal]      = useState<number>(initialTotal);
  const [page,       setPage]       = useState<number>(1);
  const [loading,    setLoading]    = useState<boolean>(false);
  const [hasMore,    setHasMore]    = useState<boolean>(initialCandidates.length < initialTotal);

  const [selected,   setSelected]   = useState<Candidate | null>(null);
  const [toast,      setToast]      = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  // First focusable element inside the drawer panel (the "Back to candidates"
  // button) — gets focus when the drawer opens so keyboard + SR users land
  // inside the dialog instead of on body.
  const drawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  // Card button that opened the drawer — focus returns here on close so the
  // user lands back in the grid at the row they came from.
  const drawerTriggerRef = useRef<HTMLElement | null>(null);

  // OS-level reduced-motion preference. Evaluated once at mount. Used to
  // disable the drawer slide + dimming transitions for users who opted out
  // at the OS level (we still need the state changes to happen — just not
  // the animation between them).
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Request-ID guard: if a slower in-flight fetch resolves AFTER a newer one
  // we started, drop the stale result. Avoids the "type fast and see results
  // from your previous query" race. Counter pattern is safer than an
  // AbortController here (Strict-Mode double-effect can abort the first run
  // and starve the second — bit us on the AI-matching page before).
  const fetchIdRef = useRef(0);
  const isInitialMount = useRef(true);

  const fetchCandidates = useCallback(
    async (filters: Filters, nextPage: number, append: boolean): Promise<void> => {
      const reqId = ++fetchIdRef.current;
      setLoading(true);
      try {
        const qs = buildQueryString(filters, nextPage);
        const url = `/api/hire-remote/candidates${qs ? `?${qs}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (reqId !== fetchIdRef.current) return;
        if (!res.ok) {
          setToast("Couldn't load candidates. Please try again.");
          return;
        }
        const json = (await res.json()) as {
          candidates?: RemoteProfileRow[];
          total?: number;
          hasMore?: boolean;
        };
        if (reqId !== fetchIdRef.current) return;

        const incoming = Array.isArray(json.candidates) ? json.candidates : [];
        const newTotal = typeof json.total === "number" ? json.total : 0;

        setCandidates((prev) => (append ? [...prev, ...incoming] : incoming));
        setTotal(newTotal);
        setHasMore(Boolean(json.hasMore));
      } catch {
        if (reqId !== fetchIdRef.current) return;
        setToast("Couldn't load candidates. Please try again.");
      } finally {
        if (reqId === fetchIdRef.current) setLoading(false);
      }
    },
    [],
  );

  // Filter-change effect: when any of the (debounced) filter values change,
  // reset to page 1 and replace results. The first mount skips this — the
  // SSR data in initialCandidates already matches the default filters, and
  // re-fetching the same query would be wasted work. If the URL specified
  // non-default filters, we still need a fetch (SSR loaded defaults), so
  // we only skip when the initial filters are the defaults.
  useEffect(() => {
    const current: Filters = {
      role,
      skills: debouncedSkills,
      rate: debouncedRate,
      exp,
      avail,
      english,
      q: debouncedQuery,
    };

    if (isInitialMount.current) {
      isInitialMount.current = false;
      // SSR already loaded page 1 with default filters. If the URL params
      // match the defaults, the initial data is correct — no fetch needed.
      if (filtersAreDefault(current)) {
        return;
      }
    }

    // Sync URL (replace so the back button doesn't step through every
    // keystroke). scroll: false stops Next from jumping to the top of the
    // page on every filter change.
    const qs = buildQueryString(current, 1);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });

    setPage(1);
    fetchCandidates(current, 1, false);
  }, [
    role,
    debouncedSkills,
    debouncedRate,
    exp,
    avail,
    english,
    debouncedQuery,
    pathname,
    router,
    fetchCandidates,
  ]);

  function loadMore(): void {
    if (loading || !hasMore) return;
    const current: Filters = {
      role,
      skills: debouncedSkills,
      rate: debouncedRate,
      exp,
      avail,
      english,
      q: debouncedQuery,
    };
    const next = page + 1;
    setPage(next);
    fetchCandidates(current, next, true);
  }

  function clearFilters(): void {
    setRole(DEFAULT_FILTERS.role);
    setSkills(DEFAULT_FILTERS.skills);
    setRate(DEFAULT_FILTERS.rate);
    setExp(DEFAULT_FILTERS.exp);
    setAvail(DEFAULT_FILTERS.avail);
    setEnglish(DEFAULT_FILTERS.english);
    setQuery(DEFAULT_FILTERS.q);
    // The filter-change effect above will pick up the state reset and re-fetch.
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!selected) return;
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
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selected]);

  const handleSelect = useCallback((candidate: Candidate) => {
    // Capture the triggering card so we can restore focus on close.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    drawerTriggerRef.current =
      active instanceof HTMLElement ? active : null;
    setSelected(candidate);
  }, []);

  function handleClose() {
    setSelected(null);
    // Return focus to the card that opened the drawer so keyboard users
    // don't fall to <body>. 50ms gives React a tick to unmount the drawer.
    const target = drawerTriggerRef.current;
    if (target) {
      setTimeout(() => target.focus(), 50);
    }
  }

  // Move focus into the drawer when it opens so SR users hear the dialog
  // announcement and keyboard users land inside instead of on body. 100ms
  // covers the slide-in transition.
  useEffect(() => {
    if (selected === null) return;
    const t = setTimeout(() => drawerCloseButtonRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [selected]);

  function openWizard() {
    if (!selected) return;
    setWizardOpen(true);
  }

  const drawerOpen = selected !== null;
  const visibleCandidates = candidates.map(rowToCandidate);
  const showClearFilters = !filtersAreDefault({
    role,
    skills: debouncedSkills,
    rate: debouncedRate,
    exp,
    avail,
    english,
    q: debouncedQuery,
  });

  return (
    <section className="bg-[#f8f4f1] px-4 py-12 md:px-10">
      <div className="mx-auto max-w-7xl">
        <FilterBar
          role={role}       setRole={setRole}
          skills={skills}   setSkills={setSkills}
          rate={rate}       setRate={setRate}
          exp={exp}         setExp={setExp}
          avail={avail}     setAvail={setAvail}
          english={english} setEnglish={setEnglish}
          query={query}     setQuery={setQuery}
        />

        <div
          style={{
            opacity: drawerOpen ? 0.3 : 1,
            pointerEvents: drawerOpen ? "none" : "auto",
            transition: prefersReducedMotion ? "none" : "opacity 0.3s ease",
          }}
        >
          <div
            className="mt-6 flex items-baseline justify-between gap-3"
            aria-live="polite"
            aria-atomic="true"
          >
            <h2 className="font-heading text-base font-bold text-remotiv-text-dark">
              <span className="text-[#1a9e73]">{total}</span> professionals found
            </h2>
            <div className="flex items-center gap-3">
              {showClearFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs font-semibold text-remotiv-purple motion-safe:transition-colors hover:underline"
                >
                  Clear filters
                </button>
              )}
              <span className="text-xs text-[#888]">
                Showing {candidates.length} of {total}
              </span>
            </div>
          </div>

          <div
            className="mt-4 grid grid-cols-1 gap-6"
            style={{
              opacity: loading && candidates.length === 0 ? 0.5 : 1,
              transition: prefersReducedMotion ? "none" : "opacity 0.2s ease",
            }}
          >
            <div className="grid grid-cols-1 gap-4">
              {candidates.length === 0 ? (
                loading ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-white py-14 text-center text-sm text-[#aaa]">
                    Loading candidates…
                  </div>
                ) : total === 0 && filtersAreDefault({
                  role, skills: debouncedSkills, rate: debouncedRate, exp, avail, english, q: debouncedQuery,
                }) ? (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-white py-14 text-center">
                    <p className="text-sm font-medium text-[#666]">No talent available right now.</p>
                    <p className="mt-1 text-xs text-[#999]">Check back soon — new candidates are added regularly.</p>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-black/10 bg-white py-14 text-center text-sm text-[#aaa]">
                    No candidates match your filters.
                  </div>
                )
              ) : (
                visibleCandidates.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    selected={selected?.id === c.id}
                    compact={false}
                    onSelect={handleSelect}
                  />
                ))
              )}

              {hasMore && candidates.length > 0 && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loading}
                  aria-busy={loading || undefined}
                  className="mt-2 justify-self-center rounded-2xl border-[1.5px] border-remotiv-purple/30 bg-white px-8 py-3 font-heading text-sm font-semibold text-remotiv-purple motion-safe:transition-all hover:border-remotiv-purple hover:bg-remotiv-purple/[0.06] active:scale-[0.98] active:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? "Loading…" : "Load More Profiles"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {drawerOpen && (
        <button
          type="button"
          aria-label="Close profile"
          onClick={handleClose}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          style={{
            transition: prefersReducedMotion ? "none" : "opacity 0.3s ease",
          }}
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Candidate profile"
        aria-hidden={!drawerOpen}
        id="candidate-profile-drawer"
        className="p-6 max-lg:p-4"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(96%, 1100px)",
          background: "#fff",
          boxShadow: "-4px 0 20px rgba(0,0,0,0.08)",
          transform: drawerOpen ? "translateX(0)" : "translateX(110%)",
          transition: prefersReducedMotion
            ? "none"
            : "transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          zIndex: 50,
        }}
      >
        {selected && (
          <>
            <div
              className="sticky top-0 z-10 -mx-6 -mt-6 mb-4 border-b border-[#e8e0db] bg-white px-6 pb-3 pt-4 max-lg:-mx-4 max-lg:-mt-4 max-lg:px-4"
            >
              <button
                ref={drawerCloseButtonRef}
                type="button"
                onClick={handleClose}
                className="flex min-h-[44px] cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-2.5 font-sans text-sm font-medium text-remotiv-purple motion-safe:transition-all active:scale-[0.98] active:opacity-90"
                aria-label="Back to candidates"
              >
                <ArrowLeft size={18} />
                Back to candidates
              </button>
            </div>
            <ProfileDrawer
              candidate={selected}
              onClose={handleClose}
              onUnlock={openWizard}
            />
          </>
        )}
      </div>

      {toast && <Toast msg={toast} />}

      {selected && (
        <HireRequestWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          candidate={{
            id: selected.id,
            name: selected.maskedName,
            rate: `$${selected.hourlyRate}/hr`,
            role: selected.jobTitle,
          }}
        />
      )}
    </section>
  );
}
