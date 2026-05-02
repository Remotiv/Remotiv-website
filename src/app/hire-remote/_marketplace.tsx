"use client";

import { memo, startTransition, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  Clock,
  Globe,
  Lock,
  MapPin,
  Search,
  Unlock,
  X,
} from "lucide-react";

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

// ── 8 dummy candidates (Hire Remote demo set) ────────────────

const DUMMY_CANDIDATES: Candidate[] = [
  {
    id: "1",
    initials: "AR",
    maskedName: "Ahmed R.",
    location: "Karachi, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "Full Stack Developer | Backend Developer | Web Developer",
    bio: "Experienced full stack developer specialising in scalable web applications and cloud infrastructure. Has delivered multiple production-grade SaaS products for US and UK clients.",
    hourlyRate: 35,
    availability: "Available Now",
    hours: "More than 30 hrs/week",
    workType: "Open to contract-to-hire",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Phone Verified", "Email Verified"],
    skills: ["React", "Node.js", "TypeScript", "Python", "AWS", "Docker", "PostgreSQL", "Redis"],
    employmentHistory: [
      {
        title: "Senior Engineer",
        company: "US-based SaaS Startup",
        dates: "Jan 2021 — Present",
        description:
          "Led backend architecture for a platform serving 2M+ daily API requests, owning the migration to microservices, reducing latency by 60%, and mentoring a team of junior engineers.",
      },
      {
        title: "Backend Developer",
        company: "Fintech Company",
        dates: "Mar 2018 — Dec 2020",
        description:
          "Built microservices infrastructure handling real-time payment processing, integrating with third-party banking APIs and ensuring PCI-DSS compliance throughout.",
      },
    ],
    education: { institution: "FAST University", degree: "BSc Computer Science", dates: "2013–2017" },
    portfolio: [
      {
        title: "E-commerce Platform",
        role: "Full Stack Dev | React",
        description:
          "Built a web and mobile platform for a US retail brand handling 50k+ monthly orders, integrating payment gateways, inventory management, and real-time analytics.",
      },
      {
        title: "HealthTech Dashboard",
        role: "Backend Dev | Python",
        description: "Built dashboard infrastructure for healthcare data analytics with HIPAA compliance.",
      },
    ],
  },
  {
    id: "2",
    initials: "SK",
    maskedName: "Sara K.",
    location: "Lahore, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "UI/UX Designer | Product Designer | Visual Designer",
    bio: "Product designer with a strong eye for detail and a passion for user-centred design systems. Shipped redesigns for multiple US SaaS products.",
    hourlyRate: 25,
    availability: "Available Now",
    hours: "20–30 hrs/week",
    workType: "Open to contract",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Email Verified"],
    skills: ["Figma", "User Research", "Prototyping", "Design Systems", "Webflow"],
    employmentHistory: [
      {
        title: "Senior Product Designer",
        company: "Zeal (Remote, US)",
        dates: "Jun 2021 — Present",
        description:
          "Owned end-to-end design for a B2B SaaS dashboard used by 15k+ teams. Built and maintained the design system, reducing engineering rework by 40%.",
      },
      {
        title: "UI Designer",
        company: "Tkxel",
        dates: "Aug 2019 — May 2021",
        description: "Shipped marketing sites and product UIs for early-stage US clients.",
      },
    ],
    education: { institution: "NCA Lahore", degree: "BFA Visual Design", dates: "2015–2019" },
    portfolio: [
      {
        title: "Banking App Redesign",
        role: "Lead Designer | Figma",
        description: "Re-imagined the onboarding and dashboard flows, improving activation by 35%.",
      },
    ],
  },
  {
    id: "3",
    initials: "UT",
    maskedName: "Usman T.",
    location: "Islamabad, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "Backend Engineer | API Developer | DevOps Engineer",
    bio: "Backend engineer focused on high-performance APIs and reliable cloud deployments. Built infrastructure handling 50K req/sec at peak.",
    hourlyRate: 30,
    availability: "Available from May 2026",
    hours: "30+ hrs/week",
    workType: "Full-time",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Phone Verified"],
    skills: ["Python", "Django", "PostgreSQL", "Docker", "Redis", "AWS", "Kubernetes"],
    employmentHistory: [
      {
        title: "Backend Engineer",
        company: "Bazaar Technologies",
        dates: "Feb 2021 — Present",
        description:
          "Designed and operates payments and inventory APIs serving 200k+ retailers, with a 99.95% SLA.",
      },
    ],
    education: { institution: "NUST", degree: "BE Computer Engineering", dates: "2014–2018" },
    portfolio: [],
  },
  {
    id: "4",
    initials: "FM",
    maskedName: "Fatima M.",
    location: "Lahore, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "Senior Data Scientist | ML Engineer",
    bio: "Data scientist with 6 years building ML models that ship to production. Domain expertise in fintech, logistics, and ad-tech.",
    hourlyRate: 45,
    availability: "Available Now",
    hours: "More than 30 hrs/week",
    workType: "Full-time",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Phone Verified", "Email Verified"],
    skills: ["Python", "TensorFlow", "PyTorch", "SQL", "Pandas", "Airflow", "MLOps"],
    employmentHistory: [
      {
        title: "Senior Data Scientist",
        company: "Jazz (Veon)",
        dates: "Apr 2021 — Present",
        description:
          "Owns the recommendation and churn-prediction ML stack used by 70M subscribers. Saved $2M+ annually via model-driven retention.",
      },
      {
        title: "Data Analyst",
        company: "Inbox Health",
        dates: "Sep 2018 — Mar 2021",
        description: "Built reporting and analytics tools for healthcare workflows used by US clinics.",
      },
    ],
    education: { institution: "LUMS", degree: "MS Data Science", dates: "2016–2018" },
    portfolio: [
      {
        title: "Churn Prediction Model",
        role: "Lead DS | Python",
        description: "Reduced 30-day churn by 22% via a real-time scoring pipeline on 70M users.",
      },
    ],
  },
  {
    id: "5",
    initials: "AH",
    maskedName: "Ali H.",
    location: "Lahore, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "Product Designer | Brand & Marketing Designer",
    bio: "Senior product designer comfortable across product UI, brand systems, and motion. Has shipped end-to-end design for two YC-backed startups.",
    hourlyRate: 38,
    availability: "Available Now",
    hours: "20–30 hrs/week",
    workType: "Open to contract",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Email Verified"],
    skills: ["Figma", "Framer", "Prototyping", "Branding", "Motion", "Webflow"],
    employmentHistory: [
      {
        title: "Senior Product Designer",
        company: "Tajir (YC S20)",
        dates: "Jul 2022 — Present",
        description: "Owned design for the merchant app used by 200k+ small retailers across Pakistan.",
      },
    ],
    education: { institution: "NCA Lahore", degree: "BFA Visual Design", dates: "2014–2018" },
    portfolio: [
      {
        title: "Merchant App",
        role: "Lead Designer | Figma",
        description: "Redesigned the daily-use mobile app, lifting weekly active retailers by 28%.",
      },
    ],
  },
  {
    id: "6",
    initials: "ZH",
    maskedName: "Zara H.",
    location: "Lahore, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "Senior Customer Success Manager",
    bio: "8 years in customer success across fintech and logistics SaaS. Specialises in enterprise onboarding and reducing churn at scale.",
    hourlyRate: 32,
    availability: "Available Now",
    hours: "More than 30 hrs/week",
    workType: "Full-time",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Phone Verified", "Email Verified"],
    skills: ["Gainsight", "Intercom", "QBRs", "Onboarding", "NPS", "Executive Relations"],
    employmentHistory: [
      {
        title: "Senior CSM",
        company: "Airlift Technologies",
        dates: "Jan 2020 — Present",
        description: "Owns $2M+ ARR portfolio. Lifted NPS from 32 → 67 over 18 months.",
      },
    ],
    education: { institution: "LSE", degree: "MSc Management", dates: "2014–2016" },
    portfolio: [],
  },
  {
    id: "7",
    initials: "BQ",
    maskedName: "Bilal Q.",
    location: "Karachi, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "SDR Team Lead | Outbound Sales",
    bio: "Built and led SDR teams at two US-funded startups, generating $1.2M+ in annual pipeline through repeatable outbound playbooks.",
    hourlyRate: 28,
    availability: "Available Now",
    hours: "More than 30 hrs/week",
    workType: "Full-time",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Email Verified"],
    skills: ["Salesloft", "Apollo.io", "HubSpot", "Pipeline Mgmt", "Coaching", "RevOps"],
    employmentHistory: [
      {
        title: "SDR Team Lead",
        company: "Podium (Remote)",
        dates: "Mar 2022 — Present",
        description:
          "Hired, trained, and coached a team of 8 SDRs targeting US enterprise. 140% of team quota for 4 consecutive quarters.",
      },
    ],
    education: { institution: "University of Karachi", degree: "MBA", dates: "2015–2017" },
    portfolio: [],
  },
  {
    id: "8",
    initials: "KI",
    maskedName: "Kamran I.",
    location: "Karachi, Pakistan",
    localTime: "5:48 pm",
    jobTitle: "DevOps Engineer | Cloud Architect",
    bio: "DevOps engineer who reduced infrastructure costs by 40% while improving deployment frequency 3x at a regional ride-hailing leader.",
    hourlyRate: 40,
    availability: "Available Now",
    hours: "More than 30 hrs/week",
    workType: "Full-time",
    languages: [
      { name: "English", level: "Fluent" },
      { name: "Urdu", level: "Native" },
    ],
    verifications: ["ID Verified", "Phone Verified", "Email Verified"],
    skills: ["AWS", "Kubernetes", "Terraform", "CI/CD", "Jenkins", "Ansible"],
    employmentHistory: [
      {
        title: "DevOps Engineer",
        company: "Careem (Uber)",
        dates: "May 2021 — Present",
        description:
          "Owns the platform infrastructure for a multi-region payments stack. Designed zero-downtime deploys and AWS Solutions Architect certified.",
      },
    ],
    education: { institution: "NED University", degree: "BS Computer Systems", dates: "2014–2018" },
    portfolio: [],
  },
];

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
      className={`group flex w-full flex-col gap-3 rounded-2xl border bg-white text-left shadow-[0_2px_10px_rgba(0,0,0,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_6px_22px_rgba(0,0,0,0.06)] ${
        selected
          ? "border-l-[3px] border-l-[#49D7A7] border-t-black/[0.06] border-r-black/[0.06] border-b-black/[0.06]"
          : "border-black/[0.06]"
      } ${compact ? "px-5 py-5" : "px-6 py-6"}`}
    >
      <div className="flex items-start gap-4">
        <Avatar candidate={candidate} size={compact ? 48 : 56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={`font-heading font-bold text-[#111] ${compact ? "text-base" : "text-lg"}`}>
              {candidate.maskedName}
            </p>
            <span className="text-[12px] text-[#888]">· {candidate.location}</span>
          </div>
          <p className="mt-1 truncate text-sm text-[#555]">{candidate.jobTitle}</p>
          <p className={`mt-2 ${compact ? "line-clamp-2" : "line-clamp-3"} text-[13px] leading-[1.7] text-[#666]`}>
            {candidate.bio}
          </p>
        </div>
        <div className="text-right">
          <p className="font-heading text-base font-extrabold text-[#111]">${candidate.hourlyRate}/hr</p>
          {available ? (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#49D7A7]/10 px-2.5 py-0.5 text-[10px] font-semibold text-[#1a9e73]">
              <span className="size-1.5 rounded-full bg-[#49D7A7]" />
              Available Now
            </span>
          ) : (
            <span className="mt-1 inline-block rounded-full bg-[#f3f3f3] px-2.5 py-0.5 text-[10px] font-medium text-[#888]">
              {candidate.availability}
            </span>
          )}
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
        <span className="rounded-xl border border-[#49D7A7]/40 px-3.5 py-1.5 text-xs font-semibold text-[#1a9e73] transition-colors group-hover:bg-[#49D7A7]/10">
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
    <div className="flex flex-col gap-5 rounded-2xl border border-black/[0.06] bg-white p-6 shadow-[0_4px_16px_rgba(0,0,0,0.05)]">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs font-semibold text-[#666] transition-colors hover:text-[#111]"
        >
          <ArrowLeft className="size-3.5" strokeWidth={2} />
          Back
        </button>
        <button
          type="button"
          onClick={onUnlock}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#7E47FF] px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Unlock className="size-3.5" strokeWidth={2} />
          Unlock Profile
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

      <div className="grid grid-cols-2 gap-3">
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
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#111] px-5 py-3 font-heading text-sm font-bold text-white transition-opacity hover:opacity-90"
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
          className="rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-xs font-semibold text-[#333]"
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

        <div className="flex h-11 items-center gap-3 rounded-xl border border-black/[0.08] bg-white px-3.5 lg:w-64">
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
          className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#49D7A7] px-5 font-heading text-sm font-bold text-[#111] transition-colors hover:bg-[#3bc495]"
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
    <div className="fixed bottom-6 right-6 z-[60] rounded-xl bg-[#111] px-4 py-3 font-sans text-sm font-medium text-white shadow-xl">
      {msg}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────

const PAGE_SIZE = 6;

export function HireMarketplace() {
  const data = DUMMY_CANDIDATES;

  const [role,    setRole]    = useState<string>("All Roles");
  const [skills,  setSkills]  = useState<string>("");
  const [rate,    setRate]    = useState<number>(60);
  const [exp,     setExp]     = useState<string>("Any");
  const [avail,   setAvail]   = useState<string>("Any");
  const [english, setEnglish] = useState<string>("Any");
  const [query,   setQuery]   = useState<string>("");

  const [selected, setSelected] = useState<Candidate | null>(null);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  const [toast,    setToast]    = useState<string | null>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Lock body scroll ONLY when the mobile bottom-sheet is actually visible —
  // i.e. drawer open AND a candidate selected AND viewport < lg breakpoint.
  // Locking on desktop made the page un-scrollable behind the sticky drawer.
  useEffect(() => {
    if (!mobileDrawerOpen || !selected) return;
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 1024) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [mobileDrawerOpen, selected]);

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
      setMobileDrawerOpen(true);
    });
  }, []);

  function handleClose() {
    setSelected(null);
    setMobileDrawerOpen(false);
  }

  function lockedAction() {
    setToast("🔒 Subscribe to unlock full access — payment setup in progress.");
  }

  // Layout switches: full-width 2-col grid until a candidate is picked, then
  // collapses to a single-column compact list with a sticky drawer on the side.
  const drawerOpen = selected !== null;
  const listGridCls = drawerOpen
    ? "grid grid-cols-1 gap-3"
    : "grid grid-cols-1 gap-4";

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

        <div className="mt-6 flex items-baseline justify-between">
          <h2 className="font-heading text-base font-bold text-[#111]">
            <span className="text-[#1a9e73]">{filtered.length}</span> professionals found
          </h2>
          <span className="text-xs text-[#888]">Showing {visible.length} of {filtered.length}</span>
        </div>

        <div
          className={`mt-4 grid grid-cols-1 gap-6 ${
            drawerOpen ? "lg:grid-cols-[3fr_2fr]" : "lg:grid-cols-1"
          }`}
        >
          <div className={listGridCls}>
            {visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-black/10 bg-white py-14 text-center text-sm text-[#aaa]">
                No candidates match your filters.
              </div>
            ) : (
              visible.map((c) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  selected={selected?.id === c.id}
                  compact={drawerOpen}
                  onSelect={handleSelect}
                />
              ))
            )}

            {pageSize < filtered.length && (
              <button
                type="button"
                onClick={() => setPageSize((n) => n + PAGE_SIZE)}
                className="mt-2 justify-self-center rounded-2xl border-[1.5px] border-[#7E47FF]/30 bg-white px-8 py-3 font-heading text-sm font-semibold text-[#7E47FF] transition-colors hover:border-[#7E47FF] hover:bg-[#7E47FF]/[0.06]"
              >
                Load More Profiles
              </button>
            )}
          </div>

          {drawerOpen && (
            <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
              <ProfileDrawer
                candidate={selected}
                onClose={handleClose}
                onUnlock={lockedAction}
              />
            </aside>
          )}
        </div>
      </div>

      {/* Mobile bottom-sheet drawer */}
      {mobileDrawerOpen && selected && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/40 lg:hidden">
          <button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            className="flex-1"
          />
          <div className="max-h-[92vh] overflow-y-auto rounded-t-3xl bg-[#f8f4f1] px-4 pb-8 pt-3">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-full bg-white p-2 text-[#666] shadow-sm"
                aria-label="Close drawer"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>
            <ProfileDrawer
              candidate={selected}
              onClose={handleClose}
              onUnlock={lockedAction}
            />
          </div>
        </div>
      )}

      {toast && <Toast msg={toast} />}
    </section>
  );
}
