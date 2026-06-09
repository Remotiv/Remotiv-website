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
