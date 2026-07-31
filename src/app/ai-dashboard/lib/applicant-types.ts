import type { ScreeningAnswerSnapshot } from "@/lib/jobs";

/**
 * Company-facing applicant types.
 *
 * A separate file from job-types.ts on purpose: jobs and applicants are
 * different domains with different lifecycles, and job-types.ts is already
 * imported by the wizard, the jobs list and the jobs actions. Keeping the
 * applicant surface apart stops the jobs bundle growing every time the
 * pipeline model does.
 */

/**
 * Company hiring pipeline. DEFINED NOW, NOT YET USED — `pipeline_stage` lands
 * in Step 2d along with application_stage_history. Nothing in this step reads
 * or writes it.
 *
 * Deliberately distinct from `job_applications.status`, which is Remotiv
 * admin's own triage vocabulary ("new" | "shortlisted" | "not_a_fit" | "maybe")
 * and stays under admin control. Two columns, two owners, no coupling.
 */
export const PIPELINE_STAGES = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
  "rejected",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  applied: "Applied",
  screening: "Screening",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

/** One row of the company Applicants table. */
export type CompanyApplicantRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  /** Null once the job has been deleted — `job_title` still resolves. */
  job_id: string | null;
  /** Live jobs.title, falling back to the frozen job_title_snapshot. */
  job_title: string;
  screening_answers: ScreeningAnswerSnapshot[];
  city: string | null;
  country: string | null;
  years_experience: number | null;
  notice_period: string | null;
  availability: string | null;
  created_at: string;
  /**
   * Whether a CV exists — NEVER the storage path. The path is a capability:
   * handing it to the browser would let anyone with it mint their own signed
   * URL, bypassing the ownership gate and the signed_url_logs audit. Clients
   * open CVs through /api/cv/company-application/[id] instead.
   */
  has_cv: boolean;
};

/** Filters accepted by fetchCompanyApplicants. */
export type CompanyApplicantQuery = {
  /** Restrict to one job. Must belong to the caller's company. */
  jobId?: string;
  /** Case-insensitive match across name and email. */
  search?: string;
};
