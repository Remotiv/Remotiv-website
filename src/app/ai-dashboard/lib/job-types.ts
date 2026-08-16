import type { ScreeningQuestion } from "@/lib/jobs";
import type { InterviewQuestionInput } from "@/lib/interviews/types";

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
 * Ceiling for the two interviewer display names.
 *
 * Like JOB_TEXT_MAX this is a product guard, not a DB one — both columns are
 * unbounded `text`. These are person-sized labels a candidate reads at the top
 * of an interview ("Aisha, Talent Partner"), so 60 leaves room for a name plus
 * a short role while keeping the string from wrapping the interview header.
 * Over-length input is TRUNCATED rather than rejected: it's a display label,
 * not content, so silently capping loses nothing worth failing a publish over.
 */
export const JOB_INTERVIEWER_NAME_MAX = 60;

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
  /**
   * ISO timestamp, or null when the job is live in the workspace.
   *
   * Archived is orthogonal to status, not a fourth value of it: a job keeps
   * whatever status it had, and archiving only decides whether it appears in
   * the list and on the public site. That is why it is a separate column and a
   * separate tab rather than JOB_STATUSES gaining a member.
   */
  archived_at: string | null;
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

  /*
   * "More options" — per-job interview and scoring behaviour. Defaults here
   * mirror the `jobs` column defaults exactly, so a job created before these
   * columns existed and a job created by a client that omits them both land on
   * the same behaviour.
   *
   * Only ai_cv_scoring_enabled is read by shipped code today (the /api/apply →
   * ai_cv_score path). The other four are stored now and consumed when video
   * interviews ship; the wizard labels them as such rather than pretending.
   */
  allow_rerecord: boolean;
  ai_cv_scoring_enabled: boolean;
  measure_relevancy: boolean;
  avatar_interview_enabled: boolean;
  /** Meaningful only while avatar_interview_enabled — stored null otherwise. */
  avatar_interviewer_name: string;
  async_interview_enabled: boolean;
  /** Meaningful only while async_interview_enabled — stored null otherwise. */
  async_interview_name: string;
  /**
   * Send an automated rejection email for this job, two days after a candidate
   * is moved to Rejected.
   *
   * Per-JOB, seeded from the company default at creation and independent
   * afterwards — changing the company setting must never retroactively switch
   * automated rejections on for jobs that were posted without them.
   */
  send_rejection_email: boolean;

  /**
   * Per-dimension CV weighting — wizard step 8.
   *
   * NULL MEANS EQUAL WEIGHTING, which is defined as *today's behaviour*: the
   * model's own holistic overall_score is kept untouched. That is deliberately
   * NOT the same as "compute a flat mean of the four dimensions" — the prompt
   * tells the model its overall is a holistic judgement anchored to bands and
   * explicitly not an average, so a flat mean would come out different and every
   * existing job's next score would shift. Equal weighting therefore means
   * "don't intervene", which is what makes a backfill unnecessary.
   *
   * A weight is only applied when at least one of the four is set.
   */
  cv_weight_requirements: number | null;
  cv_weight_experience: number | null;
  cv_weight_domain: number | null;
  cv_weight_responsibilities: number | null;

  /**
   * Auto-shortlist — wizard step 9.
   *
   * `null` source means the feature is off for this job, which is the default
   * and what every existing job has.
   */
  autoshortlist_source: AutoshortlistSource | null;
  autoshortlist_cv_threshold: number | null;
  autoshortlist_interview_threshold: number | null;

  /**
   * Interview questions for the video round.
   *
   * NOT a jobs column — these live in their own `interview_questions` table,
   * one row per question. They ride along on the form model because the wizard
   * edits them on the same screen as the job, and the actions sync the table
   * after the job row lands. buildPatch never sees them: it allow-lists the
   * columns it writes, so a form field that is not a column cannot leak in.
   */
  interview_questions: InterviewQuestionInput[];
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
  allow_rerecord: true,
  ai_cv_scoring_enabled: true,
  measure_relevancy: false,
  avatar_interview_enabled: false,
  avatar_interviewer_name: "",
  async_interview_enabled: false,
  async_interview_name: "",
  // Off by default. An automated rejection carrying a company's name is
  // switched on deliberately, never inherited by accident.
  send_rejection_email: false,
  // Null across the board: equal weighting, i.e. the model's overall stands.
  cv_weight_requirements: null,
  cv_weight_experience: null,
  cv_weight_domain: null,
  cv_weight_responsibilities: null,
  // Off. Auto-shortlist flags candidates for a human to look at, and that is
  // switched on deliberately rather than inherited.
  autoshortlist_source: null,
  autoshortlist_cv_threshold: null,
  autoshortlist_interview_threshold: null,
  interview_questions: [],
};

/**
 * Which score can flag a candidate for shortlisting.
 *
 * `both` means EITHER clearing its own threshold flags — not both together. A
 * strong CV should surface before an interview exists, and requiring both would
 * make the CV threshold unreachable for every candidate who has not recorded
 * one yet.
 */
export const AUTOSHORTLIST_SOURCES = ["cv", "interview", "both"] as const;
export type AutoshortlistSource = (typeof AUTOSHORTLIST_SOURCES)[number];

export const AUTOSHORTLIST_SOURCE_LABELS: Record<AutoshortlistSource, string> = {
  cv: "CV score only",
  interview: "Interview score only",
  both: "Either score",
};

/** Sensible starting point when a recruiter switches auto-shortlist on. */
export const AUTOSHORTLIST_DEFAULT_THRESHOLD = 80;

/**
 * The four CV dimensions a company can weight, and the label each one carries
 * in the wizard.
 *
 * `key` is the `jobs` column; `dimension` is the name the scorer uses in
 * dimension_scores. The two differ (cv_weight_experience ↔ experience_depth)
 * and pairing them here is what stops the weighting from silently matching
 * nothing — see applyCvWeights, which looks dimensions up through this table.
 */
export const CV_WEIGHT_DIMENSIONS = [
  {
    key: "cv_weight_requirements",
    dimension: "requirements_match",
    label: "Requirements match",
    hint: "Against the job's stated requirements.",
  },
  {
    key: "cv_weight_experience",
    dimension: "experience_depth",
    label: "Experience depth",
    hint: "Seniority and depth against the level sought.",
  },
  {
    key: "cv_weight_domain",
    dimension: "domain_relevance",
    label: "Domain relevance",
    hint: "Same industry or technical area as this role.",
  },
  {
    key: "cv_weight_responsibilities",
    dimension: "responsibilities_fit",
    label: "Responsibilities fit",
    hint: "Have they demonstrably done these things?",
  },
] as const;

export type CvWeightKey = (typeof CV_WEIGHT_DIMENSIONS)[number]["key"];

/**
 * Weight range offered in the wizard.
 *
 * 1–5 rather than a percentage: percentages have to sum to 100, so every edit
 * forces the recruiter to rebalance the other three, and a UI that silently
 * rebalances them is worse. Relative weights normalise themselves — see
 * applyCvWeights, which divides by the total.
 */
export const CV_WEIGHT_MIN = 1;
export const CV_WEIGHT_MAX = 5;
export const CV_WEIGHT_DEFAULT = 3;

export const CV_WEIGHT_LABELS: Record<number, string> = {
  1: "Minor",
  2: "Light",
  3: "Normal",
  4: "High",
  5: "Critical",
};
