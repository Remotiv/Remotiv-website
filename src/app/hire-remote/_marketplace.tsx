"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  Clock,
  Globe,
  Lock,
  MapPin,
  MessageCircle,
  Search,
  Unlock,
} from "lucide-react";
import HireRequestWizard from "./_hire-request-wizard";

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
};

// ── Real-profile row shape (from hire_remote_profiles) ───────

export type RemoteProfileRow = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
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

function expBucketMatch(filter: string, jobs: Job[]): boolean {
  if (filter === "Any") return true;
  // Treat each employment row as ~3 yrs avg if no parse — simple heuristic for demo.
  const years = jobs.length * 3;
  if (filter === "0–2 yrs")  return years <= 2;
  if (filter === "3–5 yrs")  return years >= 3 && years <= 5;
  if (filter === "6–10 yrs") return years >= 6 && years <= 10;
  if (filter === "10+ yrs")  return years > 10;
  return true;
}

// ── Avatar ───────────────────────────────────────────────────

function Avatar({ candidate, size }: { candidate: Candidate; size: number }) {
  const c = avatarColors(candidate.id);
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
      className={`group flex w-full flex-col gap-3 rounded-2xl border bg-white text-left shadow-[0_2px_10px_rgba(0,0,0,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)] active:scale-[0.98] active:opacity-90 ${
        selected
          ? "border-l-[3px] border-l-[#49D7A7] border-t-black/[0.06] border-r-black/[0.06] border-b-black/[0.06]"
          : "border-black/[0.06]"
      } ${compact ? "px-5 py-5" : "px-6 py-6"}`}
    >
      <div className="flex items-start gap-4">
        <Avatar candidate={candidate} size={compact ? 48 : 56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2 max-lg:flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`font-heading font-bold text-[#111] ${compact ? "text-base" : "text-lg"}`}>
                {candidate.maskedName}
              </p>
              <span className="text-[12px] text-[#888]">· {candidate.location}</span>
            </div>
            <div className="shrink-0 text-right max-lg:flex max-lg:items-center max-lg:gap-2 max-lg:text-left">
              <p className="font-heading text-base font-extrabold text-[#111]">${candidate.hourlyRate}/hr</p>
              {available ? (
                <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#49D7A7]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#1a9e73] max-lg:mt-0">
                  <span className="size-1.5 rounded-full bg-[#49D7A7]" />
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
        <span className="inline-flex items-center justify-center rounded-xl border border-[#49D7A7]/40 px-3.5 py-1.5 text-xs font-semibold text-[#1a9e73] transition-all group-hover:bg-[#49D7A7]/10 group-active:scale-[0.98] group-active:opacity-90 max-lg:min-h-[40px] max-lg:px-4 max-lg:py-2">
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
        <span aria-hidden className="block h-px w-3 bg-[#49D7A7]" />
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
  return (
    <div className="flex flex-col gap-5 rounded-2xl lg:border lg:border-black/[0.06] lg:bg-white lg:p-6 lg:shadow-[0_4px_16px_rgba(0,0,0,0.05)] max-lg:p-0 max-lg:bg-transparent">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#666] transition-all hover:text-[#111] active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3 max-lg:text-sm"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} />
          Back
        </button>
        <button
          type="button"
          onClick={onUnlock}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#7E47FF] px-3.5 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3 max-lg:text-sm"
        >
          <MessageCircle className="size-3.5" strokeWidth={2} />
          Connect with Talent
        </button>
      </div>

      <div className="flex items-start gap-4">
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
        <div className="min-w-0 flex-1">
          <p className="font-heading text-lg font-bold text-[#111]">{candidate.maskedName}</p>
          {available && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#49D7A7]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[#1a9e73]">
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

      <div className="rounded-xl bg-[#49D7A7]/8 px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#1a9e73]">Hourly rate</p>
        <p className="font-heading text-2xl font-extrabold text-[#1a9e73]">${candidate.hourlyRate}/hr</p>
      </div>

      <p className="text-[13px] leading-[1.7] text-[#555]">{candidate.bio}</p>

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
                className="inline-flex items-center gap-1 rounded-full bg-[#49D7A7]/10 px-2.5 py-1 text-[10px] font-semibold text-[#1a9e73]"
              >
                ✓ {v}
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
                className="rounded-xl border-l-[3px] border-l-[#7E47FF] bg-[#f8f8f8] px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-bold text-[#111]">{j.title}</p>
                    <p className="text-xs text-[#777]">{j.company}</p>
                  </div>
                  <p className="shrink-0 text-right text-[10px] text-[#aaa]">{j.dates}</p>
                </div>
                {j.description && (
                  <p className="mt-2 text-[12px] leading-[1.65] text-[#555]">{j.description}</p>
                )}
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
          <p className="font-heading text-sm font-bold text-[#111]">{candidate.education.degree}</p>
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
                <p className="font-heading text-sm font-bold text-[#111]">{p.title}</p>
                <p className="text-[11px] text-[#888]">{p.role}</p>
                <p className="mt-1 text-[12px] leading-[1.65] text-[#555]">{p.description}</p>
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#7E47FF] hover:underline"
                  >
                    Visit Project →
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
        style={{ background: "linear-gradient(135deg, #7E47FF 0%, #5934C4 100%)" }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Lock className="size-4" strokeWidth={2} />
          <p className="font-heading text-sm font-bold">Contact details locked</p>
        </div>
        <p className="mb-4 text-[12px] leading-[1.6] text-white/80">
          Subscribe to view email, phone, and full profile — or pay per unlock.
        </p>
        <button
          type="button"
          onClick={onUnlock}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#111] px-5 py-3 font-heading text-sm font-bold text-white transition-all hover:opacity-90 active:scale-[0.98] active:opacity-90"
        >
          <Lock className="size-4" strokeWidth={2} />
          Unlock &amp; Contact
        </button>
      </div>
    </div>
  );
}

// ── Filter Bar ───────────────────────────────────────────────

const SELECT_CLS =
  "h-11 cursor-pointer rounded-xl border border-black/[0.08] bg-white px-3.5 text-sm text-[#333] outline-none transition-colors focus:border-[#7E47FF]";

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
          className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs font-semibold text-[#333] transition-all active:scale-[0.98] active:opacity-90 max-lg:min-h-[44px] max-lg:px-4 max-lg:py-3"
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
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-[#bbb]"
          />
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-black/[0.06] bg-white px-4 py-3 lg:hidden">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-[#666]">Rate</span>
          <span className="text-sm font-semibold text-[#111]">${rate}/hr</span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          value={rate}
          onChange={(e) => setRate(Number.parseInt(e.target.value, 10))}
          className="w-full accent-[#49D7A7]"
        />
      </div>

      <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center lg:gap-2 ${mobileOpen ? "" : "hidden lg:flex"}`}>
        <select value={role} onChange={(e) => setRole(e.target.value)} className={`${SELECT_CLS} lg:w-36`}>
          {FILTER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>

        <input
          type="text"
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
          placeholder="Skills"
          className={`${SELECT_CLS} placeholder:text-[#bbb] lg:w-32`}
        />

        <div className="hidden h-11 items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-3.5 lg:flex lg:w-64">
          <span className="whitespace-nowrap text-xs font-semibold text-[#666]">Rate:</span>
          <input
            type="range"
            min={0}
            max={200}
            value={rate}
            onChange={(e) => setRate(Number.parseInt(e.target.value, 10))}
            className="flex-1 accent-[#49D7A7]"
          />
          <span className="whitespace-nowrap text-xs font-bold text-[#111]">${rate}/hr</span>
        </div>

        <select value={exp} onChange={(e) => setExp(e.target.value)} className={`${SELECT_CLS} lg:w-32`}>
          {EXP_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "Experience" : v}</option>)}
        </select>

        <select value={avail} onChange={(e) => setAvail(e.target.value)} className={`${SELECT_CLS} lg:w-36`}>
          {AVAIL_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "Availability" : v}</option>)}
        </select>

        <select value={english} onChange={(e) => setEnglish(e.target.value)} className={`${SELECT_CLS} lg:w-32`}>
          {ENGLISH_FILTERS.map((v) => <option key={v} value={v}>{v === "Any" ? "English Level" : v}</option>)}
        </select>

        <div className="hidden flex-1 min-w-0 items-center gap-2 rounded-xl bg-[#f8f8f8] px-3 lg:flex">
          <Search className="size-4 text-[#aaa]" strokeWidth={2} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by role, skill, or keyword…"
            className="h-11 flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-[#bbb]"
          />
        </div>

        <button
          type="button"
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#49D7A7] px-5 font-heading text-sm font-bold text-[#111] transition-all hover:bg-[#3bc495] active:scale-[0.98] active:opacity-90"
        >
          <Search className="size-4" strokeWidth={2.5} />
          Search
        </button>
      </div>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────

function Toast({ msg }: { msg: string }) {
  return (
    <div className="fixed z-[70] rounded-xl bg-[#111] px-4 py-3 font-sans text-sm font-medium text-white shadow-xl lg:bottom-6 lg:right-6 max-lg:bottom-4 max-lg:left-4 max-lg:right-4">
      {msg}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────

const PAGE_SIZE = 6;

export function HireMarketplace({
  realProfiles,
}: {
  realProfiles?: RemoteProfileRow[];
} = {}) {
  const data = useMemo<Candidate[]>(
    () => (realProfiles ?? []).map(rowToCandidate),
    [realProfiles],
  );

  const [role,    setRole]    = useState<string>("All Roles");
  const [skills,  setSkills]  = useState<string>("");
  const [rate,    setRate]    = useState<number>(10);
  const [exp,     setExp]     = useState<string>("Any");
  const [avail,   setAvail]   = useState<string>("Any");
  const [english, setEnglish] = useState<string>("Any");
  const [query,   setQuery]   = useState<string>("");

  const [selected, setSelected] = useState<Candidate | null>(null);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [toast,    setToast]    = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const skillsQ = skills.trim().toLowerCase();
    return data.filter((c) => {
      if (role !== "All Roles") {
        const t = c.jobTitle.toLowerCase();
        if (!t.includes(role.split(" ")[0].toLowerCase())) return false;
      }
      if (skillsQ && !c.skills.some((s) => s.toLowerCase().includes(skillsQ))) return false;
      if (c.hourlyRate > rate) return false;
      if (!expBucketMatch(exp, c.employmentHistory)) return false;
      if (avail === "Available Now"     && !isAvailable(c)) return false;
      if (avail === "Available Later"   &&  isAvailable(c)) return false;
      void english;
      if (q) {
        const blob = `${c.maskedName} ${c.jobTitle} ${c.bio} ${c.location} ${c.skills.join(" ")}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [data, role, skills, rate, exp, avail, english, query]);

  const visible = filtered.slice(0, pageSize);

  // Stable identity so memoised CandidateCard rows skip re-render on selection
  // changes. The body is wrapped in startTransition to keep the layout reflow
  // off the main thread.
  const handleSelect = useCallback((candidate: Candidate) => {
    startTransition(() => {
      setSelected(candidate);
    });
  }, []);

  function handleClose() {
    setSelected(null);
  }

  function openWizard() {
    if (!selected) return;
    setWizardOpen(true);
  }

  const drawerOpen = selected !== null;
  const listGridCls = "grid grid-cols-1 gap-4";

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
            transition: "opacity 0.3s ease",
          }}
        >
          <div className="mt-6 flex items-baseline justify-between">
            <h2 className="font-heading text-base font-bold text-[#111]">
              <span className="text-[#1a9e73]">{filtered.length}</span> professionals found
            </h2>
            <span className="text-xs text-[#888]">Showing {visible.length} of {filtered.length}</span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-6">
            <div className={listGridCls}>
              {visible.length === 0 ? (
                data.length === 0 ? (
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
                visible.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    selected={selected?.id === c.id}
                    compact={false}
                    onSelect={handleSelect}
                  />
                ))
              )}

              {pageSize < filtered.length && (
                <button
                  type="button"
                  onClick={() => setPageSize((n) => n + PAGE_SIZE)}
                  className="mt-2 justify-self-center rounded-2xl border-[1.5px] border-[#7E47FF]/30 bg-white px-8 py-3 font-heading text-sm font-semibold text-[#7E47FF] transition-all hover:border-[#7E47FF] hover:bg-[#7E47FF]/[0.06] active:scale-[0.98] active:opacity-90"
                >
                  Load More Profiles
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Backdrop — mobile only, tap to close */}
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close profile"
          onClick={handleClose}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          style={{
            transition: "opacity 0.3s ease",
          }}
        />
      )}

      {/* Slide-in profile panel */}
      <div
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
          transition: "transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)",
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
                type="button"
                onClick={handleClose}
                className="flex min-h-[44px] cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-2.5 font-sans text-sm font-medium text-[#7E47FF] transition-all active:scale-[0.98] active:opacity-90"
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
