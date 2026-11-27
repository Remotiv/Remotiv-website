import type { createServiceClient } from "@/lib/supabase/server";
import { LIVE_QUESTION_COUNT_REFUSAL } from "./live-question-list";
import { MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "./question-mix";
import { type InterviewKind, MAX_QUESTIONS } from "./types";

/**
 * The one go-live gate. A job can be live (status 'open') only when:
 *   - AI Video Interview on: 4 to 8 live questions (interview_kind 'live',
 *     migration 082), the range the live invite accepts (#59);
 *   - Async Video Interview on: 3 to 8 async questions (#61, decided
 *     26 Nov; the 8 is the save's own limit, held here too for rows stored
 *     before it).
 * An interview that is off needs nothing. Each list counts only its own kind.
 *
 * Every path that makes a job live asks this: the wizard's Publish and Save
 * changes (jobs/actions.ts, on the lists they send, else what is stored), the
 * jobs list's status menu, restore and unarchive (which bring a failing job
 * back On hold instead), and the admin's status, edit and restore
 * (admin/jobs/actions.ts). Drafts (On hold, Closed) are never gated.
 */

type Service = ReturnType<typeof createServiceClient>;

/** The fewest async questions a Published job with Async Video Interview on may have (#61). */
export const MIN_ASYNC_QUESTIONS = 3;
/** The most: the save's own limit, also held at go-live for rows stored before it (#61). */
export const MAX_ASYNC_QUESTIONS = MAX_QUESTIONS;

/** The live rule: may a job with this switch and this many live questions be live? */
export function liveQuestionCountOk(avatarOn: boolean, liveCount: number): boolean {
  return !avatarOn || (liveCount >= MIN_JOB_QUESTIONS && liveCount <= MAX_JOB_QUESTIONS);
}

/** The async rule: may a job with this switch and this many async questions be live? */
export function asyncQuestionCountOk(asyncOn: boolean, asyncCount: number): boolean {
  return !asyncOn || (asyncCount >= MIN_ASYNC_QUESTIONS && asyncCount <= MAX_ASYNC_QUESTIONS);
}

/**
 * How many questions of one kind a job stores, read by the job's OWN company.
 * Null when the read failed: callers treat that as failing the gate, never as
 * a count that happens to pass.
 */
export async function storedQuestionCount(
  service: Service,
  jobId: string,
  companyId: string,
  kind: InterviewKind,
): Promise<number | null> {
  const { data, error } = await service
    .from("interview_questions")
    .select("id")
    .eq("job_id", jobId)
    .eq("company_id", companyId)
    .eq("interview_kind", kind)
    .limit(50);
  if (error) return null;
  return (data ?? []).length;
}

/** Which interviews keep a job from going live. */
export type GoLiveFailing = { live: boolean; async: boolean };

export type GoLiveCheck =
  /** The job as stored may be live, or does not exist (the caller's own checks say so). */
  | { ok: true; status: string | null }
  /** An interview's rule fails (`failing`), or a read failed (`unreadable`). */
  | { ok: false; status: string | null; unreadable: boolean; failing: GoLiveFailing };

/**
 * The job AS STORED: its status, and whether it may be live. `companyId` scopes
 * the read for a company's own action; the admin passes null and the job's
 * own company_id is used for its questions. A job with an interview on and no
 * company (never the case on Remotiv's own board) has no questions and fails.
 */
export async function goLiveCheck(
  service: Service,
  jobId: string,
  companyId: string | null,
): Promise<GoLiveCheck> {
  let query = service
    .from("jobs")
    .select("status, company_id, avatar_interview_enabled, async_interview_enabled")
    .eq("id", jobId);
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query.maybeSingle();
  const none: GoLiveFailing = { live: false, async: false };
  if (error) return { ok: false, status: null, unreadable: true, failing: none };
  const job = data as {
    status: string | null;
    company_id: string | null;
    avatar_interview_enabled: boolean | null;
    async_interview_enabled: boolean | null;
  } | null;
  if (!job) return { ok: true, status: null };
  const liveOn = job.avatar_interview_enabled === true;
  const asyncOn = job.async_interview_enabled === true;
  if (!liveOn && !asyncOn) return { ok: true, status: job.status };
  const count = async (on: boolean, kind: InterviewKind) =>
    !on ? 0 : job.company_id ? storedQuestionCount(service, jobId, job.company_id, kind) : 0;
  const [live, asyncCount] = await Promise.all([count(liveOn, "live"), count(asyncOn, "async")]);
  if (live === null || asyncCount === null) {
    return { ok: false, status: job.status, unreadable: true, failing: none };
  }
  const failing = {
    live: !liveQuestionCountOk(liveOn, live),
    async: !asyncQuestionCountOk(asyncOn, asyncCount),
  };
  return failing.live || failing.async
    ? { ok: false, status: job.status, unreadable: false, failing }
    : { ok: true, status: job.status };
}

/* ── What each path says ─────────────────────────────────────────
 * The AI Video Interview wording (#59) is unchanged; #61 adds the async
 * wording and one message for both. */

/** The jobs list's status menu, setting a job to Published. */
export const GO_LIVE_REFUSED =
  "This job can't be published yet: AI Video Interview needs 4 to 8 questions. Add them on the AI Video Interview step (step 6), or turn AI Video Interview off.";

/** Any path, when the job or its questions could not be read: the gate fails closed. */
export const GO_LIVE_UNREADABLE =
  "Couldn't check this job's interview questions - please try again.";

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

/** Where a go-live refusal or On hold note is shown. */
export type GoLivePath = "save" | "status" | "restore" | "unarchive" | "admin" | "adminRestore";

/** Each path's messages: AI Video Interview only, Async only, both, and a failed read. */
export const GO_LIVE_MESSAGES: Record<
  GoLivePath,
  { live: string; async: string; both: string; unreadable: string }
> = {
  save: {
    live: LIVE_QUESTION_COUNT_REFUSAL,
    async:
      "Async Video Interview needs 3 to 8 questions. Add them on the Async Video Interview step, or turn Async Video Interview off to publish without them.",
    both: "AI Video Interview needs 4 to 8 questions and Async Video Interview needs 3 to 8. Add them on their steps, or turn those interviews off to publish without them.",
    unreadable: GO_LIVE_UNREADABLE,
  },
  status: {
    live: GO_LIVE_REFUSED,
    async:
      "This job can't be published yet: Async Video Interview needs 3 to 8 questions. Add them on the Async Video Interview step (step 5), or turn Async Video Interview off.",
    both: "This job can't be published yet: AI Video Interview needs 4 to 8 questions and Async Video Interview needs 3 to 8. Add them on steps 6 and 5, or turn those interviews off.",
    unreadable: GO_LIVE_UNREADABLE,
  },
  restore: {
    live: RESTORED_ON_HOLD,
    async:
      "Restored as On hold: Async Video Interview needs 3 to 8 questions before this job can be published. Add them on the Async Video Interview step (step 5), or turn Async Video Interview off.",
    both: "Restored as On hold: AI Video Interview needs 4 to 8 questions and Async Video Interview needs 3 to 8 before this job can be published. Add them on steps 6 and 5, or turn those interviews off.",
    unreadable:
      "Restored as On hold: this job's interview questions couldn't be checked. Open the job to check them before publishing.",
  },
  unarchive: {
    live: UNARCHIVED_ON_HOLD,
    async:
      "Unarchived as On hold: Async Video Interview needs 3 to 8 questions before this job can be published. Add them on the Async Video Interview step (step 5), or turn Async Video Interview off.",
    both: "Unarchived as On hold: AI Video Interview needs 4 to 8 questions and Async Video Interview needs 3 to 8 before this job can be published. Add them on steps 6 and 5, or turn those interviews off.",
    unreadable:
      "Unarchived as On hold: this job's interview questions couldn't be checked. Open the job to check them before publishing.",
  },
  admin: {
    live: ADMIN_GO_LIVE_REFUSED,
    async:
      "This job can't be published: its Async Video Interview needs 3 to 8 questions. The company can add them on the job's Async Video Interview step, or turn Async Video Interview off.",
    both: "This job can't be published: its AI Video Interview needs 4 to 8 questions and its Async Video Interview needs 3 to 8. The company can add them on the job's interview steps, or turn those interviews off.",
    unreadable: GO_LIVE_UNREADABLE,
  },
  adminRestore: {
    live: ADMIN_RESTORED_ON_HOLD,
    async:
      "Restored as On hold: this job's Async Video Interview needs 3 to 8 questions before it can be published.",
    both: "Restored as On hold: this job's AI Video Interview needs 4 to 8 questions and its Async Video Interview needs 3 to 8 before it can be published.",
    unreadable: "Restored as On hold: this job's interview questions couldn't be checked.",
  },
};

/** The message for a path and what fails. Unreadable fails closed with its own message. */
export function goLiveMessage(
  path: GoLivePath,
  failing: GoLiveFailing,
  unreadable = false,
): string {
  const m = GO_LIVE_MESSAGES[path];
  if (unreadable) return m.unreadable;
  if (failing.live && failing.async) return m.both;
  return failing.async ? m.async : m.live;
}
