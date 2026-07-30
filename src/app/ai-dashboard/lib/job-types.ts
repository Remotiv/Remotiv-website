import type { ScreeningQuestion } from "@/lib/jobs";

/**
 * Company-facing job types.
 *
 * Enum option lists mirror src/app/admin/jobs/actions.ts EXACTLY — the same
 * `jobs` table backs both surfaces and the public /jobs page, so a value that
 * only exists here would render as an unknown tag publicly.
 */

/**
 * Company-facing job categories. Wider than the admin form's six, because
 * companies post outside Remotiv's engineering-led curation.
 *
 * `jobs.category` is free text — /api/apply already inserts "Other" for
 * manual-title applications, a value absent from the admin union, and that
 * path has been live without failing. So new values need no migration.
 *
 * "Other" is always LAST; everything before it is ordered by how often we
 * expect it to be picked.
 */
export const JOB_CATEGORIES = [
  "Engineering",
  "Design",
  "Product",
  "Data",
  "Sales",
  "Marketing",
  "Customer Support",
  "Operations",
  "Finance & Accounting",
  "HR & Recruiting",
  "Content & Writing",
  "Other",
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

export const JOB_EXPERIENCE_LEVELS = ["Entry", "Intermediate", "Expert"] as const;
export type JobExperienceLevel = (typeof JOB_EXPERIENCE_LEVELS)[number];

export const JOB_CONTRACT_TYPES = ["Full time", "Part time", "Contract"] as const;
export type JobContractType = (typeof JOB_CONTRACT_TYPES)[number];

export const JOB_WORK_TYPES = ["Remote", "On-site", "Hybrid"] as const;
export type JobWorkType = (typeof JOB_WORK_TYPES)[number];

export const JOB_CURRENCIES = ["USD", "PKR"] as const;
export type JobCurrency = (typeof JOB_CURRENCIES)[number];

/**
 * Free-text ceiling for description / responsibilities / requirements.
 *
 * NOT a DB requirement — all three columns are unbounded `text`. It's a
 * product guard: without it a paste can push megabytes through the job row and
 * onto the public /jobs detail page. Enforced in BOTH places, because
 * `maxLength` on a textarea is trivially bypassed by a direct action call.
 */
export const JOB_TEXT_MAX = 10_000;

/** Show the live counter only once the user is close to the ceiling. */
export const JOB_TEXT_COUNTER_FROM = 9_000;

/**
 * DB status enum. The design speaks Published/Draft/Closed; the column only has
 * these three values, so the UI maps onto them (see JOB_STATUS_LABELS).
 * Critically, ONLY 'open' is public — getInitialJobs filters status='open' —
 * so both 'on_hold' and 'closed' are invisible on remotiv.work/jobs.
 */
export const JOB_STATUSES = ["open", "on_hold", "closed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** UI vocabulary → DB status. 'on_hold' is our Draft: never public, editable. */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  open: "Published",
  on_hold: "Draft",
  closed: "Closed",
};

/** One row of the company Jobs table. */
export type CompanyJobRow = {
  id: string;
  title: string;
  location: string;
  category: string;
  experience_level: string;
  contract_type: string;
  work_type: string;
  status: JobStatus;
  slug: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  positions: number;
  created_at: string;
  /** Count of job_applications pointing at this job. */
  applicant_count: number;
};

/** The wizard's single form model. Strings mirror the admin form's contract:
 *  everything arrives as text and is coerced/validated server-side. */
export type CompanyJobInput = {
  title: string;
  location: string;
  category: string;
  experience_level: string;
  contract_type: string;
  work_type: string;
  positions: string;
  description: string;
  responsibilities: string;
  requirements: string;
  salary_currency: string;
  salary_min: string;
  salary_max: string;
  /** false → salary columns are written as null (hidden on the public post). */
  show_salary: boolean;
  screening_questions: ScreeningQuestion[];
  status: JobStatus;
};

export const EMPTY_JOB_INPUT: CompanyJobInput = {
  title: "",
  location: "",
  category: "Engineering",
  experience_level: "Expert",
  contract_type: "Full time",
  work_type: "Remote",
  positions: "1",
  description: "",
  responsibilities: "",
  requirements: "",
  salary_currency: "PKR",
  salary_min: "",
  salary_max: "",
  show_salary: true,
  screening_questions: [],
  status: "open",
};
