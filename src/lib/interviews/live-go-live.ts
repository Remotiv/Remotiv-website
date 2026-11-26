import type { createServiceClient } from "@/lib/supabase/server";
import { MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "./question-mix";

/**
 * The one go-live gate (#59): a job with AI Video Interview on can be live
 * (status 'open') only with 4 to 8 live questions (interview_kind 'live',
 * migration 082), the range the live invite accepts. AI Video Interview off:
 * any number, none included. Async questions never count.
 *
 * Every path that makes a job live asks this: the wizard's Publish and Save
 * changes (jobs/actions.ts, on the lists they send), the jobs list's status
 * menu, restore and unarchive (which bring a failing job back On hold
 * instead), and the admin's status, edit and restore (admin/jobs/actions.ts).
 */

type Service = ReturnType<typeof createServiceClient>;

/** The rule itself: may a job with this switch and this many live questions be live? */
export function liveQuestionCountOk(avatarOn: boolean, liveCount: number): boolean {
  return !avatarOn || (liveCount >= MIN_JOB_QUESTIONS && liveCount <= MAX_JOB_QUESTIONS);
}

/**
 * How many live questions a job stores, read by the job's OWN company. Null
 * when the read failed: callers treat that as failing the gate, never as 0
 * questions that happen to pass.
 */
export async function storedLiveQuestionCount(
  service: Service,
  jobId: string,
  companyId: string,
): Promise<number | null> {
  const { data, error } = await service
    .from("interview_questions")
    .select("id")
    .eq("job_id", jobId)
    .eq("company_id", companyId)
    .eq("interview_kind", "live")
    .limit(50);
  if (error) return null;
  return (data ?? []).length;
}

export type GoLiveCheck =
  /** The job as stored may be live, or does not exist (the caller's own checks say so). */
  | { ok: true; status: string | null }
  /** AI Video Interview on and not 4 to 8 live questions, or a read failed (`unreadable`). */
  | { ok: false; status: string | null; unreadable: boolean };

/**
 * The job AS STORED: its status, and whether it may be live. `companyId` scopes
 * the read for a company's own action; the admin passes null and the job's
 * own company_id is used for its questions. A job with AI Video Interview on
 * and no company (never the case on Remotiv's own board) has no questions and
 * fails.
 */
export async function goLiveCheck(
  service: Service,
  jobId: string,
  companyId: string | null,
): Promise<GoLiveCheck> {
  let query = service
    .from("jobs")
    .select("status, company_id, avatar_interview_enabled")
    .eq("id", jobId);
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query.maybeSingle();
  if (error) return { ok: false, status: null, unreadable: true };
  const job = data as {
    status: string | null;
    company_id: string | null;
    avatar_interview_enabled: boolean | null;
  } | null;
  if (!job) return { ok: true, status: null };
  if (job.avatar_interview_enabled !== true) return { ok: true, status: job.status };
  if (!job.company_id) return { ok: false, status: job.status, unreadable: false };
  const count = await storedLiveQuestionCount(service, jobId, job.company_id);
  if (count === null) return { ok: false, status: job.status, unreadable: true };
  return liveQuestionCountOk(true, count)
    ? { ok: true, status: job.status }
    : { ok: false, status: job.status, unreadable: false };
}

/* ── What each path says (approved #59) ───────────────────────── */

/** The jobs list's status menu, setting a job to Published. */
export const GO_LIVE_REFUSED =
  "This job can't be published yet: AI Video Interview needs 4 to 8 questions. Add them on the AI Video Interview step (step 6), or turn AI Video Interview off.";

/** Any path, when the job or its questions could not be read: the gate fails closed. */
export const GO_LIVE_UNREADABLE =
  "Couldn't check this job's AI Video Interview questions - please try again.";

/** Restore of a deleted job that was Published and fails the gate: it comes back On hold. */
export const RESTORED_ON_HOLD =
  "Restored as On hold: AI Video Interview needs 4 to 8 questions before this job can be published. Add them on the AI Video Interview step (step 6), or turn AI Video Interview off.";

/** Unarchive of a Published job that fails the gate: it comes back On hold. */
export const UNARCHIVED_ON_HOLD =
  "Unarchived as On hold: AI Video Interview needs 4 to 8 questions before this job can be published. Add them on the AI Video Interview step (step 6), or turn AI Video Interview off.";

/** The admin's status control or edit form, setting a job to Published. */
export const ADMIN_GO_LIVE_REFUSED =
  "This job can't be published: its AI Video Interview needs 4 to 8 questions. The company can add them on the job's AI Video Interview step, or turn AI Video Interview off.";

/** The admin's restore of a Published job that fails the gate. */
export const ADMIN_RESTORED_ON_HOLD =
  "Restored as On hold: this job's AI Video Interview needs 4 to 8 questions before it can be published.";
