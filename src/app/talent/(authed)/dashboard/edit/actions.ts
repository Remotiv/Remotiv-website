"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/normalize";
import { requireProfileOwner } from "@/app/talent/lib/profile-owner";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

type UpdateBasicInfoInput = {
  profileId: string;
  sourceTable: SourceTable;
  firstName: string;
  lastName: string;
  phone: string | null;
  linkedinUrl: string | null;
};

type BasicInfoData = {
  firstName: string;
  lastName: string;
  phone: string | null;
  linkedinUrl: string | null;
};

type MutationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const NAME_MAX = 80;
const URL_MAX = 300;
const PHONE_MAX = 40;
const CITY_MAX = 120;
const JOB_TITLE_MAX = 120;
const SUMMARY_MAX = 5000;
const YEARS_MAX = 70;
const SALARY_MAX = 100_000_000;
const SKILLS_MAX = 30;
const SKILL_CHAR_MAX = 50;
const EXPERIENCE_MAX = 30;
const EXPERIENCE_FIELD_MAX = 200;
const EXPERIENCE_SKILLS_MAX = 30;
const REMOTE_URL_MAX = 500;
const JOB_TITLES_MAX = 200;
const BIO_MIN = 50;
const BIO_MAX = 2000;
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

const CV_BUCKET = "cvs";
// Pakistan intake uses 5 MB client cap (10 MB server). Mirror the client
// cap to keep edit-page uploads acceptable to intake as well.
const PAKISTAN_CV_MAX_BYTES = 5 * 1024 * 1024;
const PAKISTAN_CV_STORAGE_PREFIX = "talent/cvs/";
const REMOTE_CV_MAX_BYTES = 5 * 1024 * 1024;
const REMOTE_CV_STORAGE_PREFIX = "hire-remote/cvs/";
const REMOTE_CV_ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
const CV_SIGNED_URL_TTL_SECONDS = 60 * 60;

// Verbatim from intake: src/app/remote-ready/page.tsx:112 LANGUAGE_LEVELS.
const REMOTE_LANGUAGE_LEVELS = [
  "Native",
  "Fluent",
  "Professional",
  "Basic",
] as const;

// Verbatim from intake: src/app/remote-ready/page.tsx:299 portfolio URL test
// `/^https?:\/\//i` — must start with http:// or https://.
const PORTFOLIO_URL_REGEX = /^https?:\/\//i;

// Verbatim regex from src/app/remote-ready/page.tsx:274 — intake form
// requires a `linkedin.com/in/...` profile URL. Server and intake must
// match exactly so users can't bypass intake validation via the edit page.
const REMOTE_LINKEDIN_REGEX =
  /^https?:\/\/(www\.)?linkedin\.com\/in\//i;

// Verbatim from intake form src/app/remote-ready/page.tsx:118-135.
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

// Verbatim from intake AVAIL_LABEL (src/app/remote-ready/page.tsx:131-135).
// "now" → "Available Now" (capital N), "twoWeeks" → "Available within 2 weeks".
const REMOTE_AVAIL_LABELS: Record<"now" | "twoWeeks", string> = {
  now: "Available Now",
  twoWeeks: "Available within 2 weeks",
};

const COUNTRY_OPTIONS = [
  "Pakistan",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Other",
] as const;

const ROLE_CATEGORY_OPTIONS = [
  "Engineer",
  "SDR",
  "CS",
  "Design",
  "Data",
  "DevOps",
  "QA",
  "Marketing",
  "Ops",
  "Finance",
  "Other",
] as const;

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

function normaliseLinkedinUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.toLowerCase().includes("linkedin.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function updateTalentBasicInfo(
  input: UpdateBasicInfoInput,
): Promise<MutationResult<BasicInfoData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) {
    return { success: false, error: "First name is required." };
  }
  if (firstName.length > NAME_MAX) {
    return { success: false, error: `First name must be ${NAME_MAX} characters or fewer.` };
  }
  if (!lastName) {
    return { success: false, error: "Last name is required." };
  }
  if (lastName.length > NAME_MAX) {
    return { success: false, error: `Last name must be ${NAME_MAX} characters or fewer.` };
  }

  let normalisedPhone: string | null = null;
  if (input.phone) {
    const phoneRaw = input.phone.trim();
    if (phoneRaw.length > PHONE_MAX) {
      return { success: false, error: "Phone number is too long." };
    }
    if (phoneRaw.length > 0) {
      const digits = normalizePhone(phoneRaw);
      if (digits.length < 7) {
        return { success: false, error: "Phone number must have at least 7 digits." };
      }
      normalisedPhone = digits;
    }
  }

  let normalisedLinkedin: string | null = null;
  if (input.linkedinUrl) {
    const raw = input.linkedinUrl.trim();
    if (raw.length > URL_MAX) {
      return { success: false, error: "LinkedIn URL is too long." };
    }
    if (raw.length > 0) {
      normalisedLinkedin = normaliseLinkedinUrl(raw);
      if (!normalisedLinkedin) {
        return {
          success: false,
          error: "Enter a valid LinkedIn URL (e.g. linkedin.com/in/yourname).",
        };
      }
    }
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const patch = {
    first_name: firstName,
    last_name: lastName,
    phone: normalisedPhone,
    linkedin_url: normalisedLinkedin,
  };
  const { error } = await service
    .from(sourceTable)
    .update(patch)
    .eq("id", profileId);

  if (error) {
    console.error("[updateTalentBasicInfo] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      firstName,
      lastName,
      phone: normalisedPhone,
      linkedinUrl: normalisedLinkedin,
    },
  };
}

type UpdateLocationInput = {
  profileId: string;
  sourceTable: SourceTable;
  city: string | null;
  country: string | null;
};

type LocationData = { city: string | null; country: string | null };

export async function updateTalentLocation(
  input: UpdateLocationInput,
): Promise<MutationResult<LocationData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  let city: string | null = null;
  if (input.city) {
    const trimmed = input.city.trim();
    if (trimmed.length > CITY_MAX) {
      return { success: false, error: `City must be ${CITY_MAX} characters or fewer.` };
    }
    city = trimmed.length === 0 ? null : trimmed;
  }

  let country: string | null = null;
  if (input.country) {
    const trimmed = input.country.trim();
    if (trimmed.length === 0) {
      country = null;
    } else if (!(COUNTRY_OPTIONS as readonly string[]).includes(trimmed)) {
      return { success: false, error: "Please pick a country from the list." };
    } else {
      country = trimmed;
    }
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from(sourceTable)
    .update({ city, country })
    .eq("id", profileId);
  if (error) {
    console.error("[updateTalentLocation] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { city, country } };
}

type UpdateProfessionalInput = {
  profileId: string;
  sourceTable: SourceTable;
  jobTitle: string | null;
  roleCategory: string | null;
  yearsExperience: number | null;
  industry: string | null;
  summary: string | null;
};

type ProfessionalData = {
  jobTitle: string | null;
  roleCategory: string | null;
  yearsExperience: number | null;
  industry: string | null;
  summary: string | null;
};

export async function updateTalentProfessional(
  input: UpdateProfessionalInput,
): Promise<MutationResult<ProfessionalData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  let jobTitle: string | null = null;
  if (input.jobTitle) {
    const trimmed = input.jobTitle.trim();
    if (trimmed.length > JOB_TITLE_MAX) {
      return {
        success: false,
        error: `Job title must be ${JOB_TITLE_MAX} characters or fewer.`,
      };
    }
    jobTitle = trimmed.length === 0 ? null : trimmed;
  }

  let roleCategory: string | null = null;
  if (input.roleCategory) {
    const trimmed = input.roleCategory.trim();
    if (trimmed.length === 0) {
      roleCategory = null;
    } else if (!(ROLE_CATEGORY_OPTIONS as readonly string[]).includes(trimmed)) {
      return {
        success: false,
        error: "Please pick a role category from the list.",
      };
    } else {
      roleCategory = trimmed;
    }
  }

  let yearsExperience: number | null = null;
  if (input.yearsExperience !== null && input.yearsExperience !== undefined) {
    if (!Number.isFinite(input.yearsExperience)) {
      return { success: false, error: "Years of experience must be a number." };
    }
    if (!Number.isInteger(input.yearsExperience)) {
      return { success: false, error: "Years of experience must be a whole number." };
    }
    if (input.yearsExperience < 0 || input.yearsExperience > YEARS_MAX) {
      return {
        success: false,
        error: `Years of experience must be between 0 and ${YEARS_MAX}.`,
      };
    }
    yearsExperience = input.yearsExperience;
  }

  let industry: string | null = null;
  if (input.industry) {
    const trimmed = input.industry.trim();
    if (trimmed.length === 0) {
      industry = null;
    } else if (!(INDUSTRY_OPTIONS as readonly string[]).includes(trimmed)) {
      return { success: false, error: "Please pick an industry from the list." };
    } else {
      industry = trimmed;
    }
  }

  let summary: string | null = null;
  if (input.summary) {
    const trimmed = input.summary.trim();
    if (trimmed.length > SUMMARY_MAX) {
      return {
        success: false,
        error: `Summary must be ${SUMMARY_MAX} characters or fewer.`,
      };
    }
    summary = trimmed.length === 0 ? null : trimmed;
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from(sourceTable)
    .update({
      job_title: jobTitle,
      role_category: roleCategory,
      years_experience: yearsExperience,
      industry,
      summary,
    })
    .eq("id", profileId);
  if (error) {
    console.error("[updateTalentProfessional] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: { jobTitle, roleCategory, yearsExperience, industry, summary },
  };
}

type UpdateAvailabilitySalaryInput = {
  profileId: string;
  sourceTable: SourceTable;
  availability: string | null;
  workType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
};

type AvailabilitySalaryData = {
  availability: string | null;
  workType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
};

export async function updateTalentAvailabilitySalary(
  input: UpdateAvailabilitySalaryInput,
): Promise<MutationResult<AvailabilitySalaryData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  let availability: string | null = null;
  if (input.availability) {
    const trimmed = input.availability.trim();
    if (trimmed.length === 0) {
      availability = null;
    } else if (!(AVAILABILITY_OPTIONS as readonly string[]).includes(trimmed)) {
      return { success: false, error: "Pick an availability option from the list." };
    } else {
      availability = trimmed;
    }
  }

  let workType: string | null = null;
  if (input.workType) {
    const trimmed = input.workType.trim();
    if (trimmed.length === 0) {
      workType = null;
    } else if (!(WORK_TYPE_OPTIONS as readonly string[]).includes(trimmed)) {
      return { success: false, error: "Pick a work type from the list." };
    } else {
      workType = trimmed;
    }
  }

  function validateSalary(
    value: number | null,
    label: string,
  ): { ok: true; value: number | null } | { ok: false; error: string } {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (!Number.isFinite(value)) {
      return { ok: false, error: `${label} must be a number.` };
    }
    if (!Number.isInteger(value)) {
      return { ok: false, error: `${label} must be a whole number.` };
    }
    if (value < 0 || value > SALARY_MAX) {
      return {
        ok: false,
        error: `${label} must be between 0 and ${SALARY_MAX.toLocaleString()}.`,
      };
    }
    return { ok: true, value };
  }

  const minCheck = validateSalary(input.salaryMin, "Minimum salary");
  if (!minCheck.ok) return { success: false, error: minCheck.error };
  const maxCheck = validateSalary(input.salaryMax, "Maximum salary");
  if (!maxCheck.ok) return { success: false, error: maxCheck.error };
  const salaryMin = minCheck.value;
  const salaryMax = maxCheck.value;

  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
    return {
      success: false,
      error: "Minimum salary must be less than or equal to maximum.",
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from(sourceTable)
    .update({
      availability,
      work_type: workType,
      salary_min: salaryMin,
      salary_max: salaryMax,
    })
    .eq("id", profileId);
  if (error) {
    console.error("[updateTalentAvailabilitySalary] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: { availability, workType, salaryMin, salaryMax },
  };
}

type ExperienceEntryInput = {
  title: string;
  company: string;
  start: string;
  end: string;
  currentlyWorking: boolean;
  skills: string[];
};

type ExperienceEntryStored = {
  title: string;
  company: string;
  start: string;
  end: string;
  dates: string;
  skills: string[];
};

type UpdateSkillsExperienceInput = {
  profileId: string;
  sourceTable: SourceTable;
  skills: string[];
  experience: ExperienceEntryInput[];
};

type SkillsExperienceData = {
  skills: string[];
  experience: ExperienceEntryStored[];
};

function normaliseSkillsArray(input: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const capped = trimmed.slice(0, SKILL_CHAR_MAX);
    const lower = capped.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(capped);
  }
  return out;
}

function buildDatesString(
  start: string,
  end: string,
  currentlyWorking: boolean,
): string {
  const s = start.trim();
  const e = currentlyWorking ? "Present" : end.trim();
  if (!s && !e) return "";
  if (!s) return e;
  if (!e) return s;
  return `${s} – ${e}`;
}

export async function updateTalentSkillsExperience(
  input: UpdateSkillsExperienceInput,
): Promise<MutationResult<SkillsExperienceData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  if (!Array.isArray(input.skills)) {
    return { success: false, error: "Skills must be a list." };
  }
  if (!Array.isArray(input.experience)) {
    return { success: false, error: "Experience must be a list." };
  }

  for (const raw of input.skills) {
    if (typeof raw === "string" && raw.trim().length > SKILL_CHAR_MAX) {
      return {
        success: false,
        error: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
      };
    }
  }
  const skills = normaliseSkillsArray(input.skills);
  if (skills.length > SKILLS_MAX) {
    return { success: false, error: `You can list up to ${SKILLS_MAX} skills.` };
  }

  const storedExperience: ExperienceEntryStored[] = [];
  for (const entry of input.experience) {
    if (!entry || typeof entry !== "object") continue;
    const title = (entry.title ?? "").trim();
    const company = (entry.company ?? "").trim();
    const start = (entry.start ?? "").trim();
    const endRaw = (entry.end ?? "").trim();
    const currentlyWorking = Boolean(entry.currentlyWorking);
    if (!title && !company) continue;
    if (title.length > EXPERIENCE_FIELD_MAX) {
      return {
        success: false,
        error: `Job title must be ${EXPERIENCE_FIELD_MAX} characters or fewer.`,
      };
    }
    if (company.length > EXPERIENCE_FIELD_MAX) {
      return {
        success: false,
        error: `Company must be ${EXPERIENCE_FIELD_MAX} characters or fewer.`,
      };
    }
    if (start.length > EXPERIENCE_FIELD_MAX) {
      return {
        success: false,
        error: `Start must be ${EXPERIENCE_FIELD_MAX} characters or fewer.`,
      };
    }
    if (!currentlyWorking && endRaw.length > EXPERIENCE_FIELD_MAX) {
      return {
        success: false,
        error: `End must be ${EXPERIENCE_FIELD_MAX} characters or fewer.`,
      };
    }
    const rawSkills = Array.isArray(entry.skills) ? entry.skills : [];
    for (const s of rawSkills) {
      if (typeof s === "string" && s.trim().length > SKILL_CHAR_MAX) {
        return {
          success: false,
          error: `Each per-role skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
        };
      }
    }
    const rowSkills = normaliseSkillsArray(rawSkills);
    if (rowSkills.length > EXPERIENCE_SKILLS_MAX) {
      return {
        success: false,
        error: `Each role can list up to ${EXPERIENCE_SKILLS_MAX} skills.`,
      };
    }
    const end = currentlyWorking ? "Present" : endRaw;
    storedExperience.push({
      title,
      company,
      start,
      end,
      dates: buildDatesString(start, endRaw, currentlyWorking),
      skills: rowSkills,
    });
  }
  if (storedExperience.length > EXPERIENCE_MAX) {
    return {
      success: false,
      error: `You can list up to ${EXPERIENCE_MAX} experiences.`,
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from(sourceTable)
    .update({ skills, experience: storedExperience })
    .eq("id", profileId);
  if (error) {
    console.error("[updateTalentSkillsExperience] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { skills, experience: storedExperience } };
}

type UpdateRemoteBasicInput = {
  profileId: string;
  sourceTable: SourceTable;
  firstName: string;
  lastName: string;
  phone: string;
  linkedinUrl: string;
};

type RemoteBasicData = {
  firstName: string;
  lastName: string;
  phone: string;
  linkedinUrl: string;
};

const REMOTE_NAME_MAX = 120;

export async function updateRemoteBasicInfo(
  input: UpdateRemoteBasicInput,
): Promise<MutationResult<RemoteBasicData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) {
    return { success: false, error: "First name is required." };
  }
  if (firstName.length > REMOTE_NAME_MAX) {
    return {
      success: false,
      error: `First name must be ${REMOTE_NAME_MAX} characters or fewer.`,
    };
  }
  if (!lastName) {
    return { success: false, error: "Last name is required." };
  }
  if (lastName.length > REMOTE_NAME_MAX) {
    return {
      success: false,
      error: `Last name must be ${REMOTE_NAME_MAX} characters or fewer.`,
    };
  }

  const phoneRaw = input.phone.trim();
  if (!phoneRaw) {
    return { success: false, error: "Phone number is required." };
  }
  if (phoneRaw.length > PHONE_MAX) {
    return { success: false, error: "Phone number is too long." };
  }
  const phoneDigits = normalizePhone(phoneRaw);
  if (phoneDigits.length < 7) {
    return {
      success: false,
      error: "Phone number must have at least 7 digits.",
    };
  }

  const linkedinTrimmed = input.linkedinUrl.trim();
  if (!linkedinTrimmed) {
    return {
      success: false,
      error: "Please enter a valid LinkedIn profile URL (https://linkedin.com/in/your-name).",
    };
  }
  if (linkedinTrimmed.length > REMOTE_URL_MAX) {
    return { success: false, error: "LinkedIn URL is too long." };
  }
  if (!REMOTE_LINKEDIN_REGEX.test(linkedinTrimmed)) {
    return {
      success: false,
      error: "Please enter a valid LinkedIn profile URL (https://linkedin.com/in/your-name).",
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({
      first_name: firstName,
      last_name: lastName,
      phone: phoneDigits,
      linkedin_url: linkedinTrimmed,
    })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteBasicInfo] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      firstName,
      lastName,
      phone: phoneDigits,
      linkedinUrl: linkedinTrimmed,
    },
  };
}

type UpdateRemoteLocationInput = {
  profileId: string;
  sourceTable: SourceTable;
  city: string;
  country: string;
  timeZone: string;
};

type RemoteLocationData = {
  city: string;
  country: string;
  timeZone: string;
};

function isKnownTimeZoneServer(tz: string): boolean {
  try {
    const list =
      typeof Intl !== "undefined" &&
      typeof (
        Intl as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf === "function"
        ? (Intl as { supportedValuesOf: (k: string) => string[] })
            .supportedValuesOf("timeZone")
        : [];
    return list.includes(tz);
  } catch {
    return false;
  }
}

export async function updateRemoteLocation(
  input: UpdateRemoteLocationInput,
): Promise<MutationResult<RemoteLocationData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }

  const cityTrimmed = input.city.trim();
  if (cityTrimmed.length > CITY_MAX) {
    return {
      success: false,
      error: `City must be ${CITY_MAX} characters or fewer.`,
    };
  }
  const city = cityTrimmed.length === 0 ? null : cityTrimmed;

  const countryTrimmed = input.country.trim();
  let country: string | null = null;
  if (countryTrimmed.length > 0) {
    if (!(COUNTRY_OPTIONS as readonly string[]).includes(countryTrimmed)) {
      return { success: false, error: "Please pick a country from the list." };
    }
    country = countryTrimmed;
  }

  const tzTrimmed = input.timeZone.trim();
  let timeZone: string | null = null;
  if (tzTrimmed.length > 0) {
    if (!isKnownTimeZoneServer(tzTrimmed)) {
      return { success: false, error: "Invalid time zone." };
    }
    timeZone = tzTrimmed;
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({ city, country, time_zone: timeZone })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteLocation] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      city: city ?? "",
      country: country ?? "",
      timeZone: timeZone ?? "",
    },
  };
}

type UpdateRemoteProfessionalInput = {
  profileId: string;
  sourceTable: SourceTable;
  jobTitles: string;
  bio: string;
  hourlyRate: string;
  hoursPerWeek: string;
};

type RemoteProfessionalData = {
  jobTitles: string;
  bio: string;
  hourlyRate: number | null;
  hoursPerWeek: string;
};

export async function updateRemoteProfessional(
  input: UpdateRemoteProfessionalInput,
): Promise<MutationResult<RemoteProfessionalData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }

  const jobTitlesTrimmed = input.jobTitles.trim();
  if (jobTitlesTrimmed.length > JOB_TITLES_MAX) {
    return {
      success: false,
      error: `Job titles must be ${JOB_TITLES_MAX} characters or fewer.`,
    };
  }
  const jobTitles = jobTitlesTrimmed.length === 0 ? null : jobTitlesTrimmed;

  const bioTrimmed = input.bio.trim();
  let bio: string | null = null;
  if (bioTrimmed.length > 0) {
    if (bioTrimmed.length < BIO_MIN) {
      return {
        success: false,
        error: `Bio must be at least ${BIO_MIN} characters.`,
      };
    }
    if (bioTrimmed.length > BIO_MAX) {
      return {
        success: false,
        error: `Bio must be ${BIO_MAX} characters or fewer.`,
      };
    }
    bio = bioTrimmed;
  }

  // Match intake parseFloat (src/app/remote-ready/page.tsx:591). Allows
  // decimals; we still clamp to integer range 10..999 client-side via
  // step=1 but server-side accept any numeric in range.
  const rateRaw = input.hourlyRate.trim();
  let hourlyRate: number | null = null;
  if (rateRaw.length > 0) {
    const parsed = Number.parseFloat(rateRaw);
    if (!Number.isFinite(parsed)) {
      return {
        success: false,
        error: `Hourly rate must be between $${HOURLY_RATE_MIN} and $${HOURLY_RATE_MAX}.`,
      };
    }
    if (parsed < HOURLY_RATE_MIN || parsed > HOURLY_RATE_MAX) {
      return {
        success: false,
        error: `Hourly rate must be between $${HOURLY_RATE_MIN} and $${HOURLY_RATE_MAX}.`,
      };
    }
    hourlyRate = parsed;
  }

  const hoursTrimmed = input.hoursPerWeek.trim();
  let hoursPerWeek: string | null = null;
  if (hoursTrimmed.length > 0) {
    if (
      !(REMOTE_HOURS_PER_WEEK_OPTIONS as readonly string[]).includes(
        hoursTrimmed,
      )
    ) {
      return {
        success: false,
        error: "Pick an hours-per-week option from the list.",
      };
    }
    hoursPerWeek = hoursTrimmed;
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({
      job_titles: jobTitles,
      bio,
      hourly_rate: hourlyRate,
      hours_per_week: hoursPerWeek,
    })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteProfessional] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      jobTitles: jobTitles ?? "",
      bio: bio ?? "",
      hourlyRate,
      hoursPerWeek: hoursPerWeek ?? "",
    },
  };
}

type RemoteAvailChoice = "" | "now" | "twoWeeks" | "future";

type UpdateRemoteAvailWorkInput = {
  profileId: string;
  sourceTable: SourceTable;
  availChoice: RemoteAvailChoice;
  availableFromDate: string;
  workType: string;
};

type RemoteAvailWorkData = {
  availability: string;
  availableFromDate: string;
  workType: string;
};

export async function updateRemoteAvailabilityWorkType(
  input: UpdateRemoteAvailWorkInput,
): Promise<MutationResult<RemoteAvailWorkData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }

  const choice = input.availChoice;
  if (
    choice !== "" &&
    choice !== "now" &&
    choice !== "twoWeeks" &&
    choice !== "future"
  ) {
    return { success: false, error: "Invalid availability choice." };
  }

  let availability: string | null = null;
  let availableFromDate: string | null = null;

  if (choice === "now") {
    availability = REMOTE_AVAIL_LABELS.now;
  } else if (choice === "twoWeeks") {
    availability = REMOTE_AVAIL_LABELS.twoWeeks;
  } else if (choice === "future") {
    const dateRaw = input.availableFromDate.trim();
    if (!dateRaw) {
      return { success: false, error: "Pick a date." };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      return { success: false, error: "Pick a valid date." };
    }
    const chosen = new Date(dateRaw);
    if (Number.isNaN(chosen.getTime())) {
      return { success: false, error: "Pick a valid date." };
    }
    // Match intake (route.ts:225): strictly future, not today.
    if (chosen <= new Date()) {
      return {
        success: false,
        error: "Pick a future date (tomorrow or later).",
      };
    }
    availability = `Available from ${dateRaw}`;
    availableFromDate = dateRaw;
  }

  const wtTrimmed = input.workType.trim();
  let workType: string | null = null;
  if (wtTrimmed.length > 0) {
    if (
      !(REMOTE_WORK_TYPE_OPTIONS as readonly string[]).includes(wtTrimmed)
    ) {
      return {
        success: false,
        error: "Pick a work-type option from the list.",
      };
    }
    workType = wtTrimmed;
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({
      availability,
      available_from_date: availableFromDate,
      work_type: workType,
    })
    .eq("id", profileId);
  if (error) {
    console.error(
      "[updateRemoteAvailabilityWorkType] update failed:",
      error,
    );
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      availability: availability ?? "",
      availableFromDate: availableFromDate ?? "",
      workType: workType ?? "",
    },
  };
}

type UpdateRemoteSkillsInput = {
  profileId: string;
  sourceTable: SourceTable;
  skills: string[];
};

type RemoteSkillsData = { skills: string[] };

export async function updateRemoteSkills(
  input: UpdateRemoteSkillsInput,
): Promise<MutationResult<RemoteSkillsData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }
  if (!Array.isArray(input.skills)) {
    return { success: false, error: "Skills must be a list." };
  }
  for (const raw of input.skills) {
    if (typeof raw === "string" && raw.trim().length > SKILL_CHAR_MAX) {
      return {
        success: false,
        error: `Each skill must be ${SKILL_CHAR_MAX} characters or fewer.`,
      };
    }
  }
  const skills = normaliseSkillsArray(input.skills);
  if (skills.length > SKILLS_MAX) {
    return { success: false, error: `You can list up to ${SKILLS_MAX} skills.` };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({ skills })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteSkills] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { skills } };
}

type UpdateRemoteEducationInput = {
  profileId: string;
  sourceTable: SourceTable;
  institution: string;
  degree: string;
  start: string;
  end: string;
};

type RemoteEducationData = {
  institution: string;
  degree: string;
  start: string;
  end: string;
  dates: string;
};

export async function updateRemoteEducation(
  input: UpdateRemoteEducationInput,
): Promise<MutationResult<RemoteEducationData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }

  const institution = input.institution.trim();
  const degree = input.degree.trim();
  const start = input.start.trim();
  const end = input.end.trim();

  for (const [name, value] of [
    ["Institution", institution],
    ["Degree", degree],
    ["Start", start],
    ["End", end],
  ] as const) {
    if (value.length > EDU_FIELD_MAX) {
      return {
        success: false,
        error: `${name} must be ${EDU_FIELD_MAX} characters or fewer.`,
      };
    }
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const allEmpty =
    !institution && !degree && !start && !end;

  let updatePayload: { education: null } | {
    education: {
      institution: string;
      degree: string;
      start: string;
      end: string;
      dates: string;
    };
  };
  let datesOut = "";
  if (allEmpty) {
    updatePayload = { education: null };
  } else {
    // Verbatim intake join: src/app/remote-ready/page.tsx:556
    // dates: [eduStart.trim(), eduEnd.trim()].filter(Boolean).join("–")
    // — en-dash U+2013, NO surrounding spaces.
    datesOut = [start, end].filter(Boolean).join("–");
    updatePayload = {
      education: { institution, degree, start, end, dates: datesOut },
    };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update(updatePayload)
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteEducation] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: { institution, degree, start, end, dates: datesOut },
  };
}

type EmploymentRowInput = {
  title: string;
  company: string;
  start: string;
  end: string;
  description: string;
};

type EmploymentRowStored = {
  title: string;
  company: string;
  start: string;
  end: string;
  description: string;
  dates: string;
};

type UpdateRemoteEmploymentInput = {
  profileId: string;
  sourceTable: SourceTable;
  employment: EmploymentRowInput[];
};

type RemoteEmploymentData = { employment: EmploymentRowStored[] };

export async function updateRemoteEmployment(
  input: UpdateRemoteEmploymentInput,
): Promise<MutationResult<RemoteEmploymentData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }
  if (!Array.isArray(input.employment)) {
    return { success: false, error: "Employment must be a list." };
  }

  const stored: EmploymentRowStored[] = [];
  for (const entry of input.employment) {
    if (!entry || typeof entry !== "object") continue;
    const title = (entry.title ?? "").trim();
    const company = (entry.company ?? "").trim();
    const start = (entry.start ?? "").trim();
    const end = (entry.end ?? "").trim();
    const description = (entry.description ?? "").trim();
    if (!title && !company) continue;
    if (title.length > EMPLOYMENT_FIELD_MAX) {
      return {
        success: false,
        error: `Job title must be ${EMPLOYMENT_FIELD_MAX} characters or fewer.`,
      };
    }
    if (company.length > EMPLOYMENT_FIELD_MAX) {
      return {
        success: false,
        error: `Company must be ${EMPLOYMENT_FIELD_MAX} characters or fewer.`,
      };
    }
    if (start.length > EMPLOYMENT_FIELD_MAX) {
      return {
        success: false,
        error: `Start must be ${EMPLOYMENT_FIELD_MAX} characters or fewer.`,
      };
    }
    if (end.length > EMPLOYMENT_FIELD_MAX) {
      return {
        success: false,
        error: `End must be ${EMPLOYMENT_FIELD_MAX} characters or fewer.`,
      };
    }
    if (description.length > EMPLOYMENT_DESCRIPTION_MAX) {
      return {
        success: false,
        error: `Description must be ${EMPLOYMENT_DESCRIPTION_MAX} characters or fewer.`,
      };
    }
    // Verbatim intake separator: src/app/remote-ready/page.tsx:549
    // [e.start, e.end].filter(Boolean).join(" — ")  ← em-dash U+2014 with spaces.
    const dates = [start, end].filter(Boolean).join(" — ");
    stored.push({ title, company, start, end, description, dates });
  }
  if (stored.length > EMPLOYMENT_MAX) {
    return {
      success: false,
      error: `You can list up to ${EMPLOYMENT_MAX} employment entries.`,
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({ employment_history: stored.length === 0 ? null : stored })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteEmployment] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { employment: stored } };
}

type LanguageRowInput = { name: string; level: string };
type UpdateRemoteLanguagesInput = {
  profileId: string;
  sourceTable: SourceTable;
  languages: LanguageRowInput[];
};
type RemoteLanguagesData = { languages: LanguageRowInput[] };

export async function updateRemoteLanguages(
  input: UpdateRemoteLanguagesInput,
): Promise<MutationResult<RemoteLanguagesData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }
  if (!Array.isArray(input.languages)) {
    return { success: false, error: "Languages must be a list." };
  }

  const stored: LanguageRowInput[] = [];
  const seen = new Set<string>();
  for (const entry of input.languages) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry.name ?? "").trim();
    const level = (entry.level ?? "").trim();
    if (!name) continue;
    if (name.length > LANGUAGE_NAME_MAX) {
      return {
        success: false,
        error: `Language name must be ${LANGUAGE_NAME_MAX} characters or fewer.`,
      };
    }
    if (
      !level ||
      !(REMOTE_LANGUAGE_LEVELS as readonly string[]).includes(level)
    ) {
      return {
        success: false,
        error: "Pick a language level from the list.",
      };
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    stored.push({ name, level });
  }
  if (stored.length > LANGUAGES_MAX) {
    return {
      success: false,
      error: `You can list up to ${LANGUAGES_MAX} languages.`,
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({ languages: stored.length === 0 ? null : stored })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemoteLanguages] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { languages: stored } };
}

type PortfolioRowInput = {
  projectTitle: string;
  role: string;
  url: string;
  description: string;
};

type PortfolioRowStored = {
  title: string;
  role: string;
  url: string;
  description: string;
};

type UpdateRemotePortfolioInput = {
  profileId: string;
  sourceTable: SourceTable;
  portfolio: PortfolioRowInput[];
};

type RemotePortfolioData = { portfolio: PortfolioRowStored[] };

export async function updateRemotePortfolio(
  input: UpdateRemotePortfolioInput,
): Promise<MutationResult<RemotePortfolioData>> {
  const { profileId, sourceTable } = input;
  if (sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid profile." };
  }
  if (!Array.isArray(input.portfolio)) {
    return { success: false, error: "Portfolio must be a list." };
  }

  const stored: PortfolioRowStored[] = [];
  for (const entry of input.portfolio) {
    if (!entry || typeof entry !== "object") continue;
    const projectTitle = (entry.projectTitle ?? "").trim();
    const role = (entry.role ?? "").trim();
    const url = (entry.url ?? "").trim();
    const description = (entry.description ?? "").trim();
    // Match intake server: keep if title || role || url
    // (src/app/api/hire-remote-profiles/route.ts:144).
    if (!projectTitle && !role && !url) continue;
    if (projectTitle.length > PORTFOLIO_FIELD_MAX) {
      return {
        success: false,
        error: `Project title must be ${PORTFOLIO_FIELD_MAX} characters or fewer.`,
      };
    }
    if (role.length > PORTFOLIO_FIELD_MAX) {
      return {
        success: false,
        error: `Role must be ${PORTFOLIO_FIELD_MAX} characters or fewer.`,
      };
    }
    if (url.length > PORTFOLIO_URL_MAX) {
      return { success: false, error: "Project URL is too long." };
    }
    if (url && !PORTFOLIO_URL_REGEX.test(url)) {
      return {
        success: false,
        error: "Project URL must start with https://",
      };
    }
    if (description.length > PORTFOLIO_DESCRIPTION_MAX) {
      return {
        success: false,
        error: `Description must be ${PORTFOLIO_DESCRIPTION_MAX} characters or fewer.`,
      };
    }
    stored.push({
      title: projectTitle,
      role,
      url,
      description,
    });
  }
  if (stored.length > PORTFOLIO_MAX) {
    return {
      success: false,
      error: `You can list up to ${PORTFOLIO_MAX} portfolio entries.`,
    };
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("hire_remote_profiles")
    .update({ portfolio: stored.length === 0 ? null : stored })
    .eq("id", profileId);
  if (error) {
    console.error("[updateRemotePortfolio] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { portfolio: stored } };
}

function deriveExistingCvPath(
  cvPath: string | null,
  cvUrl: string | null,
): string | null {
  if (cvPath && cvPath.trim()) return cvPath.trim();
  if (!cvUrl) return null;
  // Verbatim regex from src/app/browse-talent/actions.ts deriveCvPathFromUrl.
  const m = String(cvUrl).match(
    /^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/,
  );
  return m ? m[1] : null;
}

function isPdfMagicBytes(bytes: Uint8Array): boolean {
  // "%PDF" — same check used in intake routes.
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

async function signOwnCvUrl(params: {
  userId: string;
  profileId: string;
  sourceTable: SourceTable;
  cvPath: string;
}): Promise<string | null> {
  const service = createServiceClient();
  const { data: signed, error } = await service.storage
    .from(CV_BUCKET)
    .createSignedUrl(params.cvPath, CV_SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    console.error("[signOwnCvUrl] sign failed:", error);
    return null;
  }
  // Mirror browse-talent/actions.ts: fire-and-forget audit log.
  service
    .from("signed_url_logs")
    .insert({
      user_id: params.userId,
      candidate_id: params.profileId,
      source_table: params.sourceTable,
      was_admin: false,
    })
    .then(({ error: e }) => {
      if (e) console.error("[signed_url_logs insert]", e);
    });
  return signed.signedUrl;
}

type GetOwnCvUrlInput = {
  profileId: string;
  sourceTable: SourceTable;
};
type GetOwnCvUrlResult =
  | { success: true; data: { url: string } }
  | { success: false; error: string };

export async function getOwnCvSignedUrl(
  input: GetOwnCvUrlInput,
): Promise<GetOwnCvUrlResult> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  let owner: { userId: string; email: string };
  try {
    owner = await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't read this CV." };
  }

  const service = createServiceClient();
  const { data: row, error } = await service
    .from(sourceTable)
    .select("cv_path, cv_url")
    .eq("id", profileId)
    .maybeSingle();
  if (error || !row) {
    return { success: false, error: "Profile not found." };
  }
  const path = deriveExistingCvPath(
    (row as { cv_path: string | null }).cv_path,
    (row as { cv_url: string | null }).cv_url,
  );
  if (!path) {
    return { success: false, error: "No CV on file." };
  }
  const signed = await signOwnCvUrl({
    userId: owner.userId,
    profileId,
    sourceTable,
    cvPath: path,
  });
  if (!signed) {
    return { success: false, error: "Could not sign CV URL." };
  }
  return { success: true, data: { url: signed } };
}

type UploadCvResult =
  | { success: true; data: { cvPath: string; cvUrl: string } }
  | { success: false; error: string };

export async function uploadCv(formData: FormData): Promise<UploadCvResult> {
  const profileId = String(formData.get("profileId") ?? "");
  const sourceTable = String(formData.get("sourceTable") ?? "") as SourceTable;
  const file = formData.get("cv");

  if (!profileId) {
    return { success: false, error: "Missing profile id." };
  }
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }
  if (!(file instanceof File)) {
    return { success: false, error: "Please select a file." };
  }

  const isPakistan = sourceTable === "talent_profiles";
  const maxBytes = isPakistan ? PAKISTAN_CV_MAX_BYTES : REMOTE_CV_MAX_BYTES;

  if (file.size === 0) {
    return { success: false, error: "Empty file." };
  }
  if (file.size > maxBytes) {
    const mb = Math.floor(maxBytes / (1024 * 1024));
    return { success: false, error: `CV must be ${mb} MB or smaller.` };
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  let contentType: string;
  let storagePath: string;

  if (isPakistan) {
    if (!isPdfMagicBytes(buffer)) {
      return { success: false, error: "CV must be a PDF file." };
    }
    contentType = "application/pdf";
    storagePath = `${PAKISTAN_CV_STORAGE_PREFIX}${crypto.randomUUID()}.pdf`;
  } else {
    const mime = file.type;
    if (!(REMOTE_CV_ALLOWED_TYPES as readonly string[]).includes(mime)) {
      return {
        success: false,
        error: "CV must be a PDF, DOC, or DOCX file.",
      };
    }
    if (mime === "application/pdf" && !isPdfMagicBytes(buffer)) {
      return { success: false, error: "CV must be a real PDF file." };
    }
    const lastDot = file.name.lastIndexOf(".");
    const rawExt =
      lastDot >= 0 ? file.name.slice(lastDot + 1).toLowerCase() : "";
    const safeExt =
      rawExt === "pdf" || rawExt === "doc" || rawExt === "docx"
        ? rawExt
        : mime === "application/pdf"
          ? "pdf"
          : mime === "application/msword"
            ? "doc"
            : "docx";
    contentType = mime;
    storagePath = `${REMOTE_CV_STORAGE_PREFIX}${crypto.randomUUID()}.${safeExt}`;
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();

  const { data: existing } = await service
    .from(sourceTable)
    .select("cv_path, cv_url")
    .eq("id", profileId)
    .maybeSingle();
  const oldPath = deriveExistingCvPath(
    (existing as { cv_path: string | null } | null)?.cv_path ?? null,
    (existing as { cv_url: string | null } | null)?.cv_url ?? null,
  );

  const { error: upErr } = await service.storage
    .from(CV_BUCKET)
    .upload(storagePath, buffer, {
      contentType,
      upsert: false,
    });
  if (upErr) {
    console.error("[uploadCv] storage upload failed:", upErr);
    return { success: false, error: "Could not upload CV." };
  }

  const { data: pub } = service.storage
    .from(CV_BUCKET)
    .getPublicUrl(storagePath);
  const cvUrl = pub?.publicUrl ?? "";

  const { error: dbErr } = await service
    .from(sourceTable)
    .update({ cv_path: storagePath, cv_url: cvUrl })
    .eq("id", profileId);
  if (dbErr) {
    console.error("[uploadCv] DB update failed:", dbErr);
    // Rollback orphaned upload.
    try {
      await service.storage.from(CV_BUCKET).remove([storagePath]);
    } catch (cleanupErr) {
      console.error(
        "[uploadCv] rollback delete failed (orphaned at",
        storagePath,
        "):",
        cleanupErr,
      );
    }
    return { success: false, error: "Could not save CV." };
  }

  if (oldPath && oldPath !== storagePath) {
    service.storage
      .from(CV_BUCKET)
      .remove([oldPath])
      .then(({ error: e }) => {
        if (e) {
          console.error(
            "[uploadCv] old CV delete failed (orphaned at",
            oldPath,
            "):",
            e,
          );
        }
      });
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return { success: true, data: { cvPath: storagePath, cvUrl } };
}

type RemoveCvResult =
  | { success: true; data: { cleared: true } }
  | { success: false; error: string };

export async function removeCv(input: {
  profileId: string;
  sourceTable: SourceTable;
}): Promise<RemoveCvResult> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }
  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const { data: existing } = await service
    .from(sourceTable)
    .select("cv_path, cv_url")
    .eq("id", profileId)
    .maybeSingle();
  const oldPath = deriveExistingCvPath(
    (existing as { cv_path: string | null } | null)?.cv_path ?? null,
    (existing as { cv_url: string | null } | null)?.cv_url ?? null,
  );

  const { error: dbErr } = await service
    .from(sourceTable)
    .update({ cv_path: null, cv_url: null })
    .eq("id", profileId);
  if (dbErr) {
    console.error("[removeCv] DB update failed:", dbErr);
    return { success: false, error: "Could not remove CV." };
  }

  if (oldPath) {
    service.storage
      .from(CV_BUCKET)
      .remove([oldPath])
      .then(({ error: e }) => {
        if (e) console.error("[removeCv] storage delete failed:", e);
      });
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");
  return { success: true, data: { cleared: true } };
}
