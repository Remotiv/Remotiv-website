"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  updateRemoteAvailabilityWorkType,
  updateRemoteBasicInfo,
  updateRemoteEducation,
  updateRemoteEmployment,
  updateRemoteLanguages,
  updateRemoteLocation,
  updateRemotePortfolio,
  updateRemoteProfessional,
  updateRemoteSkills,
  updateTalentAvailabilitySalary,
  updateTalentBasicInfo,
  updateTalentLocation,
  updateTalentProfessional,
  updateTalentSkillsExperience,
} from "./actions";

export type EditableProfile = {
  id: string;
  sourceTable: "talent_profiles" | "hire_remote_profiles";
  poolLabel: "Pakistan Talent" | "Remote Ready";
  firstName: string;
  lastName: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  email: string;
  matchScore: { filled: number; total: number; pct: number };
  raw: Record<string, unknown>;
};

type SectionKey =
  | "basic"
  | "location"
  | "professional"
  | "availability"
  | "skills"
  | "employment"
  | "education"
  | "languages"
  | "portfolio"
  | "cv";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

const INPUT_CLASS =
  "rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none ring-remotiv-purple/30 focus:border-remotiv-purple focus:ring-2";

const LABEL_CLASS =
  "text-[10px] font-semibold uppercase tracking-widest text-gray-500";

const COUNTRY_OPTIONS = [
  "Pakistan",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Other",
] as const;

// Stored DB values are short keys (canonical: admin talent-dashboard.tsx
// CATEGORY_LABELS). The labels here are display-only — the option `value`
// is the key that goes to the DB.
const ROLE_CATEGORY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Engineer", label: "Engineer" },
  { value: "SDR", label: "SDR / Sales" },
  { value: "CS", label: "Customer Success" },
  { value: "Design", label: "Design & UX" },
  { value: "Data", label: "Data & AI" },
  { value: "DevOps", label: "DevOps & Cloud" },
  { value: "QA", label: "QA" },
  { value: "Marketing", label: "Marketing & Growth" },
  { value: "Ops", label: "Business & Ops" },
  { value: "Finance", label: "Finance & Accounting" },
  { value: "Other", label: "Other" },
];

const INDUSTRY_OPTIONS = [
  "FinTech",
  "EdTech",
  "HealthTech",
  "E-commerce",
  "SaaS",
  "Logistics",
  "Media & Entertainment",
  "AI/ML",
  "Cybersecurity",
  "Gaming",
  "Travel",
  "Other",
] as const;

const AVAILABILITY_OPTIONS = ["Available Now", "Not Available"] as const;
const WORK_TYPE_OPTIONS = [
  "Full-time",
  "Part-time",
  "Contract",
  "Any",
] as const;

const SKILLS_MAX = 30;
const SKILL_CHAR_MAX = 50;
const EXPERIENCE_MAX = 30;
const EXPERIENCE_FIELD_MAX = 200;
const EXPERIENCE_SKILLS_MAX = 30;

// Verbatim from src/app/remote-ready/page.tsx (HOURS_LABEL line 118-122,
// WORK_TYPE_LABEL line 124-129, AVAIL_LABEL line 131-135).
const REMOTE_HOURS_PER_WEEK_OPTIONS = [
  "More than 30 hrs/week",
  "20-30 hrs/week",
  "Less than 20 hrs/week",
] as const;

const REMOTE_WORK_TYPE_OPTIONS = [
  "Open to contract-to-hire",
  "Contract only",
  "Full-time",
  "Part-time",
] as const;

const REMOTE_AVAIL_CHOICES = [
  { value: "now", label: "Available Now" },
  { value: "twoWeeks", label: "Available within 2 weeks" },
  { value: "future", label: "Available from a future date" },
] as const;

const BIO_MIN = 50;
const BIO_MAX = 2000;
const JOB_TITLES_MAX = 200;
const HOURLY_RATE_MIN = 10;
const HOURLY_RATE_MAX = 999;
const EDU_FIELD_MAX = 200;
const EMPLOYMENT_MAX = 30;
const EMPLOYMENT_FIELD_MAX = 200;
const EMPLOYMENT_DESCRIPTION_MAX = 1000;
const LANGUAGES_MAX = 20;
const LANGUAGE_NAME_MAX = 80;
const PORTFOLIO_MAX = 30;
const PORTFOLIO_FIELD_MAX = 200;
const PORTFOLIO_DESCRIPTION_MAX = 1000;
const PORTFOLIO_URL_MAX = 500;

// Verbatim from intake src/app/remote-ready/page.tsx:112 LANGUAGE_LEVELS.
const REMOTE_LANGUAGE_LEVELS = [
  "Native",
  "Fluent",
  "Professional",
  "Basic",
] as const;

// Verbatim from intake src/app/remote-ready/page.tsx:299 — must start with
// http:// or https://. Same regex used server-side in actions.ts.
const PORTFOLIO_URL_REGEX = /^https?:\/\//i;

type RemoteAvailChoice = "" | "now" | "twoWeeks" | "future";

type EmploymentRowState = {
  uiId: string;
  title: string;
  company: string;
  start: string;
  end: string;
  description: string;
};

function makeEmptyEmploymentRow(): EmploymentRowState {
  return {
    uiId: `emp-${Math.random().toString(36).slice(2)}`,
    title: "",
    company: "",
    start: "",
    end: "",
    description: "",
  };
}

function parseEmploymentRowsFromRaw(raw: unknown): EmploymentRowState[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      uiId: `emp-${i}-${Math.random().toString(36).slice(2)}`,
      title: typeof o.title === "string" ? o.title : "",
      company: typeof o.company === "string" ? o.company : "",
      start: typeof o.start === "string" ? o.start : "",
      end: typeof o.end === "string" ? o.end : "",
      description: typeof o.description === "string" ? o.description : "",
    };
  });
}

type LanguageRowState = {
  uiId: string;
  name: string;
  level: string;
};

function makeEmptyLanguageRow(): LanguageRowState {
  return {
    uiId: `lng-${Math.random().toString(36).slice(2)}`,
    name: "",
    level: "Fluent",
  };
}

function parseLanguagesFromRaw(raw: unknown): LanguageRowState[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const level =
      typeof o.level === "string" &&
      (REMOTE_LANGUAGE_LEVELS as readonly string[]).includes(o.level)
        ? o.level
        : "Fluent";
    return {
      uiId: `lng-${i}-${Math.random().toString(36).slice(2)}`,
      name: typeof o.name === "string" ? o.name : "",
      level,
    };
  });
}

type PortfolioRowState = {
  uiId: string;
  projectTitle: string;
  role: string;
  url: string;
  description: string;
};

function makeEmptyPortfolioRow(): PortfolioRowState {
  return {
    uiId: `prt-${Math.random().toString(36).slice(2)}`,
    projectTitle: "",
    role: "",
    url: "",
    description: "",
  };
}

function parsePortfolioFromRaw(raw: unknown): PortfolioRowState[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const projectTitle =
      typeof o.projectTitle === "string"
        ? o.projectTitle
        : typeof o.title === "string"
          ? o.title
          : "";
    return {
      uiId: `prt-${i}-${Math.random().toString(36).slice(2)}`,
      projectTitle,
      role: typeof o.role === "string" ? o.role : "",
      url: typeof o.url === "string" ? o.url : "",
      description: typeof o.description === "string" ? o.description : "",
    };
  });
}

// Verbatim from intake form: src/app/remote-ready/page.tsx:274.
const REMOTE_LINKEDIN_REGEX =
  /^https?:\/\/(www\.)?linkedin\.com\/in\//i;

type TimeZoneGroup = { region: string; zones: string[] };

const TIME_ZONE_GROUPS: TimeZoneGroup[] = (() => {
  const supported =
    typeof Intl !== "undefined" &&
    typeof (Intl as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf === "function"
      ? (Intl as { supportedValuesOf: (k: string) => string[] })
          .supportedValuesOf("timeZone")
      : [];
  const map = new Map<string, string[]>();
  for (const tz of supported) {
    const region = tz.split("/")[0] ?? "Other";
    if (!map.has(region)) map.set(region, []);
    map.get(region)?.push(tz);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, zones]) => ({
      region,
      zones: [...zones].sort((a, b) => a.localeCompare(b)),
    }));
})();

function isKnownTimeZone(tz: string): boolean {
  if (!tz) return true;
  for (const g of TIME_ZONE_GROUPS) {
    if (g.zones.includes(tz)) return true;
  }
  return false;
}

function ChevronRightIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
    >
      <path d="M5.5 2.5L11 8l-5.5 5.5L4 12l4-4-4-4 1.5-1.5z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
    >
      <path d="M8 1.5a3 3 0 00-3 3V6H4a1 1 0 00-1 1v6.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V7a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3zm-1.5 3a1.5 1.5 0 013 0V6h-3V4.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="currentColor"
    >
      <path d="M5 1.5a.5.5 0 01.5-.5h5a.5.5 0 010 1H10v1h3.5a.5.5 0 010 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a.5.5 0 010-1H6v-1H5.5a.5.5 0 01-.5-.5zM5 4v9a1 1 0 001 1h4a1 1 0 001-1V4H5zm2 1.5a.5.5 0 011 0v6a.5.5 0 01-1 0v-6zm3 0a.5.5 0 011 0v6a.5.5 0 01-1 0v-6z" />
    </svg>
  );
}

type ExperienceRowState = {
  uiId: string;
  title: string;
  company: string;
  start: string;
  end: string;
  currentlyWorking: boolean;
  skillsStr: string;
};

function makeEmptyExperienceRow(): ExperienceRowState {
  return {
    uiId: `row-${Math.random().toString(36).slice(2)}`,
    title: "",
    company: "",
    start: "",
    end: "",
    currentlyWorking: false,
    skillsStr: "",
  };
}

function parseSkillsArrayFromRaw(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseExperienceRowsFromRaw(raw: unknown): ExperienceRowState[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const end = typeof o.end === "string" ? o.end : "";
    const currentlyWorking = end === "Present";
    const skillsArr = Array.isArray(o.skills)
      ? (o.skills as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [];
    return {
      uiId: `row-${i}-${Math.random().toString(36).slice(2)}`,
      title: typeof o.title === "string" ? o.title : "",
      company: typeof o.company === "string" ? o.company : "",
      start: typeof o.start === "string" ? o.start : "",
      end: currentlyWorking ? "" : end,
      currentlyWorking,
      skillsStr: skillsArr.join(", "),
    };
  });
}

function skillsExpFilledCount(p: EditableProfile): number {
  let n = 0;
  const s = parseSkillsArrayFromRaw(p.raw.skills);
  if (s.length > 0) n += 1;
  const e = Array.isArray(p.raw.experience) ? p.raw.experience : [];
  if (e.length > 0) n += 1;
  return n;
}

function remoteProfessionalFilledCount(p: EditableProfile): number {
  let n = 0;
  if ((p.raw.job_titles as string | null)?.trim()) n += 1;
  if ((p.raw.bio as string | null)?.trim()) n += 1;
  if (p.raw.hourly_rate != null) n += 1;
  if ((p.raw.hours_per_week as string | null)?.trim()) n += 1;
  return n;
}

function remoteAvailWorkTypeFilledCount(p: EditableProfile): number {
  let n = 0;
  if ((p.raw.availability as string | null)?.trim()) n += 1;
  if ((p.raw.work_type as string | null)?.trim()) n += 1;
  return n;
}

function remoteSkillsFilledCount(p: EditableProfile): number {
  const s = parseSkillsArrayFromRaw(p.raw.skills);
  return s.length > 0 ? 1 : 0;
}

function remoteEmploymentFilledCount(p: EditableProfile): number {
  const arr = Array.isArray(p.raw.employment_history)
    ? p.raw.employment_history
    : [];
  return arr.length > 0 ? 1 : 0;
}

function remoteLanguagesFilledCount(p: EditableProfile): number {
  const arr = Array.isArray(p.raw.languages) ? p.raw.languages : [];
  return arr.length > 0 ? 1 : 0;
}

function remotePortfolioFilledCount(p: EditableProfile): number {
  const arr = Array.isArray(p.raw.portfolio) ? p.raw.portfolio : [];
  return arr.length > 0 ? 1 : 0;
}

function remoteEducationFilledCount(p: EditableProfile): number {
  const eduRaw =
    (p.raw.education ?? null) as Record<string, unknown> | null;
  if (!eduRaw || typeof eduRaw !== "object" || Array.isArray(eduRaw)) {
    return 0;
  }
  let n = 0;
  if (typeof eduRaw.institution === "string" && eduRaw.institution.trim()) {
    n += 1;
  }
  if (typeof eduRaw.degree === "string" && eduRaw.degree.trim()) {
    n += 1;
  }
  const hasStart =
    typeof eduRaw.start === "string" && (eduRaw.start as string).trim();
  const hasEnd =
    typeof eduRaw.end === "string" && (eduRaw.end as string).trim();
  if (hasStart || hasEnd) {
    if (hasStart) n += 1;
    if (hasEnd) n += 1;
  } else if (typeof eduRaw.dates === "string" && eduRaw.dates.trim()) {
    // Legacy intake row — combined dates string only.
    n += 2;
  }
  return n;
}

function basicInfoFilledCount(p: EditableProfile): number {
  let n = 0;
  if (p.firstName.trim()) n += 1;
  if (p.lastName?.trim()) n += 1;
  if (p.phone?.trim()) n += 1;
  if (p.linkedinUrl?.trim()) n += 1;
  return n;
}

function basicInfoBadgeClass(count: number): string {
  if (count === 4) return "bg-green-100 text-green-700";
  if (count === 0) return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-800";
}

function basicInfoBadgeLabel(count: number): string {
  if (count === 4) return "Complete";
  if (count === 0) return "Empty";
  return `${count} of 4 filled`;
}

function locationFilledCount(p: EditableProfile): number {
  let n = 0;
  if ((p.raw.city as string | null)?.trim()) n += 1;
  if ((p.raw.country as string | null)?.trim()) n += 1;
  if (p.sourceTable === "hire_remote_profiles") {
    if ((p.raw.time_zone as string | null)?.trim()) n += 1;
  }
  return n;
}

function professionalFilledCount(p: EditableProfile): number {
  let n = 0;
  if ((p.raw.job_title as string | null)?.trim()) n += 1;
  if ((p.raw.role_category as string | null)?.trim()) n += 1;
  const years = p.raw.years_experience;
  if (typeof years === "number" && years >= 0 && years <= 70) n += 1;
  if ((p.raw.industry as string | null)?.trim()) n += 1;
  if ((p.raw.summary as string | null)?.trim()) n += 1;
  return n;
}

function availSalaryFilledCount(p: EditableProfile): number {
  let n = 0;
  if ((p.raw.availability as string | null)?.trim()) n += 1;
  if ((p.raw.work_type as string | null)?.trim()) n += 1;
  const min = p.raw.salary_min;
  if (typeof min === "number" && min > 0) n += 1;
  const max = p.raw.salary_max;
  if (typeof max === "number" && max > 0) n += 1;
  return n;
}

function ofNBadgeClass(count: number, total: number): string {
  if (count === total) return "bg-green-100 text-green-700";
  if (count === 0) return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-800";
}

function ofNBadgeLabel(count: number, total: number): string {
  if (count === total) return "Complete";
  if (count === 0) return "Empty";
  return `${count} of ${total} filled`;
}

type SectionDef = {
  key: SectionKey;
  title: string;
  badge: { className: string; label: string };
};

const COMING_SOON_BADGE = {
  className: "bg-gray-100 text-gray-600",
  label: "Coming soon",
};

const LOCKED_BADGE = {
  className: "bg-gray-100 text-gray-600",
  label: "Locked",
};

function getSectionsForPool(
  sourceTable: SourceTable,
  counts: {
    basic: number;
    location: number;
    professional: number;
    availability: number;
    skills: number;
    professionalBadge: { className: string; label: string };
    remoteProf: number;
    remoteAvail: number;
    remoteSkills: number;
    remoteEdu: number;
    remoteEmployment: number;
    remoteLanguages: number;
    remotePortfolio: number;
  },
): SectionDef[] {
  if (sourceTable === "talent_profiles") {
    return [
      {
        key: "basic",
        title: "Basic info",
        badge: {
          className: basicInfoBadgeClass(counts.basic),
          label: basicInfoBadgeLabel(counts.basic),
        },
      },
      {
        key: "location",
        title: "Location",
        badge: {
          className: ofNBadgeClass(counts.location, 2),
          label: ofNBadgeLabel(counts.location, 2),
        },
      },
      {
        key: "professional",
        title: "Professional details",
        badge: counts.professionalBadge,
      },
      {
        key: "availability",
        title: "Availability & salary",
        badge: {
          className: ofNBadgeClass(counts.availability, 4),
          label: ofNBadgeLabel(counts.availability, 4),
        },
      },
      {
        key: "skills",
        title: "Skills & experience",
        badge: {
          className: ofNBadgeClass(counts.skills, 2),
          label: ofNBadgeLabel(counts.skills, 2),
        },
      },
      { key: "cv", title: "CV & photo", badge: LOCKED_BADGE },
    ];
  }
  return [
    {
      key: "basic",
      title: "Basic info",
      badge: {
        className: ofNBadgeClass(counts.basic, 4),
        label: ofNBadgeLabel(counts.basic, 4),
      },
    },
    {
      key: "location",
      title: "Location & time zone",
      badge: {
        className: ofNBadgeClass(counts.location, 3),
        label: ofNBadgeLabel(counts.location, 3),
      },
    },
    {
      key: "professional",
      title: "Professional details",
      badge: {
        className: ofNBadgeClass(counts.remoteProf, 4),
        label: ofNBadgeLabel(counts.remoteProf, 4),
      },
    },
    {
      key: "availability",
      title: "Availability & work type",
      badge: {
        className: ofNBadgeClass(counts.remoteAvail, 2),
        label: ofNBadgeLabel(counts.remoteAvail, 2),
      },
    },
    {
      key: "skills",
      title: "Skills",
      badge:
        counts.remoteSkills === 1
          ? { className: "bg-green-100 text-green-700", label: "Complete" }
          : { className: "bg-red-100 text-red-700", label: "Empty" },
    },
    {
      key: "employment",
      title: "Employment history",
      badge:
        counts.remoteEmployment === 1
          ? { className: "bg-green-100 text-green-700", label: "Complete" }
          : { className: "bg-red-100 text-red-700", label: "Empty" },
    },
    {
      key: "education",
      title: "Education",
      badge: {
        className: ofNBadgeClass(counts.remoteEdu, 4),
        label: ofNBadgeLabel(counts.remoteEdu, 4),
      },
    },
    {
      key: "languages",
      title: "Languages",
      badge:
        counts.remoteLanguages === 1
          ? { className: "bg-green-100 text-green-700", label: "Complete" }
          : { className: "bg-red-100 text-red-700", label: "Empty" },
    },
    {
      key: "portfolio",
      title: "Portfolio",
      badge:
        counts.remotePortfolio === 1
          ? { className: "bg-green-100 text-green-700", label: "Complete" }
          : { className: "bg-red-100 text-red-700", label: "Empty" },
    },
    { key: "cv", title: "CV & photo", badge: LOCKED_BADGE },
  ];
}

export function EditClient({
  email,
  profiles,
}: {
  email: string;
  profiles: EditableProfile[];
}) {
  const router = useRouter();
  const [activePool, setActivePool] = useState<
    EditableProfile["sourceTable"] | null
  >(profiles[0]?.sourceTable ?? null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set());
  const [signingOut, setSigningOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const activeProfile =
    profiles.find((p) => p.sourceTable === activePool) ?? profiles[0] ?? null;

  // Local form state for the Basic Info section. Resets whenever the active
  // profile changes so the right row's values are shown after a tab switch.
  const [basicFirstName, setBasicFirstName] = useState("");
  const [basicLastName, setBasicLastName] = useState("");
  const [basicPhone, setBasicPhone] = useState("");
  const [basicLinkedin, setBasicLinkedin] = useState("");
  const [basicErrors, setBasicErrors] = useState<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    linkedinUrl?: string;
  }>({});
  const [basicSaving, setBasicSaving] = useState(false);
  const [basicSnapshot, setBasicSnapshot] = useState<{
    firstName: string;
    lastName: string;
    phone: string;
    linkedin: string;
  } | null>(null);

  const [locCity, setLocCity] = useState("");
  const [locCountry, setLocCountry] = useState("");
  const [locTimeZone, setLocTimeZone] = useState("");
  const [locErrors, setLocErrors] = useState<{
    city?: string;
    country?: string;
    timeZone?: string;
  }>({});
  const [locSaving, setLocSaving] = useState(false);
  const [locSnapshot, setLocSnapshot] = useState<{
    city: string;
    country: string;
    timeZone: string;
  } | null>(null);

  const [profJobTitle, setProfJobTitle] = useState("");
  const [profRoleCategory, setProfRoleCategory] = useState("");
  const [profYearsExperience, setProfYearsExperience] = useState("");
  const [profIndustry, setProfIndustry] = useState("");
  const [profSummary, setProfSummary] = useState("");
  const [profErrors, setProfErrors] = useState<{
    jobTitle?: string;
    roleCategory?: string;
    yearsExperience?: string;
    industry?: string;
    summary?: string;
  }>({});
  const [profSaving, setProfSaving] = useState(false);
  const [profSnapshot, setProfSnapshot] = useState<{
    jobTitle: string;
    roleCategory: string;
    yearsExperience: string;
    industry: string;
    summary: string;
  } | null>(null);

  const [availAvailability, setAvailAvailability] = useState("");
  const [availWorkType, setAvailWorkType] = useState("");
  const [availSalaryMin, setAvailSalaryMin] = useState("");
  const [availSalaryMax, setAvailSalaryMax] = useState("");
  const [availErrors, setAvailErrors] = useState<{
    availability?: string;
    workType?: string;
    salaryMin?: string;
    salaryMax?: string;
  }>({});
  const [availSaving, setAvailSaving] = useState(false);
  const [availSnapshot, setAvailSnapshot] = useState<{
    availability: string;
    workType: string;
    salaryMin: string;
    salaryMax: string;
  } | null>(null);

  const [skillsList, setSkillsList] = useState<string[]>([]);
  const [skillInput, setSkillInput] = useState("");
  const [expRows, setExpRows] = useState<ExperienceRowState[]>([]);
  const [skillsExpErrors, setSkillsExpErrors] = useState<{
    general?: string;
    rows?: Record<
      string,
      {
        title?: string;
        company?: string;
        start?: string;
        end?: string;
        skillsStr?: string;
      }
    >;
  }>({});
  const [skillsExpSaving, setSkillsExpSaving] = useState(false);
  const [skillsExpSnapshot, setSkillsExpSnapshot] = useState<{
    skills: string[];
    expRows: ExperienceRowState[];
  } | null>(null);

  const [remoteJobTitles, setRemoteJobTitles] = useState("");
  const [remoteBio, setRemoteBio] = useState("");
  const [remoteHourlyRate, setRemoteHourlyRate] = useState("");
  const [remoteHoursPerWeek, setRemoteHoursPerWeek] = useState("");
  const [remoteProfErrors, setRemoteProfErrors] = useState<{
    jobTitles?: string;
    bio?: string;
    hourlyRate?: string;
    hoursPerWeek?: string;
  }>({});
  const [remoteProfSaving, setRemoteProfSaving] = useState(false);
  const [remoteProfSnapshot, setRemoteProfSnapshot] = useState<{
    jobTitles: string;
    bio: string;
    hourlyRate: string;
    hoursPerWeek: string;
  } | null>(null);

  const [remoteAvailChoice, setRemoteAvailChoice] =
    useState<RemoteAvailChoice>("");
  const [remoteAvailFromDate, setRemoteAvailFromDate] = useState("");
  const [remoteWorkType, setRemoteWorkType] = useState("");
  const [remoteAvailErrors, setRemoteAvailErrors] = useState<{
    availability?: string;
    availableFromDate?: string;
    workType?: string;
  }>({});
  const [remoteAvailSaving, setRemoteAvailSaving] = useState(false);
  const [remoteAvailSnapshot, setRemoteAvailSnapshot] = useState<{
    availChoice: RemoteAvailChoice;
    availableFromDate: string;
    workType: string;
  } | null>(null);

  const [remoteSkillsList, setRemoteSkillsList] = useState<string[]>([]);
  const [remoteSkillInput, setRemoteSkillInput] = useState("");
  const [remoteSkillsErrors, setRemoteSkillsErrors] = useState<{
    general?: string;
  }>({});
  const [remoteSkillsSaving, setRemoteSkillsSaving] = useState(false);
  const [remoteSkillsSnapshot, setRemoteSkillsSnapshot] = useState<
    string[] | null
  >(null);

  const [remoteEduInstitution, setRemoteEduInstitution] = useState("");
  const [remoteEduDegree, setRemoteEduDegree] = useState("");
  const [remoteEduStart, setRemoteEduStart] = useState("");
  const [remoteEduEnd, setRemoteEduEnd] = useState("");
  const [remoteEduErrors, setRemoteEduErrors] = useState<{
    institution?: string;
    degree?: string;
    start?: string;
    end?: string;
  }>({});
  const [remoteEduSaving, setRemoteEduSaving] = useState(false);
  const [remoteEduSnapshot, setRemoteEduSnapshot] = useState<{
    institution: string;
    degree: string;
    start: string;
    end: string;
  } | null>(null);

  const [employmentRows, setEmploymentRows] = useState<EmploymentRowState[]>(
    [],
  );
  const [employmentErrors, setEmploymentErrors] = useState<{
    general?: string;
    rows?: Record<
      string,
      {
        title?: string;
        company?: string;
        start?: string;
        end?: string;
        description?: string;
      }
    >;
  }>({});
  const [employmentSaving, setEmploymentSaving] = useState(false);
  const [employmentSnapshot, setEmploymentSnapshot] = useState<
    EmploymentRowState[] | null
  >(null);

  const [languageRows, setLanguageRows] = useState<LanguageRowState[]>([]);
  const [languagesErrors, setLanguagesErrors] = useState<{
    general?: string;
    rows?: Record<string, { name?: string; level?: string }>;
  }>({});
  const [languagesSaving, setLanguagesSaving] = useState(false);
  const [languagesSnapshot, setLanguagesSnapshot] = useState<
    LanguageRowState[] | null
  >(null);

  const [portfolioRows, setPortfolioRows] = useState<PortfolioRowState[]>([]);
  const [portfolioErrors, setPortfolioErrors] = useState<{
    general?: string;
    rows?: Record<
      string,
      {
        projectTitle?: string;
        role?: string;
        url?: string;
        description?: string;
      }
    >;
  }>({});
  const [portfolioSaving, setPortfolioSaving] = useState(false);
  const [portfolioSnapshot, setPortfolioSnapshot] = useState<
    PortfolioRowState[] | null
  >(null);

  useEffect(() => {
    if (!activeProfile) {
      setBasicFirstName("");
      setBasicLastName("");
      setBasicPhone("");
      setBasicLinkedin("");
      setBasicSnapshot(null);
      setLocCity("");
      setLocCountry("");
      setLocTimeZone("");
      setLocSnapshot(null);
      setProfJobTitle("");
      setProfRoleCategory("");
      setProfYearsExperience("");
      setProfIndustry("");
      setProfSummary("");
      setProfSnapshot(null);
      setAvailAvailability("");
      setAvailWorkType("");
      setAvailSalaryMin("");
      setAvailSalaryMax("");
      setAvailSnapshot(null);
      setSkillsList([]);
      setSkillInput("");
      setExpRows([]);
      setSkillsExpSnapshot(null);
      setRemoteJobTitles("");
      setRemoteBio("");
      setRemoteHourlyRate("");
      setRemoteHoursPerWeek("");
      setRemoteProfSnapshot(null);
      setRemoteAvailChoice("");
      setRemoteAvailFromDate("");
      setRemoteWorkType("");
      setRemoteAvailSnapshot(null);
      setRemoteSkillsList([]);
      setRemoteSkillInput("");
      setRemoteSkillsSnapshot(null);
      setRemoteEduInstitution("");
      setRemoteEduDegree("");
      setRemoteEduStart("");
      setRemoteEduEnd("");
      setRemoteEduSnapshot(null);
      setEmploymentRows([]);
      setEmploymentSnapshot(null);
      setEmploymentErrors({});
      setLanguageRows([]);
      setLanguagesSnapshot(null);
      setLanguagesErrors({});
      setPortfolioRows([]);
      setPortfolioSnapshot(null);
      setPortfolioErrors({});
      return;
    }
    const next = {
      firstName: activeProfile.firstName ?? "",
      lastName: activeProfile.lastName ?? "",
      phone: activeProfile.phone ?? "",
      linkedin: activeProfile.linkedinUrl ?? "",
    };
    setBasicFirstName(next.firstName);
    setBasicLastName(next.lastName);
    setBasicPhone(next.phone);
    setBasicLinkedin(next.linkedin);
    setBasicSnapshot(next);
    setBasicErrors({});

    const raw = activeProfile.raw;
    const locNext = {
      city: ((raw.city as string | null) ?? "").trim() ? (raw.city as string) : "",
      country: ((raw.country as string | null) ?? "").trim()
        ? (raw.country as string)
        : "",
      timeZone: ((raw.time_zone as string | null) ?? "").trim()
        ? (raw.time_zone as string)
        : "",
    };
    setLocCity(locNext.city);
    setLocCountry(locNext.country);
    setLocTimeZone(locNext.timeZone);
    setLocSnapshot(locNext);
    setLocErrors({});

    const yearsRaw = raw.years_experience;
    const profNext = {
      jobTitle: ((raw.job_title as string | null) ?? "") || "",
      roleCategory: ((raw.role_category as string | null) ?? "") || "",
      yearsExperience:
        typeof yearsRaw === "number" && Number.isFinite(yearsRaw)
          ? String(yearsRaw)
          : "",
      industry: ((raw.industry as string | null) ?? "") || "",
      summary: ((raw.summary as string | null) ?? "") || "",
    };
    setProfJobTitle(profNext.jobTitle);
    setProfRoleCategory(profNext.roleCategory);
    setProfYearsExperience(profNext.yearsExperience);
    setProfIndustry(profNext.industry);
    setProfSummary(profNext.summary);
    setProfSnapshot(profNext);
    setProfErrors({});

    const minRaw = raw.salary_min;
    const maxRaw = raw.salary_max;
    const availNext = {
      availability: ((raw.availability as string | null) ?? "") || "",
      workType: ((raw.work_type as string | null) ?? "") || "",
      salaryMin:
        typeof minRaw === "number" && Number.isFinite(minRaw)
          ? String(minRaw)
          : "",
      salaryMax:
        typeof maxRaw === "number" && Number.isFinite(maxRaw)
          ? String(maxRaw)
          : "",
    };
    setAvailAvailability(availNext.availability);
    setAvailWorkType(availNext.workType);
    setAvailSalaryMin(availNext.salaryMin);
    setAvailSalaryMax(availNext.salaryMax);
    setAvailSnapshot(availNext);
    setAvailErrors({});

    const seededSkills = parseSkillsArrayFromRaw(activeProfile.raw.skills);
    const seededExpRows = parseExperienceRowsFromRaw(
      activeProfile.raw.experience,
    );
    setSkillsList(seededSkills);
    setSkillInput("");
    setExpRows(seededExpRows);
    setSkillsExpErrors({});
    setSkillsExpSnapshot({ skills: seededSkills, expRows: seededExpRows });

    if (activeProfile.sourceTable === "hire_remote_profiles") {
      const r = activeProfile.raw;

      const profNext = {
        jobTitles: ((r.job_titles as string | null) ?? "").trim(),
        bio: ((r.bio as string | null) ?? "").trim(),
        hourlyRate: r.hourly_rate != null ? String(r.hourly_rate) : "",
        hoursPerWeek: ((r.hours_per_week as string | null) ?? "").trim(),
      };
      setRemoteJobTitles(profNext.jobTitles);
      setRemoteBio(profNext.bio);
      setRemoteHourlyRate(profNext.hourlyRate);
      setRemoteHoursPerWeek(profNext.hoursPerWeek);
      setRemoteProfSnapshot(profNext);
      setRemoteProfErrors({});

      const availLabel = ((r.availability as string | null) ?? "").trim();
      const availFromIso =
        ((r.available_from_date as string | null) ?? "").trim();
      let availChoice: RemoteAvailChoice = "";
      let availFromDate = "";
      if (availLabel.startsWith("Available from ")) {
        availChoice = "future";
        availFromDate = availFromIso;
      } else if (availLabel === "Available Now") {
        availChoice = "now";
      } else if (availLabel === "Available within 2 weeks") {
        availChoice = "twoWeeks";
      }
      const wt = ((r.work_type as string | null) ?? "").trim();
      const availNext = {
        availChoice,
        availableFromDate: availFromDate,
        workType: wt,
      };
      setRemoteAvailChoice(availNext.availChoice);
      setRemoteAvailFromDate(availNext.availableFromDate);
      setRemoteWorkType(availNext.workType);
      setRemoteAvailSnapshot(availNext);
      setRemoteAvailErrors({});

      const remoteSkillsSeed = parseSkillsArrayFromRaw(r.skills);
      setRemoteSkillsList(remoteSkillsSeed);
      setRemoteSkillInput("");
      setRemoteSkillsSnapshot(remoteSkillsSeed);
      setRemoteSkillsErrors({});

      const eduRaw =
        (r.education ?? null) as Record<string, unknown> | null;
      let eduInstitution = "";
      let eduDegree = "";
      let eduStart = "";
      let eduEnd = "";
      if (eduRaw && typeof eduRaw === "object" && !Array.isArray(eduRaw)) {
        if (typeof eduRaw.institution === "string") {
          eduInstitution = eduRaw.institution;
        }
        if (typeof eduRaw.degree === "string") {
          eduDegree = eduRaw.degree;
        }
        if (typeof eduRaw.start === "string") {
          eduStart = eduRaw.start;
        }
        if (typeof eduRaw.end === "string") {
          eduEnd = eduRaw.end;
        }
        // Legacy fallback: rows written by the public intake form before
        // this patch store only a combined `dates` string. Parse it back
        // into start/end so users don't see empty inputs on first load.
        if (
          !eduStart &&
          !eduEnd &&
          typeof eduRaw.dates === "string" &&
          eduRaw.dates.trim()
        ) {
          // Intake join: [start, end].filter(Boolean).join("–")
          // — en-dash U+2013, no surrounding spaces.
          const parts = (eduRaw.dates as string).split("–");
          if (parts.length === 2) {
            eduStart = parts[0].trim();
            eduEnd = parts[1].trim();
          } else if (parts.length === 1) {
            // Ambiguous (start-only OR end-only). Default to start.
            eduStart = parts[0].trim();
          }
        }
      }
      const edu = {
        institution: eduInstitution,
        degree: eduDegree,
        start: eduStart,
        end: eduEnd,
      };
      setRemoteEduInstitution(edu.institution);
      setRemoteEduDegree(edu.degree);
      setRemoteEduStart(edu.start);
      setRemoteEduEnd(edu.end);
      setRemoteEduSnapshot(edu);
      setRemoteEduErrors({});

      const employmentSeed = parseEmploymentRowsFromRaw(r.employment_history);
      setEmploymentRows(employmentSeed);
      setEmploymentSnapshot(employmentSeed);
      setEmploymentErrors({});

      const languagesSeed = parseLanguagesFromRaw(r.languages);
      setLanguageRows(languagesSeed);
      setLanguagesSnapshot(languagesSeed);
      setLanguagesErrors({});

      const portfolioSeed = parsePortfolioFromRaw(r.portfolio);
      setPortfolioRows(portfolioSeed);
      setPortfolioSnapshot(portfolioSeed);
      setPortfolioErrors({});
    }
  }, [activeProfile]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  function toggleSection(key: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.error("[edit] sign out failed:", err);
    }
    router.push("/talent/login");
    router.refresh();
  }

  function handleBasicCancel() {
    if (!basicSnapshot) return;
    setBasicFirstName(basicSnapshot.firstName);
    setBasicLastName(basicSnapshot.lastName);
    setBasicPhone(basicSnapshot.phone);
    setBasicLinkedin(basicSnapshot.linkedin);
    setBasicErrors({});
  }

  function handleLocationCancel() {
    if (!locSnapshot) return;
    setLocCity(locSnapshot.city);
    setLocCountry(locSnapshot.country);
    setLocTimeZone(locSnapshot.timeZone);
    setLocErrors({});
  }

  async function handleLocationSave() {
    if (!activeProfile) return;
    const errors: typeof locErrors = {};
    const city = locCity.trim();
    const country = locCountry.trim();
    const timeZone = locTimeZone.trim();
    if (city.length > 120) errors.city = "Must be 120 characters or fewer.";
    if (country && !(COUNTRY_OPTIONS as readonly string[]).includes(country)) {
      errors.country = "Pick a country from the list.";
    }
    if (
      activeProfile.sourceTable === "hire_remote_profiles" &&
      timeZone &&
      !isKnownTimeZone(timeZone)
    ) {
      errors.timeZone = "Pick a time zone from the list.";
    }
    setLocErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setLocSaving(true);
    try {
      const result =
        activeProfile.sourceTable === "talent_profiles"
          ? await updateTalentLocation({
              profileId: activeProfile.id,
              sourceTable: activeProfile.sourceTable,
              city: city || null,
              country: country || null,
            })
          : await updateRemoteLocation({
              profileId: activeProfile.id,
              sourceTable: activeProfile.sourceTable,
              city,
              country,
              timeZone,
            });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const savedCity =
        "city" in result.data && result.data.city !== null
          ? (result.data.city as string)
          : "";
      const savedCountry =
        "country" in result.data && result.data.country !== null
          ? (result.data.country as string)
          : "";
      const savedTimeZone =
        "timeZone" in result.data
          ? ((result.data as { timeZone: string }).timeZone ?? "")
          : "";
      setLocCity(savedCity);
      setLocCountry(savedCountry);
      setLocTimeZone(savedTimeZone);
      setLocSnapshot({
        city: savedCity,
        country: savedCountry,
        timeZone: savedTimeZone,
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] location save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setLocSaving(false);
    }
  }

  function handleProfessionalCancel() {
    if (!profSnapshot) return;
    setProfJobTitle(profSnapshot.jobTitle);
    setProfRoleCategory(profSnapshot.roleCategory);
    setProfYearsExperience(profSnapshot.yearsExperience);
    setProfIndustry(profSnapshot.industry);
    setProfSummary(profSnapshot.summary);
    setProfErrors({});
  }

  async function handleProfessionalSave() {
    if (!activeProfile) return;
    const errors: typeof profErrors = {};
    const jobTitle = profJobTitle.trim();
    const roleCategory = profRoleCategory.trim();
    const industry = profIndustry.trim();
    const summary = profSummary.trim();
    const yearsRaw = profYearsExperience.trim();

    if (jobTitle.length > 120) errors.jobTitle = "Must be 120 characters or fewer.";
    if (
      roleCategory &&
      !ROLE_CATEGORY_OPTIONS.some((o) => o.value === roleCategory)
    ) {
      errors.roleCategory = "Pick a role category from the list.";
    }
    if (industry && !(INDUSTRY_OPTIONS as readonly string[]).includes(industry)) {
      errors.industry = "Pick an industry from the list.";
    }
    if (summary.length > 5000) {
      errors.summary = "Must be 5000 characters or fewer.";
    }

    let yearsExperience: number | null = null;
    if (yearsRaw.length > 0) {
      const parsed = Number(yearsRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        errors.yearsExperience = "Whole number between 0 and 70.";
      } else if (parsed < 0 || parsed > 70) {
        errors.yearsExperience = "Must be between 0 and 70.";
      } else {
        yearsExperience = parsed;
      }
    }

    setProfErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setProfSaving(true);
    try {
      const result = await updateTalentProfessional({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        jobTitle: jobTitle || null,
        roleCategory: roleCategory || null,
        yearsExperience,
        industry: industry || null,
        summary: summary || null,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      setProfJobTitle(saved.jobTitle ?? "");
      setProfRoleCategory(saved.roleCategory ?? "");
      setProfYearsExperience(
        saved.yearsExperience !== null ? String(saved.yearsExperience) : "",
      );
      setProfIndustry(saved.industry ?? "");
      setProfSummary(saved.summary ?? "");
      setProfSnapshot({
        jobTitle: saved.jobTitle ?? "",
        roleCategory: saved.roleCategory ?? "",
        yearsExperience:
          saved.yearsExperience !== null ? String(saved.yearsExperience) : "",
        industry: saved.industry ?? "",
        summary: saved.summary ?? "",
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] professional save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setProfSaving(false);
    }
  }

  function handleAvailSalaryCancel() {
    if (!availSnapshot) return;
    setAvailAvailability(availSnapshot.availability);
    setAvailWorkType(availSnapshot.workType);
    setAvailSalaryMin(availSnapshot.salaryMin);
    setAvailSalaryMax(availSnapshot.salaryMax);
    setAvailErrors({});
  }

  async function handleAvailSalarySave() {
    if (!activeProfile) return;
    const errors: typeof availErrors = {};
    const availability = availAvailability.trim();
    const workType = availWorkType.trim();
    const minRaw = availSalaryMin.trim();
    const maxRaw = availSalaryMax.trim();

    if (
      availability &&
      !(AVAILABILITY_OPTIONS as readonly string[]).includes(availability)
    ) {
      errors.availability = "Pick an option from the list.";
    }
    if (workType && !(WORK_TYPE_OPTIONS as readonly string[]).includes(workType)) {
      errors.workType = "Pick an option from the list.";
    }

    let salaryMin: number | null = null;
    if (minRaw.length > 0) {
      const parsed = Number(minRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        errors.salaryMin = "Whole number, no decimals.";
      } else if (parsed < 0 || parsed > 100_000_000) {
        errors.salaryMin = "Out of range.";
      } else {
        salaryMin = parsed;
      }
    }

    let salaryMax: number | null = null;
    if (maxRaw.length > 0) {
      const parsed = Number(maxRaw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        errors.salaryMax = "Whole number, no decimals.";
      } else if (parsed < 0 || parsed > 100_000_000) {
        errors.salaryMax = "Out of range.";
      } else {
        salaryMax = parsed;
      }
    }

    if (
      salaryMin !== null &&
      salaryMax !== null &&
      salaryMin > salaryMax
    ) {
      errors.salaryMax = "Maximum must be ≥ minimum.";
    }

    setAvailErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setAvailSaving(true);
    try {
      const result = await updateTalentAvailabilitySalary({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        availability: availability || null,
        workType: workType || null,
        salaryMin,
        salaryMax,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      setAvailAvailability(saved.availability ?? "");
      setAvailWorkType(saved.workType ?? "");
      setAvailSalaryMin(
        saved.salaryMin !== null ? String(saved.salaryMin) : "",
      );
      setAvailSalaryMax(
        saved.salaryMax !== null ? String(saved.salaryMax) : "",
      );
      setAvailSnapshot({
        availability: saved.availability ?? "",
        workType: saved.workType ?? "",
        salaryMin: saved.salaryMin !== null ? String(saved.salaryMin) : "",
        salaryMax: saved.salaryMax !== null ? String(saved.salaryMax) : "",
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] availability save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setAvailSaving(false);
    }
  }

  function commitSkillInput() {
    const raw = skillInput.trim();
    if (!raw) return;
    if (raw.length > SKILL_CHAR_MAX) {
      setSkillsExpErrors((prev) => ({
        ...prev,
        general: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
      }));
      return;
    }
    const lower = raw.toLowerCase();
    if (skillsList.some((s) => s.toLowerCase() === lower)) {
      setSkillInput("");
      return;
    }
    if (skillsList.length >= SKILLS_MAX) {
      setSkillsExpErrors((prev) => ({
        ...prev,
        general: `You can list up to ${SKILLS_MAX} skills.`,
      }));
      return;
    }
    setSkillsList((prev) => [...prev, raw]);
    setSkillInput("");
    setSkillsExpErrors((prev) => ({ ...prev, general: undefined }));
  }

  function handleSkillInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitSkillInput();
    } else if (
      e.key === "Backspace" &&
      skillInput === "" &&
      skillsList.length > 0
    ) {
      setSkillsList((prev) => prev.slice(0, -1));
    }
  }

  function removeSkillAt(index: number) {
    setSkillsList((prev) => prev.filter((_, i) => i !== index));
  }

  function addExperienceRow() {
    if (expRows.length >= EXPERIENCE_MAX) {
      setSkillsExpErrors((prev) => ({
        ...prev,
        general: `You can list up to ${EXPERIENCE_MAX} experiences.`,
      }));
      return;
    }
    setExpRows((prev) => [...prev, makeEmptyExperienceRow()]);
  }

  function removeExperienceRow(uiId: string) {
    setExpRows((prev) => prev.filter((r) => r.uiId !== uiId));
  }

  function updateExperienceRow(
    uiId: string,
    patch: Partial<ExperienceRowState>,
  ) {
    setExpRows((prev) =>
      prev.map((r) => (r.uiId === uiId ? { ...r, ...patch } : r)),
    );
  }

  function handleSkillsExpCancel() {
    if (!skillsExpSnapshot) return;
    setSkillsList(skillsExpSnapshot.skills);
    setSkillInput("");
    setExpRows(skillsExpSnapshot.expRows);
    setSkillsExpErrors({});
  }

  async function handleSkillsExpSave() {
    if (!activeProfile) return;

    let pendingSkills = [...skillsList];
    const raw = skillInput.trim();
    if (raw) {
      if (raw.length > SKILL_CHAR_MAX) {
        setSkillsExpErrors({
          general: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
        });
        return;
      }
      if (!pendingSkills.some((s) => s.toLowerCase() === raw.toLowerCase())) {
        if (pendingSkills.length >= SKILLS_MAX) {
          setSkillsExpErrors({
            general: `You can list up to ${SKILLS_MAX} skills.`,
          });
          return;
        }
        pendingSkills = [...pendingSkills, raw];
      }
    }

    const rowErrors: Record<
      string,
      {
        title?: string;
        company?: string;
        start?: string;
        end?: string;
        skillsStr?: string;
      }
    > = {};
    for (const row of expRows) {
      const rowErr: {
        title?: string;
        company?: string;
        start?: string;
        end?: string;
        skillsStr?: string;
      } = {};
      if (row.title.length > EXPERIENCE_FIELD_MAX)
        rowErr.title = `≤${EXPERIENCE_FIELD_MAX} chars.`;
      if (row.company.length > EXPERIENCE_FIELD_MAX)
        rowErr.company = `≤${EXPERIENCE_FIELD_MAX} chars.`;
      if (row.start.length > EXPERIENCE_FIELD_MAX)
        rowErr.start = `≤${EXPERIENCE_FIELD_MAX} chars.`;
      if (
        !row.currentlyWorking &&
        row.end.length > EXPERIENCE_FIELD_MAX
      )
        rowErr.end = `≤${EXPERIENCE_FIELD_MAX} chars.`;
      const rowSkills = row.skillsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (rowSkills.some((s) => s.length > SKILL_CHAR_MAX))
        rowErr.skillsStr = `Each skill ≤${SKILL_CHAR_MAX} chars.`;
      if (rowSkills.length > EXPERIENCE_SKILLS_MAX)
        rowErr.skillsStr = `Up to ${EXPERIENCE_SKILLS_MAX} skills per row.`;
      if (Object.keys(rowErr).length > 0) rowErrors[row.uiId] = rowErr;
    }
    if (Object.keys(rowErrors).length > 0) {
      setSkillsExpErrors({ rows: rowErrors });
      return;
    }

    setSkillsExpErrors({});
    setSkillsExpSaving(true);
    try {
      const experienceInput = expRows.map((r) => ({
        title: r.title.trim(),
        company: r.company.trim(),
        start: r.start.trim(),
        end: r.end.trim(),
        currentlyWorking: r.currentlyWorking,
        skills: r.skillsStr
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }));

      const result = await updateTalentSkillsExperience({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        skills: pendingSkills,
        experience: experienceInput,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }

      const savedSkills = result.data.skills;
      const savedRows = result.data.experience.map((entry, i) => ({
        uiId: `row-${i}-${Math.random().toString(36).slice(2)}`,
        title: entry.title,
        company: entry.company,
        start: entry.start,
        end: entry.end === "Present" ? "" : entry.end,
        currentlyWorking: entry.end === "Present",
        skillsStr: entry.skills.join(", "),
      }));
      setSkillsList(savedSkills);
      setSkillInput("");
      setExpRows(savedRows);
      setSkillsExpSnapshot({ skills: savedSkills, expRows: savedRows });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] skills/experience save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setSkillsExpSaving(false);
    }
  }

  function handleRemoteProfCancel() {
    if (!remoteProfSnapshot) return;
    setRemoteJobTitles(remoteProfSnapshot.jobTitles);
    setRemoteBio(remoteProfSnapshot.bio);
    setRemoteHourlyRate(remoteProfSnapshot.hourlyRate);
    setRemoteHoursPerWeek(remoteProfSnapshot.hoursPerWeek);
    setRemoteProfErrors({});
  }

  async function handleRemoteProfSave() {
    if (!activeProfile) return;
    const errors: typeof remoteProfErrors = {};
    const jobTitles = remoteJobTitles.trim();
    const bio = remoteBio.trim();
    const hourlyRate = remoteHourlyRate.trim();
    const hoursPerWeek = remoteHoursPerWeek.trim();

    if (jobTitles.length > JOB_TITLES_MAX) {
      errors.jobTitles = `Must be ${JOB_TITLES_MAX} characters or fewer.`;
    }
    if (bio.length > 0) {
      if (bio.length < BIO_MIN) {
        errors.bio = `At least ${BIO_MIN} characters.`;
      } else if (bio.length > BIO_MAX) {
        errors.bio = `${BIO_MAX} characters or fewer.`;
      }
    }
    if (hourlyRate.length > 0) {
      const parsed = Number.parseFloat(hourlyRate);
      if (!Number.isFinite(parsed)) {
        errors.hourlyRate = "Numeric value required.";
      } else if (parsed < HOURLY_RATE_MIN || parsed > HOURLY_RATE_MAX) {
        errors.hourlyRate = `Between $${HOURLY_RATE_MIN} and $${HOURLY_RATE_MAX}.`;
      }
    }
    if (
      hoursPerWeek.length > 0 &&
      !(REMOTE_HOURS_PER_WEEK_OPTIONS as readonly string[]).includes(
        hoursPerWeek,
      )
    ) {
      errors.hoursPerWeek = "Pick an option from the list.";
    }

    setRemoteProfErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setRemoteProfSaving(true);
    try {
      const result = await updateRemoteProfessional({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        jobTitles,
        bio,
        hourlyRate,
        hoursPerWeek,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      const savedRate =
        saved.hourlyRate !== null ? String(saved.hourlyRate) : "";
      setRemoteJobTitles(saved.jobTitles);
      setRemoteBio(saved.bio);
      setRemoteHourlyRate(savedRate);
      setRemoteHoursPerWeek(saved.hoursPerWeek);
      setRemoteProfSnapshot({
        jobTitles: saved.jobTitles,
        bio: saved.bio,
        hourlyRate: savedRate,
        hoursPerWeek: saved.hoursPerWeek,
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote prof save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setRemoteProfSaving(false);
    }
  }

  function handleRemoteAvailCancel() {
    if (!remoteAvailSnapshot) return;
    setRemoteAvailChoice(remoteAvailSnapshot.availChoice);
    setRemoteAvailFromDate(remoteAvailSnapshot.availableFromDate);
    setRemoteWorkType(remoteAvailSnapshot.workType);
    setRemoteAvailErrors({});
  }

  async function handleRemoteAvailSave() {
    if (!activeProfile) return;
    const errors: typeof remoteAvailErrors = {};
    const workType = remoteWorkType.trim();
    const availableFromDate = remoteAvailFromDate.trim();

    if (remoteAvailChoice === "future") {
      if (!availableFromDate) {
        errors.availableFromDate = "Pick a date.";
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(availableFromDate)) {
        errors.availableFromDate = "Pick a valid date.";
      } else {
        const chosen = new Date(availableFromDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (Number.isNaN(chosen.getTime()) || chosen <= today) {
          errors.availableFromDate = "Pick a future date (tomorrow or later).";
        }
      }
    }
    if (
      workType.length > 0 &&
      !(REMOTE_WORK_TYPE_OPTIONS as readonly string[]).includes(workType)
    ) {
      errors.workType = "Pick an option from the list.";
    }

    setRemoteAvailErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setRemoteAvailSaving(true);
    try {
      const result = await updateRemoteAvailabilityWorkType({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        availChoice: remoteAvailChoice,
        availableFromDate:
          remoteAvailChoice === "future" ? availableFromDate : "",
        workType,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      let nextChoice: RemoteAvailChoice = "";
      if (saved.availability.startsWith("Available from ")) {
        nextChoice = "future";
      } else if (saved.availability === "Available Now") {
        nextChoice = "now";
      } else if (saved.availability === "Available within 2 weeks") {
        nextChoice = "twoWeeks";
      }
      setRemoteAvailChoice(nextChoice);
      setRemoteAvailFromDate(saved.availableFromDate);
      setRemoteWorkType(saved.workType);
      setRemoteAvailSnapshot({
        availChoice: nextChoice,
        availableFromDate: saved.availableFromDate,
        workType: saved.workType,
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote avail save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setRemoteAvailSaving(false);
    }
  }

  function commitRemoteSkillInput() {
    const raw = remoteSkillInput.trim();
    if (!raw) return;
    if (raw.length > SKILL_CHAR_MAX) {
      setRemoteSkillsErrors({
        general: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
      });
      return;
    }
    const lower = raw.toLowerCase();
    if (remoteSkillsList.some((s) => s.toLowerCase() === lower)) {
      setRemoteSkillInput("");
      return;
    }
    if (remoteSkillsList.length >= SKILLS_MAX) {
      setRemoteSkillsErrors({
        general: `You can list up to ${SKILLS_MAX} skills.`,
      });
      return;
    }
    setRemoteSkillsList((prev) => [...prev, raw]);
    setRemoteSkillInput("");
    setRemoteSkillsErrors({});
  }

  function handleRemoteSkillKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitRemoteSkillInput();
    } else if (
      e.key === "Backspace" &&
      remoteSkillInput === "" &&
      remoteSkillsList.length > 0
    ) {
      setRemoteSkillsList((prev) => prev.slice(0, -1));
    }
  }

  function removeRemoteSkillAt(index: number) {
    setRemoteSkillsList((prev) => prev.filter((_, i) => i !== index));
  }

  function handleRemoteSkillsCancel() {
    if (!remoteSkillsSnapshot) return;
    setRemoteSkillsList(remoteSkillsSnapshot);
    setRemoteSkillInput("");
    setRemoteSkillsErrors({});
  }

  async function handleRemoteSkillsSave() {
    if (!activeProfile) return;
    let pending = [...remoteSkillsList];
    const raw = remoteSkillInput.trim();
    if (raw) {
      if (raw.length > SKILL_CHAR_MAX) {
        setRemoteSkillsErrors({
          general: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
        });
        return;
      }
      if (!pending.some((s) => s.toLowerCase() === raw.toLowerCase())) {
        if (pending.length >= SKILLS_MAX) {
          setRemoteSkillsErrors({
            general: `You can list up to ${SKILLS_MAX} skills.`,
          });
          return;
        }
        pending = [...pending, raw];
      }
    }
    setRemoteSkillsErrors({});
    setRemoteSkillsSaving(true);
    try {
      const result = await updateRemoteSkills({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        skills: pending,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      setRemoteSkillsList(result.data.skills);
      setRemoteSkillInput("");
      setRemoteSkillsSnapshot(result.data.skills);
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote skills save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setRemoteSkillsSaving(false);
    }
  }

  function handleRemoteEduCancel() {
    if (!remoteEduSnapshot) return;
    setRemoteEduInstitution(remoteEduSnapshot.institution);
    setRemoteEduDegree(remoteEduSnapshot.degree);
    setRemoteEduStart(remoteEduSnapshot.start);
    setRemoteEduEnd(remoteEduSnapshot.end);
    setRemoteEduErrors({});
  }

  async function handleRemoteEduSave() {
    if (!activeProfile) return;
    const errors: typeof remoteEduErrors = {};
    const institution = remoteEduInstitution.trim();
    const degree = remoteEduDegree.trim();
    const start = remoteEduStart.trim();
    const end = remoteEduEnd.trim();

    if (institution.length > EDU_FIELD_MAX)
      errors.institution = `Must be ${EDU_FIELD_MAX} characters or fewer.`;
    if (degree.length > EDU_FIELD_MAX)
      errors.degree = `Must be ${EDU_FIELD_MAX} characters or fewer.`;
    if (start.length > EDU_FIELD_MAX)
      errors.start = `Must be ${EDU_FIELD_MAX} characters or fewer.`;
    if (end.length > EDU_FIELD_MAX)
      errors.end = `Must be ${EDU_FIELD_MAX} characters or fewer.`;

    setRemoteEduErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setRemoteEduSaving(true);
    try {
      const result = await updateRemoteEducation({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        institution,
        degree,
        start,
        end,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      setRemoteEduInstitution(saved.institution);
      setRemoteEduDegree(saved.degree);
      setRemoteEduStart(saved.start);
      setRemoteEduEnd(saved.end);
      setRemoteEduSnapshot({
        institution: saved.institution,
        degree: saved.degree,
        start: saved.start,
        end: saved.end,
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote edu save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setRemoteEduSaving(false);
    }
  }

  function addEmploymentRow() {
    if (employmentRows.length >= EMPLOYMENT_MAX) {
      setEmploymentErrors((prev) => ({
        ...prev,
        general: `Up to ${EMPLOYMENT_MAX} entries.`,
      }));
      return;
    }
    setEmploymentRows((prev) => [...prev, makeEmptyEmploymentRow()]);
  }
  function removeEmploymentRow(uiId: string) {
    setEmploymentRows((prev) => prev.filter((r) => r.uiId !== uiId));
  }
  function updateEmploymentRow(
    uiId: string,
    patch: Partial<EmploymentRowState>,
  ) {
    setEmploymentRows((prev) =>
      prev.map((r) => (r.uiId === uiId ? { ...r, ...patch } : r)),
    );
  }
  function handleEmploymentCancel() {
    if (!employmentSnapshot) return;
    setEmploymentRows(employmentSnapshot);
    setEmploymentErrors({});
  }
  async function handleEmploymentSave() {
    if (!activeProfile) return;
    const rowErrors: NonNullable<typeof employmentErrors.rows> = {};
    for (const row of employmentRows) {
      const e: { title?: string; company?: string; start?: string; end?: string; description?: string } = {};
      if (row.title.length > EMPLOYMENT_FIELD_MAX)
        e.title = `≤${EMPLOYMENT_FIELD_MAX} chars.`;
      if (row.company.length > EMPLOYMENT_FIELD_MAX)
        e.company = `≤${EMPLOYMENT_FIELD_MAX} chars.`;
      if (row.start.length > EMPLOYMENT_FIELD_MAX)
        e.start = `≤${EMPLOYMENT_FIELD_MAX} chars.`;
      if (row.end.length > EMPLOYMENT_FIELD_MAX)
        e.end = `≤${EMPLOYMENT_FIELD_MAX} chars.`;
      if (row.description.length > EMPLOYMENT_DESCRIPTION_MAX)
        e.description = `≤${EMPLOYMENT_DESCRIPTION_MAX} chars.`;
      if (Object.keys(e).length > 0) rowErrors[row.uiId] = e;
    }
    if (Object.keys(rowErrors).length > 0) {
      setEmploymentErrors({ rows: rowErrors });
      return;
    }
    setEmploymentErrors({});
    setEmploymentSaving(true);
    try {
      const payload = employmentRows.map((r) => ({
        title: r.title.trim(),
        company: r.company.trim(),
        start: r.start.trim(),
        end: r.end.trim(),
        description: r.description.trim(),
      }));
      const result = await updateRemoteEmployment({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        employment: payload,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const savedRows: EmploymentRowState[] = result.data.employment.map(
        (e, i) => ({
          uiId: `emp-${i}-${Math.random().toString(36).slice(2)}`,
          title: e.title,
          company: e.company,
          start: e.start,
          end: e.end,
          description: e.description,
        }),
      );
      setEmploymentRows(savedRows);
      setEmploymentSnapshot(savedRows);
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote employment save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setEmploymentSaving(false);
    }
  }

  function addLanguageRow() {
    if (languageRows.length >= LANGUAGES_MAX) {
      setLanguagesErrors((prev) => ({
        ...prev,
        general: `Up to ${LANGUAGES_MAX} languages.`,
      }));
      return;
    }
    setLanguageRows((prev) => [...prev, makeEmptyLanguageRow()]);
  }
  function removeLanguageRow(uiId: string) {
    setLanguageRows((prev) => prev.filter((r) => r.uiId !== uiId));
  }
  function updateLanguageRow(uiId: string, patch: Partial<LanguageRowState>) {
    setLanguageRows((prev) =>
      prev.map((r) => (r.uiId === uiId ? { ...r, ...patch } : r)),
    );
  }
  function handleLanguagesCancel() {
    if (!languagesSnapshot) return;
    setLanguageRows(languagesSnapshot);
    setLanguagesErrors({});
  }
  async function handleLanguagesSave() {
    if (!activeProfile) return;
    const rowErrors: NonNullable<typeof languagesErrors.rows> = {};
    for (const row of languageRows) {
      const e: { name?: string; level?: string } = {};
      if (row.name.trim().length > LANGUAGE_NAME_MAX)
        e.name = `≤${LANGUAGE_NAME_MAX} chars.`;
      if (
        row.name.trim() &&
        !(REMOTE_LANGUAGE_LEVELS as readonly string[]).includes(row.level)
      ) {
        e.level = "Pick a level.";
      }
      if (Object.keys(e).length > 0) rowErrors[row.uiId] = e;
    }
    if (Object.keys(rowErrors).length > 0) {
      setLanguagesErrors({ rows: rowErrors });
      return;
    }
    setLanguagesErrors({});
    setLanguagesSaving(true);
    try {
      const payload = languageRows.map((r) => ({
        name: r.name.trim(),
        level: r.level,
      }));
      const result = await updateRemoteLanguages({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        languages: payload,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const savedRows: LanguageRowState[] = result.data.languages.map(
        (l, i) => ({
          uiId: `lng-${i}-${Math.random().toString(36).slice(2)}`,
          name: l.name,
          level: l.level,
        }),
      );
      setLanguageRows(savedRows);
      setLanguagesSnapshot(savedRows);
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote languages save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setLanguagesSaving(false);
    }
  }

  function addPortfolioRow() {
    if (portfolioRows.length >= PORTFOLIO_MAX) {
      setPortfolioErrors((prev) => ({
        ...prev,
        general: `Up to ${PORTFOLIO_MAX} entries.`,
      }));
      return;
    }
    setPortfolioRows((prev) => [...prev, makeEmptyPortfolioRow()]);
  }
  function removePortfolioRow(uiId: string) {
    setPortfolioRows((prev) => prev.filter((r) => r.uiId !== uiId));
  }
  function updatePortfolioRow(
    uiId: string,
    patch: Partial<PortfolioRowState>,
  ) {
    setPortfolioRows((prev) =>
      prev.map((r) => (r.uiId === uiId ? { ...r, ...patch } : r)),
    );
  }
  function handlePortfolioCancel() {
    if (!portfolioSnapshot) return;
    setPortfolioRows(portfolioSnapshot);
    setPortfolioErrors({});
  }
  async function handlePortfolioSave() {
    if (!activeProfile) return;
    const rowErrors: NonNullable<typeof portfolioErrors.rows> = {};
    for (const row of portfolioRows) {
      const e: {
        projectTitle?: string;
        role?: string;
        url?: string;
        description?: string;
      } = {};
      if (row.projectTitle.length > PORTFOLIO_FIELD_MAX)
        e.projectTitle = `≤${PORTFOLIO_FIELD_MAX} chars.`;
      if (row.role.length > PORTFOLIO_FIELD_MAX)
        e.role = `≤${PORTFOLIO_FIELD_MAX} chars.`;
      const urlTrim = row.url.trim();
      if (urlTrim.length > PORTFOLIO_URL_MAX) {
        e.url = "URL is too long.";
      } else if (urlTrim && !PORTFOLIO_URL_REGEX.test(urlTrim)) {
        e.url = "Must start with https://";
      }
      if (row.description.length > PORTFOLIO_DESCRIPTION_MAX)
        e.description = `≤${PORTFOLIO_DESCRIPTION_MAX} chars.`;
      if (Object.keys(e).length > 0) rowErrors[row.uiId] = e;
    }
    if (Object.keys(rowErrors).length > 0) {
      setPortfolioErrors({ rows: rowErrors });
      return;
    }
    setPortfolioErrors({});
    setPortfolioSaving(true);
    try {
      const payload = portfolioRows.map((r) => ({
        projectTitle: r.projectTitle.trim(),
        role: r.role.trim(),
        url: r.url.trim(),
        description: r.description.trim(),
      }));
      const result = await updateRemotePortfolio({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        portfolio: payload,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      // Server returns `title`; map back to `projectTitle` for UI state.
      const savedRows: PortfolioRowState[] = result.data.portfolio.map(
        (p, i) => ({
          uiId: `prt-${i}-${Math.random().toString(36).slice(2)}`,
          projectTitle: p.title,
          role: p.role,
          url: p.url,
          description: p.description,
        }),
      );
      setPortfolioRows(savedRows);
      setPortfolioSnapshot(savedRows);
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] remote portfolio save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setPortfolioSaving(false);
    }
  }

  async function handleBasicSave() {
    if (!activeProfile) return;
    const errors: typeof basicErrors = {};
    const fn = basicFirstName.trim();
    const ln = basicLastName.trim();
    const phoneRaw = basicPhone.trim();
    const linkRaw = basicLinkedin.trim();
    const isRemote = activeProfile.sourceTable === "hire_remote_profiles";
    const nameMax = isRemote ? 120 : 80;

    if (!fn) errors.firstName = "First name is required.";
    else if (fn.length > nameMax)
      errors.firstName = `Must be ${nameMax} characters or fewer.`;
    if (!ln) errors.lastName = "Last name is required.";
    else if (ln.length > nameMax)
      errors.lastName = `Must be ${nameMax} characters or fewer.`;

    if (isRemote) {
      if (!phoneRaw) {
        errors.phone = "Phone number is required.";
      } else if (phoneRaw.length < 7) {
        errors.phone = "Phone number looks too short.";
      }
      if (!linkRaw) {
        errors.linkedinUrl = "LinkedIn profile URL is required.";
      } else if (!REMOTE_LINKEDIN_REGEX.test(linkRaw)) {
        errors.linkedinUrl =
          "Use your linkedin.com/in/your-name URL (include https://).";
      }
    } else {
      if (phoneRaw && phoneRaw.length < 7) {
        errors.phone = "Phone number looks too short.";
      }
      if (linkRaw && !linkRaw.toLowerCase().includes("linkedin.com")) {
        errors.linkedinUrl = "Use your linkedin.com URL.";
      }
    }

    setBasicErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setBasicSaving(true);
    try {
      const result = isRemote
        ? await updateRemoteBasicInfo({
            profileId: activeProfile.id,
            sourceTable: activeProfile.sourceTable,
            firstName: fn,
            lastName: ln,
            phone: phoneRaw,
            linkedinUrl: linkRaw,
          })
        : await updateTalentBasicInfo({
            profileId: activeProfile.id,
            sourceTable: activeProfile.sourceTable,
            firstName: fn,
            lastName: ln,
            phone: phoneRaw || null,
            linkedinUrl: linkRaw || null,
          });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const savedPhone =
        "phone" in result.data ? (result.data.phone ?? "") : "";
      const savedLinkedin =
        "linkedinUrl" in result.data
          ? (result.data.linkedinUrl ?? "")
          : "";
      setBasicFirstName(result.data.firstName);
      setBasicLastName(result.data.lastName);
      setBasicPhone(savedPhone);
      setBasicLinkedin(savedLinkedin);
      setBasicSnapshot({
        firstName: result.data.firstName,
        lastName: result.data.lastName,
        phone: savedPhone,
        linkedin: savedLinkedin,
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] basic save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setBasicSaving(false);
    }
  }

  if (!activeProfile) {
    return (
      <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4">
            <div>
              <p className="text-xs text-gray-400">Signed in as {email}</p>
              <h1 className="font-heading text-2xl font-bold text-gray-900">
                Edit your profile
              </h1>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          <div className="rounded-2xl border border-dashed border-black/10 bg-white px-6 py-12 text-center">
            <p className="font-heading text-sm font-semibold text-gray-700">
              No profile found for this email yet
            </p>
            <p className="mt-1 text-xs text-gray-400">
              If you applied with a different email, sign out and try again.
              Otherwise, your application may still be in review.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const completePct = activeProfile.matchScore.pct;
  const basicCount = basicInfoFilledCount(activeProfile);
  const locCount = locationFilledCount(activeProfile);
  const profCount = professionalFilledCount(activeProfile);
  const availCount = availSalaryFilledCount(activeProfile);
  const skillsCount = skillsExpFilledCount(activeProfile);
  const remoteProfCount = remoteProfessionalFilledCount(activeProfile);
  const remoteAvailCount = remoteAvailWorkTypeFilledCount(activeProfile);
  const remoteSkillsCount = remoteSkillsFilledCount(activeProfile);
  const remoteEduCount = remoteEducationFilledCount(activeProfile);
  const remoteEmploymentCount = remoteEmploymentFilledCount(activeProfile);
  const remoteLanguagesCount = remoteLanguagesFilledCount(activeProfile);
  const remotePortfolioCount = remotePortfolioFilledCount(activeProfile);
  const rawSummary = (activeProfile.raw.summary as string | null) ?? null;
  const rawRoleCategory =
    (activeProfile.raw.role_category as string | null) ?? null;
  const summaryEmpty = !rawSummary?.trim();
  const roleCategoryEmpty = !rawRoleCategory?.trim();
  const showBoostBadge =
    profCount > 0 && profCount < 5 && (summaryEmpty || roleCategoryEmpty);

  const professionalBadge: { className: string; label: string } =
    profCount === 5
      ? { className: "bg-green-100 text-green-700", label: "Complete" }
      : profCount === 0
        ? { className: "bg-red-100 text-red-700", label: "Empty" }
        : showBoostBadge
          ? { className: "bg-amber-100 text-amber-800", label: "Boost score" }
          : {
              className: "bg-amber-100 text-amber-800",
              label: `${profCount} of 5 filled`,
            };

  const sections = getSectionsForPool(activeProfile.sourceTable, {
    basic: basicCount,
    location: locCount,
    professional: profCount,
    availability: availCount,
    skills: skillsCount,
    professionalBadge,
    remoteProf: remoteProfCount,
    remoteAvail: remoteAvailCount,
    remoteSkills: remoteSkillsCount,
    remoteEdu: remoteEduCount,
    remoteEmployment: remoteEmploymentCount,
    remoteLanguages: remoteLanguagesCount,
    remotePortfolio: remotePortfolioCount,
  });

  return (
    <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm">
          <Link
            href="/talent/dashboard"
            className="inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900"
          >
            <span aria-hidden="true">←</span>
            Back to dashboard
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {/* PLACEHOLDER — real "last saved" timestamp comes in a later phase */}
            <span className="hidden text-xs text-gray-400 md:inline">
              Last saved just now
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-remotiv-purple px-3 py-1 text-xs font-bold text-white">
              {completePct}% complete
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>

        {profiles.length > 1 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {profiles.map((p) => {
              const active = p.sourceTable === activeProfile.sourceTable;
              return (
                <button
                  key={p.sourceTable}
                  type="button"
                  onClick={() => setActivePool(p.sourceTable)}
                  className={
                    active
                      ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                      : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  }
                >
                  {p.poolLabel}
                </button>
              );
            })}
          </div>
        )}

        {sections.map((section) => {
          const isOpen = openSections.has(section.key);
          return (
            <section
              key={section.key}
              className="mb-3 overflow-hidden rounded-2xl border border-black/[0.06] bg-white"
            >
              <button
                type="button"
                onClick={() => toggleSection(section.key)}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50"
                aria-expanded={isOpen}
                aria-controls={`section-${section.key}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={
                      isOpen
                        ? "inline-flex rotate-90 text-gray-400 transition-transform"
                        : "inline-flex text-gray-400 transition-transform"
                    }
                  >
                    <ChevronRightIcon />
                  </span>
                  <span className="font-heading text-base font-semibold text-gray-900">
                    {section.title}
                  </span>
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${section.badge.className}`}
                >
                  {section.key === "cv" && <LockIcon />}
                  {section.badge.label}
                </span>
              </button>

              {isOpen && (
                <div
                  id={`section-${section.key}`}
                  className="border-t border-black/[0.06] px-5 py-5"
                >
                  {section.key === "basic" &&
                    activeProfile.sourceTable === "talent_profiles" && (
                      <div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>First name</span>
                            <input
                              type="text"
                              value={basicFirstName}
                              onChange={(e) =>
                                setBasicFirstName(e.target.value)
                              }
                              maxLength={80}
                              aria-invalid={Boolean(basicErrors.firstName)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.firstName && (
                              <span className="text-xs text-red-600">
                                {basicErrors.firstName}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Last name</span>
                            <input
                              type="text"
                              value={basicLastName}
                              onChange={(e) =>
                                setBasicLastName(e.target.value)
                              }
                              maxLength={80}
                              aria-invalid={Boolean(basicErrors.lastName)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.lastName && (
                              <span className="text-xs text-red-600">
                                {basicErrors.lastName}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Phone</span>
                            <input
                              type="tel"
                              value={basicPhone}
                              onChange={(e) => setBasicPhone(e.target.value)}
                              maxLength={40}
                              placeholder="+92 300 0000000"
                              aria-invalid={Boolean(basicErrors.phone)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.phone && (
                              <span className="text-xs text-red-600">
                                {basicErrors.phone}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>LinkedIn URL</span>
                            <input
                              type="url"
                              value={basicLinkedin}
                              onChange={(e) =>
                                setBasicLinkedin(e.target.value)
                              }
                              maxLength={300}
                              placeholder="linkedin.com/in/yourname"
                              aria-invalid={Boolean(basicErrors.linkedinUrl)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.linkedinUrl && (
                              <span className="text-xs text-red-600">
                                {basicErrors.linkedinUrl}
                              </span>
                            )}
                          </label>
                        </div>
                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleBasicCancel}
                            disabled={basicSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleBasicSave}
                            disabled={basicSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {basicSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "basic" &&
                    activeProfile.sourceTable === "hire_remote_profiles" && (
                      <div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>First name</span>
                            <input
                              type="text"
                              value={basicFirstName}
                              onChange={(e) =>
                                setBasicFirstName(e.target.value)
                              }
                              maxLength={120}
                              aria-invalid={Boolean(basicErrors.firstName)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.firstName && (
                              <span className="text-xs text-red-600">
                                {basicErrors.firstName}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Last name</span>
                            <input
                              type="text"
                              value={basicLastName}
                              onChange={(e) =>
                                setBasicLastName(e.target.value)
                              }
                              maxLength={120}
                              aria-invalid={Boolean(basicErrors.lastName)}
                              className={INPUT_CLASS}
                            />
                            {basicErrors.lastName && (
                              <span className="text-xs text-red-600">
                                {basicErrors.lastName}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Phone</span>
                            <input
                              type="tel"
                              value={basicPhone}
                              onChange={(e) => setBasicPhone(e.target.value)}
                              maxLength={40}
                              placeholder="+1 415 0000000"
                              aria-invalid={Boolean(basicErrors.phone)}
                              className={INPUT_CLASS}
                              required
                            />
                            {basicErrors.phone && (
                              <span className="text-xs text-red-600">
                                {basicErrors.phone}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>LinkedIn URL</span>
                            <input
                              type="url"
                              value={basicLinkedin}
                              onChange={(e) =>
                                setBasicLinkedin(e.target.value)
                              }
                              maxLength={500}
                              placeholder="https://linkedin.com/in/your-name"
                              aria-invalid={Boolean(basicErrors.linkedinUrl)}
                              className={INPUT_CLASS}
                              required
                            />
                            <p className="mt-1 text-[11px] text-gray-500">
                              Must be a LinkedIn profile URL
                              (https://linkedin.com/in/your-name)
                            </p>
                            {basicErrors.linkedinUrl && (
                              <span className="text-xs text-red-600">
                                {basicErrors.linkedinUrl}
                              </span>
                            )}
                          </label>
                        </div>
                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleBasicCancel}
                            disabled={basicSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleBasicSave}
                            disabled={basicSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {basicSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "location" &&
                    activeProfile.sourceTable === "talent_profiles" && (
                      <div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>City</span>
                            <input
                              type="text"
                              value={locCity}
                              onChange={(e) => setLocCity(e.target.value)}
                              maxLength={120}
                              aria-invalid={Boolean(locErrors.city)}
                              className={INPUT_CLASS}
                            />
                            {locErrors.city && (
                              <span className="text-xs text-red-600">
                                {locErrors.city}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Country</span>
                            <select
                              value={locCountry}
                              onChange={(e) => setLocCountry(e.target.value)}
                              aria-invalid={Boolean(locErrors.country)}
                              className={INPUT_CLASS}
                            >
                              <option value="">—</option>
                              {COUNTRY_OPTIONS.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            {locErrors.country && (
                              <span className="text-xs text-red-600">
                                {locErrors.country}
                              </span>
                            )}
                          </label>
                        </div>
                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleLocationCancel}
                            disabled={locSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleLocationSave}
                            disabled={locSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {locSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "location" &&
                    activeProfile.sourceTable === "hire_remote_profiles" && (
                      <div>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>City</span>
                            <input
                              type="text"
                              value={locCity}
                              onChange={(e) => setLocCity(e.target.value)}
                              maxLength={120}
                              aria-invalid={Boolean(locErrors.city)}
                              className={INPUT_CLASS}
                            />
                            {locErrors.city && (
                              <span className="text-xs text-red-600">
                                {locErrors.city}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Country</span>
                            <select
                              value={locCountry}
                              onChange={(e) => setLocCountry(e.target.value)}
                              aria-invalid={Boolean(locErrors.country)}
                              className={INPUT_CLASS}
                            >
                              <option value="">—</option>
                              {COUNTRY_OPTIONS.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            {locErrors.country && (
                              <span className="text-xs text-red-600">
                                {locErrors.country}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5 md:col-span-2">
                            <span className={LABEL_CLASS}>Time zone</span>
                            <select
                              value={locTimeZone}
                              onChange={(e) => setLocTimeZone(e.target.value)}
                              aria-invalid={Boolean(locErrors.timeZone)}
                              className={INPUT_CLASS}
                            >
                              <option value="">Select a time zone…</option>
                              {TIME_ZONE_GROUPS.map((g) => (
                                <optgroup key={g.region} label={g.region}>
                                  {g.zones.map((z) => (
                                    <option key={z} value={z}>
                                      {z}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            {locErrors.timeZone && (
                              <span className="text-xs text-red-600">
                                {locErrors.timeZone}
                              </span>
                            )}
                          </label>
                        </div>
                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleLocationCancel}
                            disabled={locSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleLocationSave}
                            disabled={locSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {locSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "professional" &&
                    activeProfile.sourceTable === "hire_remote_profiles" && (
                      <div>
                        <div className="flex flex-col gap-4">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Job title(s)</span>
                            <input
                              type="text"
                              value={remoteJobTitles}
                              onChange={(e) =>
                                setRemoteJobTitles(e.target.value)
                              }
                              maxLength={JOB_TITLES_MAX}
                              placeholder="Full Stack Developer, Backend Developer"
                              aria-invalid={Boolean(remoteProfErrors.jobTitles)}
                              className={INPUT_CLASS}
                            />
                            {remoteProfErrors.jobTitles && (
                              <span className="text-xs text-red-600">
                                {remoteProfErrors.jobTitles}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>Bio</span>
                            <textarea
                              rows={5}
                              maxLength={BIO_MAX}
                              value={remoteBio}
                              onChange={(e) => setRemoteBio(e.target.value)}
                              aria-invalid={Boolean(remoteProfErrors.bio)}
                              className={INPUT_CLASS}
                            />
                            <span
                              className={
                                remoteBio.length > 0 &&
                                remoteBio.length < BIO_MIN
                                  ? "text-[11px] text-red-600"
                                  : "text-[11px] text-gray-400"
                              }
                            >
                              {remoteBio.length} / {BIO_MAX}
                              {remoteBio.length > 0 && remoteBio.length < BIO_MIN
                                ? ` · ${BIO_MIN} minimum`
                                : ""}
                            </span>
                            {remoteProfErrors.bio && (
                              <span className="text-xs text-red-600">
                                {remoteProfErrors.bio}
                              </span>
                            )}
                          </label>
                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <label className="flex flex-col gap-1.5">
                              <span className={LABEL_CLASS}>
                                Hourly rate (USD)
                              </span>
                              <input
                                type="number"
                                min={HOURLY_RATE_MIN}
                                max={HOURLY_RATE_MAX}
                                step={1}
                                value={remoteHourlyRate}
                                onChange={(e) =>
                                  setRemoteHourlyRate(e.target.value)
                                }
                                aria-invalid={Boolean(remoteProfErrors.hourlyRate)}
                                placeholder={`${HOURLY_RATE_MIN}–${HOURLY_RATE_MAX}`}
                                className={INPUT_CLASS}
                              />
                              {remoteProfErrors.hourlyRate && (
                                <span className="text-xs text-red-600">
                                  {remoteProfErrors.hourlyRate}
                                </span>
                              )}
                            </label>
                          </div>
                          <fieldset className="flex flex-col gap-2">
                            <legend className={LABEL_CLASS}>
                              Hours per week
                            </legend>
                            <div className="flex flex-wrap gap-2">
                              {REMOTE_HOURS_PER_WEEK_OPTIONS.map((opt) => {
                                const selected = remoteHoursPerWeek === opt;
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => setRemoteHoursPerWeek(opt)}
                                    aria-pressed={selected}
                                    className={
                                      selected
                                        ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                                        : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                    }
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                            {remoteProfErrors.hoursPerWeek && (
                              <span className="text-xs text-red-600">
                                {remoteProfErrors.hoursPerWeek}
                              </span>
                            )}
                          </fieldset>
                        </div>
                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleRemoteProfCancel}
                            disabled={remoteProfSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleRemoteProfSave}
                            disabled={remoteProfSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {remoteProfSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "professional" &&
                    activeProfile.sourceTable === "talent_profiles" && (
                    <div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Job title</span>
                          <input
                            type="text"
                            value={profJobTitle}
                            onChange={(e) => setProfJobTitle(e.target.value)}
                            maxLength={120}
                            aria-invalid={Boolean(profErrors.jobTitle)}
                            className={INPUT_CLASS}
                          />
                          {profErrors.jobTitle && (
                            <span className="text-xs text-red-600">
                              {profErrors.jobTitle}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Role category</span>
                          <select
                            value={profRoleCategory}
                            onChange={(e) => setProfRoleCategory(e.target.value)}
                            aria-invalid={Boolean(profErrors.roleCategory)}
                            className={INPUT_CLASS}
                          >
                            <option value="">—</option>
                            {ROLE_CATEGORY_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          {profErrors.roleCategory && (
                            <span className="text-xs text-red-600">
                              {profErrors.roleCategory}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Years of experience</span>
                          <input
                            type="number"
                            min={0}
                            max={70}
                            step={1}
                            value={profYearsExperience}
                            onChange={(e) =>
                              setProfYearsExperience(e.target.value)
                            }
                            aria-invalid={Boolean(profErrors.yearsExperience)}
                            className={INPUT_CLASS}
                          />
                          {profErrors.yearsExperience && (
                            <span className="text-xs text-red-600">
                              {profErrors.yearsExperience}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Industry</span>
                          <select
                            value={profIndustry}
                            onChange={(e) => setProfIndustry(e.target.value)}
                            aria-invalid={Boolean(profErrors.industry)}
                            className={INPUT_CLASS}
                          >
                            <option value="">—</option>
                            {INDUSTRY_OPTIONS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          {profErrors.industry && (
                            <span className="text-xs text-red-600">
                              {profErrors.industry}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5 md:col-span-2">
                          <span className={LABEL_CLASS}>Summary</span>
                          <textarea
                            rows={5}
                            maxLength={5000}
                            value={profSummary}
                            onChange={(e) => setProfSummary(e.target.value)}
                            aria-invalid={Boolean(profErrors.summary)}
                            className={INPUT_CLASS}
                          />
                          <span className="text-[11px] text-gray-400">
                            {profSummary.length} / 5000
                          </span>
                          {profErrors.summary && (
                            <span className="text-xs text-red-600">
                              {profErrors.summary}
                            </span>
                          )}
                        </label>
                      </div>
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleProfessionalCancel}
                          disabled={profSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleProfessionalSave}
                          disabled={profSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {profSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "availability" &&
                    activeProfile.sourceTable === "hire_remote_profiles" && (
                      <div>
                        <div className="flex flex-col gap-5">
                          <fieldset className="flex flex-col gap-2">
                            <legend className={LABEL_CLASS}>
                              When are you available?
                            </legend>
                            <div className="flex flex-wrap gap-2">
                              {REMOTE_AVAIL_CHOICES.map((opt) => {
                                const selected = remoteAvailChoice === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() =>
                                      setRemoteAvailChoice(opt.value)
                                    }
                                    aria-pressed={selected}
                                    className={
                                      selected
                                        ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                                        : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                    }
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                            {remoteAvailChoice === "future" && (
                              <label className="mt-2 flex max-w-xs flex-col gap-1">
                                <span className={LABEL_CLASS}>
                                  Available from
                                </span>
                                <input
                                  type="date"
                                  value={remoteAvailFromDate}
                                  min={(() => {
                                    const t = new Date();
                                    t.setDate(t.getDate() + 1);
                                    return t.toISOString().slice(0, 10);
                                  })()}
                                  onChange={(e) =>
                                    setRemoteAvailFromDate(e.target.value)
                                  }
                                  aria-invalid={Boolean(
                                    remoteAvailErrors.availableFromDate,
                                  )}
                                  className={INPUT_CLASS}
                                />
                                {remoteAvailErrors.availableFromDate && (
                                  <span className="text-xs text-red-600">
                                    {remoteAvailErrors.availableFromDate}
                                  </span>
                                )}
                              </label>
                            )}
                          </fieldset>

                          <fieldset className="flex flex-col gap-2">
                            <legend className={LABEL_CLASS}>Work type</legend>
                            <div className="flex flex-wrap gap-2">
                              {REMOTE_WORK_TYPE_OPTIONS.map((opt) => {
                                const selected = remoteWorkType === opt;
                                return (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => setRemoteWorkType(opt)}
                                    aria-pressed={selected}
                                    className={
                                      selected
                                        ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                                        : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                    }
                                  >
                                    {opt}
                                  </button>
                                );
                              })}
                            </div>
                            {remoteAvailErrors.workType && (
                              <span className="text-xs text-red-600">
                                {remoteAvailErrors.workType}
                              </span>
                            )}
                          </fieldset>
                        </div>

                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleRemoteAvailCancel}
                            disabled={remoteAvailSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleRemoteAvailSave}
                            disabled={remoteAvailSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {remoteAvailSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "availability" &&
                    activeProfile.sourceTable === "talent_profiles" && (
                    <div>
                      <div className="flex flex-col gap-5">
                        <fieldset className="flex flex-col gap-2">
                          <legend className={LABEL_CLASS}>Availability</legend>
                          <div className="flex flex-wrap gap-2">
                            {AVAILABILITY_OPTIONS.map((opt) => {
                              const selected = availAvailability === opt;
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => setAvailAvailability(opt)}
                                  className={
                                    selected
                                      ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                                      : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                  }
                                  aria-pressed={selected}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                          {availErrors.availability && (
                            <span className="text-xs text-red-600">
                              {availErrors.availability}
                            </span>
                          )}
                        </fieldset>

                        <fieldset className="flex flex-col gap-2">
                          <legend className={LABEL_CLASS}>Work type</legend>
                          <div className="flex flex-wrap gap-2">
                            {WORK_TYPE_OPTIONS.map((opt) => {
                              const selected = availWorkType === opt;
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => setAvailWorkType(opt)}
                                  className={
                                    selected
                                      ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                                      : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                  }
                                  aria-pressed={selected}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                          {availErrors.workType && (
                            <span className="text-xs text-red-600">
                              {availErrors.workType}
                            </span>
                          )}
                        </fieldset>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>
                              Salary min (USD / month)
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={100_000_000}
                              step={1}
                              value={availSalaryMin}
                              onChange={(e) => setAvailSalaryMin(e.target.value)}
                              aria-invalid={Boolean(availErrors.salaryMin)}
                              className={INPUT_CLASS}
                            />
                            {availErrors.salaryMin && (
                              <span className="text-xs text-red-600">
                                {availErrors.salaryMin}
                              </span>
                            )}
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className={LABEL_CLASS}>
                              Salary max (USD / month)
                            </span>
                            <input
                              type="number"
                              min={0}
                              max={100_000_000}
                              step={1}
                              value={availSalaryMax}
                              onChange={(e) => setAvailSalaryMax(e.target.value)}
                              aria-invalid={Boolean(availErrors.salaryMax)}
                              className={INPUT_CLASS}
                            />
                            {availErrors.salaryMax && (
                              <span className="text-xs text-red-600">
                                {availErrors.salaryMax}
                              </span>
                            )}
                          </label>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleAvailSalaryCancel}
                          disabled={availSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleAvailSalarySave}
                          disabled={availSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {availSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "skills" &&
                    activeProfile.sourceTable === "hire_remote_profiles" && (
                      <div>
                        <div className="mb-6">
                          <p className={`${LABEL_CLASS} mb-2 block`}>Skills</p>
                          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 bg-white p-2">
                            {remoteSkillsList.map((s, i) => (
                              <span
                                key={`${s}-${i}`}
                                className="inline-flex items-center gap-1 rounded-full bg-remotiv-purple/10 px-2.5 py-1 text-xs font-semibold text-remotiv-purple"
                              >
                                {s}
                                <button
                                  type="button"
                                  onClick={() => removeRemoteSkillAt(i)}
                                  aria-label={`Remove ${s}`}
                                  className="ml-0.5 text-remotiv-purple hover:opacity-70"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            <input
                              type="text"
                              value={remoteSkillInput}
                              onChange={(e) =>
                                setRemoteSkillInput(e.target.value)
                              }
                              onKeyDown={handleRemoteSkillKeyDown}
                              onBlur={commitRemoteSkillInput}
                              placeholder={
                                remoteSkillsList.length === 0
                                  ? "Type a skill and press Enter"
                                  : ""
                              }
                              maxLength={SKILL_CHAR_MAX}
                              className="min-w-[120px] flex-1 border-0 bg-transparent text-sm outline-none"
                            />
                          </div>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {remoteSkillsList.length} / {SKILLS_MAX} · press
                            Enter or comma to add
                          </p>
                        </div>

                        {remoteSkillsErrors.general && (
                          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                            {remoteSkillsErrors.general}
                          </p>
                        )}

                        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={handleRemoteSkillsCancel}
                            disabled={remoteSkillsSaving}
                            className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleRemoteSkillsSave}
                            disabled={remoteSkillsSaving}
                            className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {remoteSkillsSaving ? "Saving…" : "Save changes"}
                          </button>
                        </div>
                      </div>
                    )}

                  {section.key === "skills" &&
                    activeProfile.sourceTable === "talent_profiles" && (
                    <div>
                      <div className="mb-6">
                        <p className={`${LABEL_CLASS} mb-2 block`}>Skills</p>
                        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-gray-200 bg-white p-2">
                          {skillsList.map((s, i) => (
                            <span
                              key={`${s}-${i}`}
                              className="inline-flex items-center gap-1 rounded-full bg-remotiv-purple/10 px-2.5 py-1 text-xs font-semibold text-remotiv-purple"
                            >
                              {s}
                              <button
                                type="button"
                                onClick={() => removeSkillAt(i)}
                                aria-label={`Remove ${s}`}
                                className="ml-0.5 text-remotiv-purple hover:opacity-70"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <input
                            type="text"
                            value={skillInput}
                            onChange={(e) => setSkillInput(e.target.value)}
                            onKeyDown={handleSkillInputKeyDown}
                            onBlur={commitSkillInput}
                            placeholder={
                              skillsList.length === 0
                                ? "Type a skill and press Enter"
                                : ""
                            }
                            maxLength={SKILL_CHAR_MAX}
                            className="min-w-[120px] flex-1 border-0 bg-transparent text-sm outline-none"
                          />
                        </div>
                        <p className="mt-1 text-[11px] text-gray-400">
                          {skillsList.length} / {SKILLS_MAX} · press Enter or
                          comma to add
                        </p>
                      </div>

                      <div>
                        <p className={`${LABEL_CLASS} mb-2 block`}>
                          Experience
                        </p>
                        {expRows.length === 0 && (
                          <p className="mb-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                            No experiences yet. Add your first below.
                          </p>
                        )}
                        <div className="flex flex-col gap-3">
                          {expRows.map((row) => {
                            const rowErr =
                              skillsExpErrors.rows?.[row.uiId] ?? {};
                            return (
                              <div
                                key={row.uiId}
                                className="rounded-xl border border-gray-200 bg-white p-4"
                              >
                                <div className="mb-3 flex items-center justify-between">
                                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                                    Role
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      removeExperienceRow(row.uiId)
                                    }
                                    aria-label="Remove this experience"
                                    className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-red-50 hover:text-red-700"
                                  >
                                    <TrashIcon /> Remove
                                  </button>
                                </div>
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                  <label className="flex flex-col gap-1">
                                    <span className={LABEL_CLASS}>
                                      Job title
                                    </span>
                                    <input
                                      type="text"
                                      value={row.title}
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          title: e.target.value,
                                        })
                                      }
                                      maxLength={EXPERIENCE_FIELD_MAX}
                                      className={INPUT_CLASS}
                                    />
                                    {rowErr.title && (
                                      <span className="text-xs text-red-600">
                                        {rowErr.title}
                                      </span>
                                    )}
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className={LABEL_CLASS}>Company</span>
                                    <input
                                      type="text"
                                      value={row.company}
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          company: e.target.value,
                                        })
                                      }
                                      maxLength={EXPERIENCE_FIELD_MAX}
                                      className={INPUT_CLASS}
                                    />
                                    {rowErr.company && (
                                      <span className="text-xs text-red-600">
                                        {rowErr.company}
                                      </span>
                                    )}
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className={LABEL_CLASS}>Start</span>
                                    <input
                                      type="text"
                                      value={row.start}
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          start: e.target.value,
                                        })
                                      }
                                      maxLength={EXPERIENCE_FIELD_MAX}
                                      placeholder="2020-03"
                                      className={INPUT_CLASS}
                                    />
                                    {rowErr.start && (
                                      <span className="text-xs text-red-600">
                                        {rowErr.start}
                                      </span>
                                    )}
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className={LABEL_CLASS}>End</span>
                                    <input
                                      type="text"
                                      value={
                                        row.currentlyWorking
                                          ? "Present"
                                          : row.end
                                      }
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          end: e.target.value,
                                        })
                                      }
                                      maxLength={EXPERIENCE_FIELD_MAX}
                                      placeholder="2022-12"
                                      disabled={row.currentlyWorking}
                                      className={
                                        row.currentlyWorking
                                          ? `${INPUT_CLASS} bg-gray-50 text-gray-500`
                                          : INPUT_CLASS
                                      }
                                    />
                                    {rowErr.end && (
                                      <span className="text-xs text-red-600">
                                        {rowErr.end}
                                      </span>
                                    )}
                                  </label>
                                  <label className="flex items-center gap-2 md:col-span-2">
                                    <input
                                      type="checkbox"
                                      checked={row.currentlyWorking}
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          currentlyWorking: e.target.checked,
                                          end: e.target.checked ? "" : row.end,
                                        })
                                      }
                                      className="h-4 w-4 rounded border-gray-300 text-remotiv-purple focus:ring-remotiv-purple"
                                    />
                                    <span className="text-xs text-gray-700">
                                      I currently work here
                                    </span>
                                  </label>
                                  <label className="flex flex-col gap-1 md:col-span-2">
                                    <span className={LABEL_CLASS}>
                                      Skills used
                                    </span>
                                    <input
                                      type="text"
                                      value={row.skillsStr}
                                      onChange={(e) =>
                                        updateExperienceRow(row.uiId, {
                                          skillsStr: e.target.value,
                                        })
                                      }
                                      placeholder="React, TypeScript, Node.js (comma-separated)"
                                      className={INPUT_CLASS}
                                    />
                                    {rowErr.skillsStr && (
                                      <span className="text-xs text-red-600">
                                        {rowErr.skillsStr}
                                      </span>
                                    )}
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {expRows.length < EXPERIENCE_MAX && (
                          <button
                            type="button"
                            onClick={addExperienceRow}
                            className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-white py-3 text-xs font-semibold text-gray-600 hover:border-remotiv-purple hover:text-remotiv-purple"
                          >
                            + Add another experience
                          </button>
                        )}
                      </div>

                      {skillsExpErrors.general && (
                        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {skillsExpErrors.general}
                        </p>
                      )}

                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleSkillsExpCancel}
                          disabled={skillsExpSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleSkillsExpSave}
                          disabled={skillsExpSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {skillsExpSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "employment" && (
                    <div>
                      {employmentRows.length === 0 && (
                        <p className="mb-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                          No employment yet. Add your first below.
                        </p>
                      )}
                      <div className="flex flex-col gap-3">
                        {employmentRows.map((row) => {
                          const rowErr = employmentErrors.rows?.[row.uiId] ?? {};
                          return (
                            <div
                              key={row.uiId}
                              className="rounded-xl border border-gray-200 bg-white p-4"
                            >
                              <div className="mb-3 flex items-center justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                                  Role
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeEmploymentRow(row.uiId)}
                                  aria-label="Remove this entry"
                                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-red-50 hover:text-red-700"
                                >
                                  <TrashIcon /> Remove
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>Job title</span>
                                  <input
                                    type="text"
                                    value={row.title}
                                    onChange={(e) =>
                                      updateEmploymentRow(row.uiId, {
                                        title: e.target.value,
                                      })
                                    }
                                    maxLength={EMPLOYMENT_FIELD_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.title && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.title}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>Company</span>
                                  <input
                                    type="text"
                                    value={row.company}
                                    onChange={(e) =>
                                      updateEmploymentRow(row.uiId, {
                                        company: e.target.value,
                                      })
                                    }
                                    maxLength={EMPLOYMENT_FIELD_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.company && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.company}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>Start</span>
                                  <input
                                    type="text"
                                    value={row.start}
                                    onChange={(e) =>
                                      updateEmploymentRow(row.uiId, {
                                        start: e.target.value,
                                      })
                                    }
                                    maxLength={EMPLOYMENT_FIELD_MAX}
                                    placeholder="2020-03"
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.start && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.start}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>End</span>
                                  <input
                                    type="text"
                                    value={row.end}
                                    onChange={(e) =>
                                      updateEmploymentRow(row.uiId, {
                                        end: e.target.value,
                                      })
                                    }
                                    maxLength={EMPLOYMENT_FIELD_MAX}
                                    placeholder="2022-12"
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.end && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.end}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1 md:col-span-2">
                                  <span className={LABEL_CLASS}>
                                    Description
                                  </span>
                                  <textarea
                                    rows={4}
                                    value={row.description}
                                    onChange={(e) =>
                                      updateEmploymentRow(row.uiId, {
                                        description: e.target.value,
                                      })
                                    }
                                    maxLength={EMPLOYMENT_DESCRIPTION_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  <span className="text-[11px] text-gray-400">
                                    {row.description.length} /{" "}
                                    {EMPLOYMENT_DESCRIPTION_MAX}
                                  </span>
                                  {rowErr.description && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.description}
                                    </span>
                                  )}
                                </label>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {employmentRows.length < EMPLOYMENT_MAX && (
                        <button
                          type="button"
                          onClick={addEmploymentRow}
                          className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-white py-3 text-xs font-semibold text-gray-600 hover:border-remotiv-purple hover:text-remotiv-purple"
                        >
                          + Add another employment
                        </button>
                      )}
                      {employmentErrors.general && (
                        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {employmentErrors.general}
                        </p>
                      )}
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleEmploymentCancel}
                          disabled={employmentSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleEmploymentSave}
                          disabled={employmentSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {employmentSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "education" && (
                    <div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Institution</span>
                          <input
                            type="text"
                            value={remoteEduInstitution}
                            onChange={(e) =>
                              setRemoteEduInstitution(e.target.value)
                            }
                            maxLength={EDU_FIELD_MAX}
                            aria-invalid={Boolean(remoteEduErrors.institution)}
                            className={INPUT_CLASS}
                          />
                          {remoteEduErrors.institution && (
                            <span className="text-xs text-red-600">
                              {remoteEduErrors.institution}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Degree</span>
                          <input
                            type="text"
                            value={remoteEduDegree}
                            onChange={(e) =>
                              setRemoteEduDegree(e.target.value)
                            }
                            maxLength={EDU_FIELD_MAX}
                            aria-invalid={Boolean(remoteEduErrors.degree)}
                            className={INPUT_CLASS}
                          />
                          {remoteEduErrors.degree && (
                            <span className="text-xs text-red-600">
                              {remoteEduErrors.degree}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Start</span>
                          <input
                            type="text"
                            value={remoteEduStart}
                            onChange={(e) => setRemoteEduStart(e.target.value)}
                            maxLength={EDU_FIELD_MAX}
                            placeholder="2018-09"
                            aria-invalid={Boolean(remoteEduErrors.start)}
                            className={INPUT_CLASS}
                          />
                          {remoteEduErrors.start && (
                            <span className="text-xs text-red-600">
                              {remoteEduErrors.start}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>End</span>
                          <input
                            type="text"
                            value={remoteEduEnd}
                            onChange={(e) => setRemoteEduEnd(e.target.value)}
                            maxLength={EDU_FIELD_MAX}
                            placeholder="2022-06"
                            aria-invalid={Boolean(remoteEduErrors.end)}
                            className={INPUT_CLASS}
                          />
                          {remoteEduErrors.end && (
                            <span className="text-xs text-red-600">
                              {remoteEduErrors.end}
                            </span>
                          )}
                        </label>
                      </div>
                      <p className="mt-3 text-[11px] text-gray-400">
                        We'll combine your dates as "YYYY-MM–YYYY-MM" on your
                        profile.
                      </p>
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleRemoteEduCancel}
                          disabled={remoteEduSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleRemoteEduSave}
                          disabled={remoteEduSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {remoteEduSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "languages" && (
                    <div>
                      {languageRows.length === 0 && (
                        <p className="mb-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                          No languages yet. Add your first below.
                        </p>
                      )}
                      <div className="flex flex-col gap-3">
                        {languageRows.map((row) => {
                          const rowErr = languagesErrors.rows?.[row.uiId] ?? {};
                          return (
                            <div
                              key={row.uiId}
                              className="rounded-xl border border-gray-200 bg-white p-4"
                            >
                              <div className="mb-3 flex items-center justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                                  Language
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeLanguageRow(row.uiId)}
                                  aria-label="Remove this language"
                                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-red-50 hover:text-red-700"
                                >
                                  <TrashIcon /> Remove
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>Name</span>
                                  <input
                                    type="text"
                                    value={row.name}
                                    onChange={(e) =>
                                      updateLanguageRow(row.uiId, {
                                        name: e.target.value,
                                      })
                                    }
                                    maxLength={LANGUAGE_NAME_MAX}
                                    placeholder="English"
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.name && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.name}
                                    </span>
                                  )}
                                </label>
                                <fieldset className="flex flex-col gap-1">
                                  <legend className={LABEL_CLASS}>Level</legend>
                                  <div className="flex flex-wrap gap-1.5">
                                    {REMOTE_LANGUAGE_LEVELS.map((lvl) => {
                                      const selected = row.level === lvl;
                                      return (
                                        <button
                                          key={lvl}
                                          type="button"
                                          onClick={() =>
                                            updateLanguageRow(row.uiId, {
                                              level: lvl,
                                            })
                                          }
                                          aria-pressed={selected}
                                          className={
                                            selected
                                              ? "rounded-full bg-remotiv-purple px-3 py-1 text-[11px] font-semibold text-white"
                                              : "rounded-full border border-gray-200 bg-white px-3 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                                          }
                                        >
                                          {lvl}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  {rowErr.level && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.level}
                                    </span>
                                  )}
                                </fieldset>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {languageRows.length < LANGUAGES_MAX && (
                        <button
                          type="button"
                          onClick={addLanguageRow}
                          className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-white py-3 text-xs font-semibold text-gray-600 hover:border-remotiv-purple hover:text-remotiv-purple"
                        >
                          + Add another language
                        </button>
                      )}
                      {languagesErrors.general && (
                        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {languagesErrors.general}
                        </p>
                      )}
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleLanguagesCancel}
                          disabled={languagesSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleLanguagesSave}
                          disabled={languagesSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {languagesSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "portfolio" && (
                    <div>
                      {portfolioRows.length === 0 && (
                        <p className="mb-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                          No portfolio entries yet. Add your first below.
                        </p>
                      )}
                      <div className="flex flex-col gap-3">
                        {portfolioRows.map((row) => {
                          const rowErr = portfolioErrors.rows?.[row.uiId] ?? {};
                          return (
                            <div
                              key={row.uiId}
                              className="rounded-xl border border-gray-200 bg-white p-4"
                            >
                              <div className="mb-3 flex items-center justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                                  Project
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removePortfolioRow(row.uiId)}
                                  aria-label="Remove this project"
                                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-red-50 hover:text-red-700"
                                >
                                  <TrashIcon /> Remove
                                </button>
                              </div>
                              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>
                                    Project title
                                  </span>
                                  <input
                                    type="text"
                                    value={row.projectTitle}
                                    onChange={(e) =>
                                      updatePortfolioRow(row.uiId, {
                                        projectTitle: e.target.value,
                                      })
                                    }
                                    maxLength={PORTFOLIO_FIELD_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.projectTitle && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.projectTitle}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1">
                                  <span className={LABEL_CLASS}>Role</span>
                                  <input
                                    type="text"
                                    value={row.role}
                                    onChange={(e) =>
                                      updatePortfolioRow(row.uiId, {
                                        role: e.target.value,
                                      })
                                    }
                                    maxLength={PORTFOLIO_FIELD_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.role && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.role}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1 md:col-span-2">
                                  <span className={LABEL_CLASS}>URL</span>
                                  <input
                                    type="url"
                                    value={row.url}
                                    onChange={(e) =>
                                      updatePortfolioRow(row.uiId, {
                                        url: e.target.value,
                                      })
                                    }
                                    maxLength={PORTFOLIO_URL_MAX}
                                    placeholder="https://example.com/project"
                                    className={INPUT_CLASS}
                                  />
                                  {rowErr.url && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.url}
                                    </span>
                                  )}
                                </label>
                                <label className="flex flex-col gap-1 md:col-span-2">
                                  <span className={LABEL_CLASS}>
                                    Description
                                  </span>
                                  <textarea
                                    rows={3}
                                    value={row.description}
                                    onChange={(e) =>
                                      updatePortfolioRow(row.uiId, {
                                        description: e.target.value,
                                      })
                                    }
                                    maxLength={PORTFOLIO_DESCRIPTION_MAX}
                                    className={INPUT_CLASS}
                                  />
                                  <span className="text-[11px] text-gray-400">
                                    {row.description.length} /{" "}
                                    {PORTFOLIO_DESCRIPTION_MAX}
                                  </span>
                                  {rowErr.description && (
                                    <span className="text-xs text-red-600">
                                      {rowErr.description}
                                    </span>
                                  )}
                                </label>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {portfolioRows.length < PORTFOLIO_MAX && (
                        <button
                          type="button"
                          onClick={addPortfolioRow}
                          className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-gray-300 bg-white py-3 text-xs font-semibold text-gray-600 hover:border-remotiv-purple hover:text-remotiv-purple"
                        >
                          + Add another project
                        </button>
                      )}
                      {portfolioErrors.general && (
                        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {portfolioErrors.general}
                        </p>
                      )}
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handlePortfolioCancel}
                          disabled={portfolioSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handlePortfolioSave}
                          disabled={portfolioSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {portfolioSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "cv" && (
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-500">
                        File uploads come in Phase 4.3.
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">
                        <LockIcon />
                        Locked
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}

        <p className="mt-6 text-center text-xs text-gray-400">
          Need help? Email talent@remotiv.work
        </p>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl"
        >
          {toast}
        </div>
      )}
    </main>
  );
}
