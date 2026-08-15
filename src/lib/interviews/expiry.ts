import "server-only";
import { skipJob } from "@/lib/job-skip";
import { notifyCompany } from "@/lib/notifications/company";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * The interview_expiry handler — close the window, tell the recruiter.
 *
 * ── This changes a label, not the data ───────────────────────
 *
 * Expiry has always been DERIVED: resolveSessionByToken computes it so a
 * candidate cannot get a working recorder past the deadline whether or not a
 * cron fired, and review.ts's deriveStatus computes it so the Expired tab is
 * right either way. Both are unchanged and both remain the authority.
 *
 * What this job adds is that the STORED column finally agrees with them, and —
 * the part that is genuinely new — that somebody is told. A deadline passing is
 * the one interview event with no user action behind it, so without this it is
 * the one event nobody finds out about until they go looking.
 *
 * ── Nothing is deleted, hidden, or detached ──────────────────
 *
 * A partially completed interview keeps every answer it recorded. The status
 * write touches interview_sessions.status and nothing else; interview_answers
 * rows, their videos, their transcripts and any scorecard are untouched, and
 * loadInterviewSession has no status gate, so the recruiter can still open the
 * session and watch what was recorded. Media leaves on the retention schedule
 * (delete_after, six months) exactly as it would have, not on expiry.
 *
 * ── Who hears about it ───────────────────────────────────────
 *
 * The hiring team for that job, plus every owner and admin — notifyCompany's
 * standard rule, reused rather than reimplemented. That set necessarily
 * includes the person who sent the invite: sendInterviewInvite is gated by
 * canAccessJob, which either waves through an owner/admin or requires a
 * job_hiring_team row, and both are in the fan-out.
 *
 * The CANDIDATE is deliberately not told. A closed window is not something they
 * can act on, and "you missed it" from an automated system is a kick on the way
 * out.
 */

/** Statuses that reached their own conclusion and must not be overwritten. */
const SETTLED_STATUSES = new Set(["submitted", "cancelled", "expired"]);

/** The two this job is allowed to close. Also the race guard on the UPDATE. */
const EXPIRABLE_STATUSES = ["invited", "started"];

export type InterviewExpiryPayload = { sessionId: string };

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  status: string;
  expires_at: string;
  submitted_at: string | null;
};

export async function handleInterviewExpiry(job: {
  id: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const payload = job.payload as unknown as InterviewExpiryPayload;
  const sessionId = payload?.sessionId;

  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(`interview_expiry: payload has no sessionId (job ${job.id})`);
  }

  const service = createServiceClient();

  const { data: sessionData } = await service
    .from("interview_sessions")
    .select("id, company_id, application_id, job_id, status, expires_at, submitted_at")
    .eq("id", sessionId)
    .maybeSingle();

  const session = sessionData as SessionRow | null;
  if (!session) {
    skipJob("interview_expiry", job.id, `session ${sessionId} no longer exists`);
    return;
  }

  /*
   * Submitted, cancelled or already expired. Silently, as specified — these are
   * the ordinary happy paths, not anomalies:
   *
   *   submitted  the candidate finished inside the window. This is the outcome
   *              the whole feature wants, and its expiry job firing afterwards
   *              is expected, not a problem to report.
   *   cancelled  superseded by a re-send, or rolled back when the invitation
   *              email failed.
   *   expired    a previous run of this job already did the work. Returning
   *              here is what stops a second notification — see the conditional
   *              UPDATE below for the concurrent case.
   */
  if (SETTLED_STATUSES.has(session.status) || session.submitted_at) {
    skipJob(
      "interview_expiry",
      job.id,
      `session ${sessionId} is already ${session.status} — nothing to expire`,
    );
    return;
  }

  /*
   * The deadline is still in the future.
   *
   * Nothing produces this today — expires_at is written once at send and there
   * is no extension feature — so it means either an early tick or a deadline
   * that moved. Either way, expiring a session whose window is open would lock
   * a candidate out mid-interview, so it refuses. If an extension feature is
   * ever built, THIS is the guard that keeps a stale job from closing an
   * extended interview, and the enqueue side would need to schedule a fresh job
   * for the new date; see the report.
   */
  if (new Date(session.expires_at).getTime() > Date.now()) {
    skipJob(
      "interview_expiry",
      job.id,
      `session ${sessionId} does not close until ${session.expires_at}`,
    );
    return;
  }

  /*
   * ── The write, and the only idempotency that matters ──
   *
   * ONE conditional UPDATE, guarded on the status it expects to find. Two
   * workers running this concurrently — a reclaimed lease, a duplicated enqueue
   * — both issue it; the second blocks on the row lock, re-evaluates
   * `status IN ('invited','started')` against the committed row, finds
   * 'expired', and gets an EMPTY returning set. Only the winner notifies.
   *
   * The same predicate closes the read-then-write gap above: a candidate who
   * submits between the SELECT and this UPDATE keeps their submission, because
   * 'submitted' is not in the allowed set.
   */
  const { data: updated, error } = await service
    .from("interview_sessions")
    .update({ status: "expired" })
    .eq("id", sessionId)
    .eq("company_id", session.company_id)
    .in("status", EXPIRABLE_STATUSES)
    .select("id");

  if (error) {
    // A write failure IS worth retrying — the row is real and still open.
    throw new Error(`interview_expiry: could not expire ${sessionId}: ${error.message}`);
  }

  if ((updated ?? []).length === 0) {
    skipJob(
      "interview_expiry",
      job.id,
      `session ${sessionId} was settled by another writer first`,
    );
    return;
  }

  await notifyRecruiters(service, session);
}

/**
 * Tell the hiring team, naming the candidate and how far they got.
 *
 * "3 of 5 answered" is the load-bearing part of the message: it is the
 * difference between a candidate who ignored the invitation and one who was
 * halfway through and ran out of time, and only the second is worth chasing.
 *
 * Never throws — notifyCompany swallows its own failures by design, and this
 * wrapper's own reads are wrapped for the same reason. The session IS expired
 * by the time we get here, and failing the job would retry the whole handler,
 * which would then find the session already expired and skip without ever
 * notifying.
 */
async function notifyRecruiters(
  service: ReturnType<typeof createServiceClient>,
  session: SessionRow,
): Promise<void> {
  try {
    const [{ data: appData }, { data: jobData }, { count: answered }] =
      await Promise.all([
        session.application_id
          ? service
              .from("job_applications")
              .select("first_name, last_name")
              .eq("id", session.application_id)
              .eq("company_id_snapshot", session.company_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        session.job_id
          ? service
              .from("jobs")
              .select("title")
              .eq("id", session.job_id)
              .eq("company_id", session.company_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        service
          .from("interview_answers")
          .select("id", { count: "exact", head: true })
          .eq("session_id", session.id),
      ]);

    const app = appData as { first_name: string | null; last_name: string | null } | null;
    const who =
      [app?.first_name, app?.last_name].filter(Boolean).join(" ").trim() ||
      "A candidate";
    const title = ((jobData as { title: string | null } | null)?.title ?? "").trim();

    const recorded = answered ?? 0;
    const progress =
      recorded > 0
        ? `They recorded ${recorded} ${recorded === 1 ? "answer" : "answers"} before the deadline — those are still on the interview.`
        : "They didn't record any answers.";

    await notifyCompany({
      companyId: session.company_id,
      type: "interview_expired",
      title: `${who}'s interview deadline passed`,
      body: `The video interview for ${title || "this role"} closed without a submission. ${progress}`,
      jobId: session.job_id,
      applicationId: session.application_id,
      href: `/ai-dashboard/interviews/${session.id}`,
      // No actor: a deadline passing has nobody behind it, so there is nobody
      // to leave out of the fan-out.
    });
  } catch (err) {
    console.error("[interview_expiry] notification failed (non-fatal):", err);
  }
}
