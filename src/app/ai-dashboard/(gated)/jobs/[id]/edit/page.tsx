import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import type { ScreeningQuestion } from "@/lib/jobs";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canCreateJobs } from "@/app/ai-dashboard/lib/company-roles";
import {
  EMPTY_JOB_INPUT,
  type CompanyJobInput,
  type JobStatus,
} from "@/app/ai-dashboard/lib/job-types";
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
};

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
      "id, company_id, title, location, category, experience_level, contract_type, work_type, positions, description, responsibilities, requirements, salary_currency, salary_min, salary_max, screening_questions, status, allow_rerecord, ai_cv_scoring_enabled, measure_relevancy, avatar_interview_enabled, avatar_interviewer_name, async_interview_enabled, async_interview_name, send_rejection_email",
    )
    .eq("id", id)
    .maybeSingle();

  const job = data as JobRow | null;

  // Missing and not-yours are deliberately indistinguishable — both bounce to
  // the list rather than confirming that some other company's job id exists.
  if (!job || job.company_id !== ctx.companyId) {
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
    ai_cv_scoring_enabled:
      job.ai_cv_scoring_enabled ?? EMPTY_JOB_INPUT.ai_cv_scoring_enabled,
    measure_relevancy: job.measure_relevancy ?? EMPTY_JOB_INPUT.measure_relevancy,
    avatar_interview_enabled:
      job.avatar_interview_enabled ?? EMPTY_JOB_INPUT.avatar_interview_enabled,
    avatar_interviewer_name: job.avatar_interviewer_name ?? "",
    async_interview_enabled:
      job.async_interview_enabled ?? EMPTY_JOB_INPUT.async_interview_enabled,
    async_interview_name: job.async_interview_name ?? "",
    send_rejection_email: job.send_rejection_email ?? false,
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
