import "server-only";

import { AI_MATCHING_MODEL, getAnthropic } from "@/lib/anthropic";

/**
 * CV → structured-profile extraction via Claude Haiku.
 *
 * Built to be wired into `moveApplicationToTalent` later — this file is
 * intentionally isolated and unwired. Call `extractTalentFieldsFromCv(cv_text)`
 * to get a typed, validated, capped profile object, or `null` on any failure
 * (missing key, network throw, malformed JSON, bad shape). Never throws.
 *
 * The output shape mirrors the 14 wizard columns on `job_applications`
 * exactly (see /api/apply Phase 2b parsing), so callers can write the result
 * straight into the row as a cache.
 */

// ── Module-level constants ──────────────────────────────────

const CV_EXTRACT_MAX_TOKENS = 1800;
// Cost guard — cap the CV text before sending. The DB column already caps at
// MAX_CV_TEXT_LENGTH (100_000) at /api/apply time; this further cap is just
// for Anthropic token budget. ~30 KB ≈ 8k input tokens, well below limits.
const CV_TEXT_INPUT_CAP = 30_000;

// Field caps — copied verbatim from /api/apply:31-42 (APPLY_FIELD_MAX) so the
// util's output is insert-safe for the 14 job_applications columns.
const CAP = {
  jobTitle: 200,
  roleCategory: 60,
  degree: 200,
  institution: 200,
  city: 100,
  country: 100,
  summary: 2000,
  skill: 50,
  expField: 200,
  experienceDescription: 1000,
};
const MAX_SKILLS = 30;
const MAX_EXPERIENCES = 30;

// Enum value sets — copied verbatim from /api/apply:51-58. Claude is
// instructed to pick from these, and any non-matching value is coerced to
// null in sanitiseOutput, so a garbage Claude response can't corrupt the row.
const VALID_AVAILABILITY = ["Available Now", "Not Available"] as const;
const VALID_WORK_TYPE = ["Full-time", "Part-time", "Contract", "Any"] as const;
const VALID_NOTICE_PERIOD = [
  "Immediate",
  "2 Weeks",
  "1 Month",
  "Negotiable",
] as const;
const VALID_WORK_LOCATION = ["Remote", "Hybrid", "Onsite"] as const;

// Role-category whitelist — values only, copied from the canonical list in
// src/app/admin/_components/move-to-talent-modal.tsx:15-26 so an admin
// reviewing an extracted profile sees the same options.
const ROLE_CATEGORIES = [
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

// ── Output type ─────────────────────────────────────────────

export type ExtractedTalentFields = {
  applicant_job_title: string | null;
  role_category: string | null;
  years_experience: number | null;
  degree: string | null;
  institution: string | null;
  city: string | null;
  country: string | null;
  summary: string | null;
  availability: "Available Now" | "Not Available" | null;
  work_type: "Full-time" | "Part-time" | "Contract" | "Any" | null;
  notice_period: "Immediate" | "2 Weeks" | "1 Month" | "Negotiable" | null;
  work_location: "Remote" | "Hybrid" | "Onsite" | null;
  skills: string[];
  employment_history: Array<{
    title: string;
    company: string;
    start: string;
    end: string;
    description: string;
    skills: string[];
  }>;
};

// ── Private helpers ─────────────────────────────────────────

// Mirrors ai-matching.ts:268-273. Strips a leading ```json fence and trailing
// ``` fence so Claude's occasional markdown wrapping doesn't trip JSON.parse.
function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function capStr(v: unknown, n: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, n);
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number.parseInt(v, 10)
        : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function coerceEnum<T extends string>(
  v: unknown,
  valid: ReadonlyArray<T>,
): T | null {
  if (typeof v !== "string") return null;
  return (valid as ReadonlyArray<string>).includes(v) ? (v as T) : null;
}

function stringArray(
  v: unknown,
  maxCount: number,
  maxLen: number,
): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxCount)
    .map((s) => s.slice(0, maxLen));
}

/**
 * Take a raw parsed JSON of unknown shape and produce a valid
 * ExtractedTalentFields. Every field is capped, every enum coerced, every
 * array bounded. Output is always insert-safe even when Claude returns
 * garbage or partial data.
 */
function sanitiseOutput(parsed: unknown): ExtractedTalentFields {
  const p = (parsed && typeof parsed === "object"
    ? parsed
    : {}) as Record<string, unknown>;

  return {
    applicant_job_title: capStr(p.applicant_job_title, CAP.jobTitle),
    role_category: coerceEnum(p.role_category, ROLE_CATEGORIES),
    years_experience: clampInt(p.years_experience, 0, 70),
    degree: capStr(p.degree, CAP.degree),
    institution: capStr(p.institution, CAP.institution),
    city: capStr(p.city, CAP.city),
    country: capStr(p.country, CAP.country),
    summary: capStr(p.summary, CAP.summary),
    availability: coerceEnum(p.availability, VALID_AVAILABILITY),
    work_type: coerceEnum(p.work_type, VALID_WORK_TYPE),
    notice_period: coerceEnum(p.notice_period, VALID_NOTICE_PERIOD),
    work_location: coerceEnum(p.work_location, VALID_WORK_LOCATION),
    skills: stringArray(p.skills, MAX_SKILLS, CAP.skill),
    employment_history: Array.isArray(p.employment_history)
      ? (p.employment_history as unknown[])
          .filter(
            (row): row is Record<string, unknown> =>
              !!row && typeof row === "object",
          )
          .map((row) => ({
            title: capStr(row.title, CAP.expField) ?? "",
            company: capStr(row.company, CAP.expField) ?? "",
            start: capStr(row.start, CAP.expField) ?? "",
            end: capStr(row.end, CAP.expField) ?? "",
            description:
              capStr(row.description, CAP.experienceDescription) ?? "",
            skills: stringArray(row.skills, MAX_SKILLS, CAP.skill),
          }))
          .filter((row) => row.title.length > 0 || row.company.length > 0)
          .slice(0, MAX_EXPERIENCES)
      : [],
  };
}

// ── System prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are a CV parser. Read the CV text and extract the candidate's profile.

Return ONLY valid JSON — no prose, no markdown, no code fences.

Schema:
{
  "applicant_job_title": string | null,
  "role_category": string | null,
  "years_experience": number | null,
  "degree": string | null,
  "institution": string | null,
  "city": string | null,
  "country": string | null,
  "summary": string | null,
  "availability": "Available Now" | "Not Available" | null,
  "work_type": "Full-time" | "Part-time" | "Contract" | "Any" | null,
  "notice_period": "Immediate" | "2 Weeks" | "1 Month" | "Negotiable" | null,
  "work_location": "Remote" | "Hybrid" | "Onsite" | null,
  "skills": string[],
  "employment_history": [
    {
      "title": string,
      "company": string,
      "start": string,
      "end": string,
      "description": string,
      "skills": string[]
    }
  ]
}

Allowed values for role_category: Engineer | SDR | CS | Design | Data | DevOps | QA | Marketing | Ops | Finance | Other

Rules:
- applicant_job_title is the candidate's current/most-recent title.
- role_category MUST be one of the listed values; if no clear match, return null.
- years_experience is an integer 0..70; null if unknown.
- summary is a 1-3 sentence professional bio drawn from the CV (do not invent).
- For every enum field (availability, work_type, notice_period, work_location), match
  one of the listed values exactly. If the CV does not reveal a clear value, return null
  rather than guessing.
- For employment_history, list roles most-recent first. "end" may be "Present" for
  the current role. Each row's "skills" is the skills used in THAT role; the top-level
  "skills" is the candidate's overall skill set.
- For any field the CV does not reveal, return null (or [] for arrays).
- Do not invent data. Do not include any text outside the JSON object.`;

// ── Main export ─────────────────────────────────────────────

/**
 * Extract structured profile fields from a CV's plain text using Claude Haiku.
 * Returns a fully sanitised, insert-safe object or `null` on ANY failure
 * (empty/missing input, missing API key, network throw, malformed JSON, bad
 * shape). Never throws.
 */
export async function extractTalentFieldsFromCv(
  cvText: string,
): Promise<ExtractedTalentFields | null> {
  if (typeof cvText !== "string" || cvText.trim().length === 0) {
    return null;
  }
  const input = cvText.slice(0, CV_TEXT_INPUT_CAP);

  try {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: AI_MATCHING_MODEL,
      max_tokens: CV_EXTRACT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `CV TEXT:\n${input}` }],
    });

    const block = response.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    if (!raw) {
      console.error("[cv-extract] empty response from Claude");
      return null;
    }

    const stripped = stripCodeFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      console.error(
        "[cv-extract] non-JSON response from Claude:",
        stripped.slice(0, 200),
      );
      return null;
    }
    return sanitiseOutput(parsed);
  } catch (err) {
    console.error(
      "[cv-extract] extraction failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ============================================================================
// Basic-fields extraction — focused 5-field variant for bulk CV upload
// ----------------------------------------------------------------------------
// Wired into /api/admin/extract-cv-basic. Returns ONLY the five contact-detail
// fields the bulk-upload review grid edits (first_name, last_name, email,
// phone, linkedin_url). Smaller prompt + smaller output budget than the rich
// extractor above — ~10× cheaper per call, which matters when a 50-CV batch
// fires the endpoint 50 times. The contract mirrors the rich function: never
// throws, returns null on any failure, output is always sanitised + capped.
//
// Validation deliberately stays minimal (trim + length cap only). The client
// loop will fall back to the existing regex parser per-field for any value
// this returns as null, and /api/apply re-validates email + LinkedIn at
// submit time. No email-regex or linkedin-pattern check here.
// ============================================================================

const BASIC_FIELDS_MAX_TOKENS = 300;

const BASIC_CAP = {
  name:     100,
  email:    200,
  phone:    50,
  linkedin: 300,
};

export type ExtractedBasicFields = {
  first_name:   string | null;
  last_name:    string | null;
  email:        string | null;
  phone:        string | null;
  linkedin_url: string | null;
};

function sanitiseBasic(parsed: unknown): ExtractedBasicFields {
  const p = (parsed && typeof parsed === "object"
    ? parsed
    : {}) as Record<string, unknown>;

  return {
    first_name:   capStr(p.first_name,   BASIC_CAP.name),
    last_name:    capStr(p.last_name,    BASIC_CAP.name),
    email:        capStr(p.email,        BASIC_CAP.email),
    phone:        capStr(p.phone,        BASIC_CAP.phone),
    linkedin_url: capStr(p.linkedin_url, BASIC_CAP.linkedin),
  };
}

const BASIC_SYSTEM_PROMPT = `You are a CV parser. Read the CV text and extract the candidate's basic contact details.

Return ONLY a valid JSON object — no prose, no markdown, no code fences.

Schema:
{
  "first_name": string | null,
  "last_name": string | null,
  "email": string | null,
  "phone": string | null,
  "linkedin_url": string | null
}

Rules:
- first_name is the candidate's given name. last_name is the family name (may be multiple words like "van der Berg" or "Smith Jones").
- email must be a real email address found in the CV, or null. Do not invent one.
- phone may be in any international format (e.g. "+44 7700 900000", "03xx-xxxxxxx", "+1 (415) 555-0100"); preserve the original formatting.
- linkedin_url should contain "linkedin.com" — prefer the full https URL if present, otherwise return the bare "linkedin.com/in/..." path. null if not present.
- For any field the CV does not reveal, return null. Do not invent data.
- Return ONLY the JSON object. No text outside it.`;

/**
 * Extract the 5 basic contact fields from CV plain text. Returns a fully
 * sanitised object or `null` on ANY failure (empty/missing input, missing
 * API key, network throw, malformed JSON, bad shape). Never throws.
 *
 * The shape mirrors what the bulk-upload review grid stores per row, so the
 * client can merge per-field with the existing regex parser's output:
 * `ai?.first_name ?? regex.firstName`, etc.
 */
export async function extractBasicFieldsFromCv(
  cvText: string,
): Promise<ExtractedBasicFields | null> {
  if (typeof cvText !== "string" || cvText.trim().length === 0) {
    return null;
  }
  const input = cvText.slice(0, CV_TEXT_INPUT_CAP);

  try {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: AI_MATCHING_MODEL,
      max_tokens: BASIC_FIELDS_MAX_TOKENS,
      system: BASIC_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `CV TEXT:\n${input}` }],
    });

    const block = response.content[0];
    const raw = block && block.type === "text" ? block.text : "";
    if (!raw) {
      console.error("[cv-extract:basic] empty response from Claude");
      return null;
    }

    const stripped = stripCodeFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      console.error(
        "[cv-extract:basic] non-JSON response from Claude:",
        stripped.slice(0, 200),
      );
      return null;
    }
    return sanitiseBasic(parsed);
  } catch (err) {
    console.error(
      "[cv-extract:basic] extraction failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
