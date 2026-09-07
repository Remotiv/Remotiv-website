export const TALENT_SCORABLE_FIELDS: readonly string[] = [
  "first_name",
  "last_name",
  "phone",
  "city",
  "country",
  "linkedin_url",
  "job_title",
  "role_category",
  "years_experience",
  "industry",
  "summary",
  "availability",
  "work_type",
  "salary_min",
  "salary_max",
  "avatar_url",
  "cv_path",
  "skills",
  "experience",
];

export const REMOTE_SCORABLE_FIELDS: readonly string[] = [
  "first_name",
  "last_name",
  "phone",
  "city",
  "country",
  "time_zone",
  "linkedin_url",
  "job_titles",
  "bio",
  "hourly_rate",
  "hours_per_week",
  "work_type",
  "availability",
  "photo_path",
  "cv_path",
  "skills",
  "employment_history",
  "education",
  "languages",
  "portfolio",
];

export type HighValueField = { key: string; label: string };

export const TALENT_HIGH_VALUE_FIELDS: readonly HighValueField[] = [
  { key: "summary", label: "a summary" },
  { key: "role_category", label: "your role category" },
  { key: "avatar_url", label: "a photo" },
  { key: "cv_path", label: "your CV" },
  { key: "salary_min", label: "salary expectations" },
  { key: "skills", label: "skills" },
  { key: "linkedin_url", label: "your LinkedIn" },
  { key: "experience", label: "work experience" },
];

export const REMOTE_HIGH_VALUE_FIELDS: readonly HighValueField[] = [
  { key: "bio", label: "your bio" },
  { key: "photo_path", label: "a photo" },
  { key: "cv_path", label: "your CV" },
  { key: "hourly_rate", label: "an hourly rate" },
  { key: "skills", label: "skills" },
  { key: "linkedin_url", label: "your LinkedIn" },
  { key: "employment_history", label: "work history" },
  { key: "portfolio", label: "portfolio links" },
];

export type SourceTable = "talent_profiles" | "hire_remote_profiles";

/**
 * Fields satisfied by ANY of several columns.
 *
 * A CV lives in `cv_path` on every row written since the `cvs` bucket was made
 * private, and in `cv_url` alone on rows written before it. Scoring only one of
 * them tells half the talent their profile is missing a CV they uploaded — the
 * new ones if we score cv_url, the legacy ones if we score cv_path. So the key
 * is cv_path and cv_url is accepted alongside it.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  cv_path: ["cv_path", "cv_url"],
};

/** Is the field behind `key` filled, counting any column that satisfies it? */
function isKeyFilled(row: Record<string, unknown>, key: string): boolean {
  const columns = FIELD_ALIASES[key] ?? [key];
  return columns.some((c) => isFieldFilled(row[c]));
}

export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return value > 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export function computeCompleteness(
  row: Record<string, unknown>,
  sourceTable: SourceTable,
): { filled: number; total: number; pct: number } {
  const fields =
    sourceTable === "talent_profiles"
      ? TALENT_SCORABLE_FIELDS
      : REMOTE_SCORABLE_FIELDS;
  let filled = 0;
  for (const key of fields) {
    if (isKeyFilled(row, key)) filled += 1;
  }
  const total = fields.length;
  const pct = total === 0 ? 0 : Math.round((filled / total) * 100);
  return { filled, total, pct };
}

export function getMissingHighValueFields(
  row: Record<string, unknown>,
  sourceTable: SourceTable,
  max = 3,
): string[] {
  const candidates =
    sourceTable === "talent_profiles"
      ? TALENT_HIGH_VALUE_FIELDS
      : REMOTE_HIGH_VALUE_FIELDS;
  const missing: string[] = [];
  for (const { key, label } of candidates) {
    if (!isKeyFilled(row, key)) {
      missing.push(label);
      if (missing.length >= max) break;
    }
  }
  return missing;
}
