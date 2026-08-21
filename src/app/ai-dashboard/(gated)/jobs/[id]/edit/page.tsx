import { redirect } from "next/navigation";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canCreateJobs } from "@/app/ai-dashboard/lib/company-roles";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import {
  type AutoshortlistSource,
  type CompanyJobInput,
  EMPTY_JOB_INPUT,
  type JobBookingHours,
  type JobStatus,
} from "@/app/ai-dashboard/lib/job-types";
import { parseRules } from "@/lib/calendar/availability";
import type { ScreeningQuestion } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchInterviewQuestions } from "../../actions";
import { WizardClient } from "../../new/_wizard-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit job — Remotiv AI Interviews" };

type JobRow = {
  id: string;
  company_id: string | null;
  title: string | null;
  location: string | null;
  category: string | null;
  experience_level: string | null;
  contract_type: string | null;
  work_type: string | null;
  positions: number | null;
  description: string | null;
  responsibilities: string | null;
  requirements: string | null;
  salary_currency: string | null;
  salary_min: number | null;
  salary_max: number | null;
  screening_questions: unknown;
  status: string | null;
  allow_rerecord: boolean | null;
  ai_cv_scoring_enabled: boolean | null;
  measure_relevancy: boolean | null;
  avatar_interview_enabled: boolean | null;
  avatar_interviewer_name: string | null;
  async_interview_enabled: boolean | null;
  async_interview_name: string | null;
  send_rejection_email: boolean | null;
  /** Step 8. Null is meaningful — equal weighting, not a missing value. */
  cv_weight_requirements: number | null;
  cv_weight_experience: number | null;
  cv_weight_domain: number | null;
  cv_weight_responsibilities: number | null;
  /** Step 9. Null source means auto-shortlist is off for this job. */
  autoshortlist_source: AutoshortlistSource | null;
  autoshortlist_cv_threshold: number | null;
  autoshortlist_interview_threshold: number | null;
  /** Step 7. jsonb array of named must-haves; [] when none. */
  scoring_must_haves: unknown;
  /** Step 7. jsonb array of behavioural traits; [] when none. */
  interview_criteria: unknown;
  /** Step 5. 30 or 60; null when never chosen for this job. */
  interview_duration_minutes: number | null;
  /** Step 5. jsonb array of weekday windows; null when using Settings hours. */
  booking_hours_override: unknown;
};

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCompanyContext();

  // Hiring managers can view jobs but never edit them. updateCompanyJob
  // enforces this too; this avoids rendering a form that can't be saved.
  if (!canCreateJobs(ctx.role)) {
    redirect("/ai-dashboard/jobs");
  }

  const service = createServiceClient();
  const { data } = await service
    .from("jobs")
    .select(
      "id, company_id, title, location, category, experience_level, contract_type, work_type, positions, description, responsibilities, requirements, salary_currency, salary_min, salary_max, screening_questions, status, allow_rerecord, ai_cv_scoring_enabled, measure_relevancy, avatar_interview_enabled, avatar_interviewer_name, async_interview_enabled, async_interview_name, send_rejection_email, cv_weight_requirements, cv_weight_experience, cv_weight_domain, cv_weight_responsibilities, autoshortlist_source, autoshortlist_cv_threshold, autoshortlist_interview_threshold, scoring_must_haves, interview_criteria, interview_duration_minutes, booking_hours_override",
    )
    .eq("id", id)
    .maybeSingle();

  const job = data as JobRow | null;

  // Missing and not-yours are deliberately indistinguishable — both bounce to
  // the list rather than confirming that some other company's job id exists.
  if (!job || job.company_id !== ctx.companyId) {
    redirect("/ai-dashboard/jobs");
  }

  // A recruiter may only open a job they're on the hiring team for. Same
  // redirect as not-found, so the URL confirms nothing either way.
  if (!(await canAccessJob(ctx, job.id))) {
    redirect("/ai-dashboard/jobs");
  }

  const questions = Array.isArray(job.screening_questions)
    ? (job.screening_questions as ScreeningQuestion[])
    : [];

  /**
   * How many people have already answered each screening question.
   *
   * Drives the wizard's warning when an answer type is changed on a question
   * that already has answers — those answers become incomparable with anything
   * collected afterwards (a live job had four "6 years" replies and one "Yes"
   * sitting under the same question after a numeric → yes/no switch).
   *
   * Counted per QUESTION, not per job: a question added last week has fewer
   * answers than the job has applications, and the warning claims a number.
   * Scoped by company_id_snapshot as well as job_id — the same tenant rule
   * every other applicant query follows, never the id lookup alone. Failure is
   * non-fatal: an empty map just means no warnings, never a blocked edit.
   */
  const { data: answerRows } = await service
    .from("job_applications")
    .select("screening_answers")
    .eq("job_id", job.id)
    .eq("company_id_snapshot", ctx.companyId)
    .limit(1000);

  const answeredCounts: Record<string, number> = {};
  for (const row of (answerRows ?? []) as { screening_answers: unknown }[]) {
    if (!Array.isArray(row.screening_answers)) continue;
    for (const a of row.screening_answers as { question_id?: unknown }[]) {
      const qid = typeof a?.question_id === "string" ? a.question_id : null;
      if (qid) answeredCounts[qid] = (answeredCounts[qid] ?? 0) + 1;
    }
  }

  const interviewQuestions = await fetchInterviewQuestions(job.id);

  const initialState: CompanyJobInput = {
    title: job.title ?? "",
    location: job.location ?? "",
    category: job.category ?? EMPTY_JOB_INPUT.category,
    experience_level: job.experience_level ?? EMPTY_JOB_INPUT.experience_level,
    contract_type: job.contract_type ?? EMPTY_JOB_INPUT.contract_type,
    work_type: job.work_type ?? EMPTY_JOB_INPUT.work_type,
    positions: String(job.positions ?? 1),
    description: job.description ?? "",
    responsibilities: job.responsibilities ?? "",
    requirements: job.requirements ?? "",
    salary_currency: job.salary_currency ?? EMPTY_JOB_INPUT.salary_currency,
    salary_min: job.salary_min === null ? "" : String(job.salary_min),
    salary_max: job.salary_max === null ? "" : String(job.salary_max),
    // Both columns null is how "hidden" was persisted, so it round-trips.
    show_salary: job.salary_min !== null || job.salary_max !== null,
    screening_questions: questions,
    status: (job.status as JobStatus) ?? "open",
    // `?? default` rather than `=== true`: these columns are NOT NULL with
    // defaults, so null only appears on a row written before they existed —
    // and that row behaved as the default, so the form must open on it.
    allow_rerecord: job.allow_rerecord ?? EMPTY_JOB_INPUT.allow_rerecord,
    ai_cv_scoring_enabled: job.ai_cv_scoring_enabled ?? EMPTY_JOB_INPUT.ai_cv_scoring_enabled,
    measure_relevancy: job.measure_relevancy ?? EMPTY_JOB_INPUT.measure_relevancy,
    avatar_interview_enabled:
      job.avatar_interview_enabled ?? EMPTY_JOB_INPUT.avatar_interview_enabled,
    avatar_interviewer_name: job.avatar_interviewer_name ?? "",
    async_interview_enabled: job.async_interview_enabled ?? EMPTY_JOB_INPUT.async_interview_enabled,
    async_interview_name: job.async_interview_name ?? "",
    send_rejection_email: job.send_rejection_email ?? false,
    /*
     * Nullable by design, so `??` would be WRONG here — null is a meaningful
     * value (equal weighting / feature off), not a missing one to be defaulted.
     * These pass through exactly as stored.
     */
    cv_weight_requirements: job.cv_weight_requirements,
    cv_weight_experience: job.cv_weight_experience,
    cv_weight_domain: job.cv_weight_domain,
    cv_weight_responsibilities: job.cv_weight_responsibilities,
    autoshortlist_source: job.autoshortlist_source,
    autoshortlist_cv_threshold: job.autoshortlist_cv_threshold,
    autoshortlist_interview_threshold: job.autoshortlist_interview_threshold,
    // jsonb column, NOT NULL default '[]' — but a row written before the column
    // existed still reads null, so the guard is a shape check, not a null check.
    scoring_must_haves: Array.isArray(job.scoring_must_haves)
      ? (job.scoring_must_haves as string[])
      : [],
    interview_criteria: Array.isArray(job.interview_criteria)
      ? (job.interview_criteria as string[])
      : [],
    /*
     * Nullable by design, so `??` would be WRONG — null means "not decided",
     * which is a real value the form must open on, not a gap to be defaulted.
     * The duration is narrowed rather than cast: a legacy row holding anything
     * other than 30 or 60 opens as "not decided" instead of putting a value in
     * the form that the CHECK constraint would reject on save.
     */
    interview_duration_minutes:
      job.interview_duration_minutes === 30 || job.interview_duration_minutes === 60
        ? job.interview_duration_minutes
        : null,
    // Validated through the same parser availability reads with, so what the
    // form shows and what slot generation uses can never disagree.
    booking_hours_override: Array.isArray(job.booking_hours_override)
      ? (parseRules(job.booking_hours_override) as JobBookingHours[])
      : null,
    interview_questions: interviewQuestions,
  };

  return (
    <WizardClient
      companyName={ctx.company.name}
      mode="edit"
      jobId={job.id}
      initialState={initialState}
      answeredCounts={answeredCounts}
    />
  );
}
