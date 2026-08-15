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
 * ── A job that arrives early re-arms itself ──────────────────
 *
 * `run_after` is frozen when the job is created, but `expires_at` is not — a
 * deadline that moves leaves the two disagreeing. A job that finds the window
 * still open therefore schedules a successor for the current deadline rather
 * than reporting done; see rescheduleExpiry for why that terminates.
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
   * ── The deadline is still in the future: RESCHEDULE, never succeed ──
   *
   * Expiring a session whose window is open would lock a candidate out
   * mid-interview, so this must not write. But returning done was worse: the
   * job is consumed, `run_after` on a succeeded row is never re-examined, and
   * nothing else in the system ever looks at this session again. It could then
   * never expire — permanently stuck 'invited', with no notification, for the
   * rest of its life. Two sessions reached that state.
   *
   * So it re-arms instead, against the deadline as the row states it NOW rather
   * than whatever was true when this job was created. One job leaves the queue
   * and one enters it, aimed at the current date.
   */
  if (new Date(session.expires_at).getTime() > Date.now()) {
    await rescheduleExpiry(service, session, job.id);
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
 * Re-arm this session's expiry against the deadline the row states now.
 *
 * ── Why this cannot become an infinite chain ─────────────────
 *
 * Three independent reasons, and the first alone is sufficient:
 *
 * 1. IT ONLY EVER MOVES FORWARD. This path is reached only when
 *    `expires_at > now()`, and `run_after` is set to that same future instant.
 *    claimJobs takes `run_after <= now()`, so the replacement is not claimable
 *    until the deadline actually arrives. A chain of N reschedules therefore
 *    spans at least as much wall-clock as the extensions themselves — it can
 *    never spin inside a tick, and it burns one job per extension, not per
 *    poll. A session past its deadline expires instead, which is the base case.
 *
 * 2. IT CANNOT FAN OUT. Without the duplicate check below, two expiry jobs for
 *    one session that both fired early would each enqueue a replacement: two
 *    become four, four become eight. The check makes the count converge to one
 *    regardless of how many are live when it runs.
 *
 * 3. EXTENSIONS ARE HUMAN ACTIONS. Chain length is bounded by how many times a
 *    person moves a deadline, not by anything the queue does on its own.
 *
 * ── Excluding THIS job from the duplicate check is load-bearing ──
 *
 * This job is 'running' right now and its payload carries the same sessionId,
 * so an unqualified "is one already live?" query matches ITSELF, concludes a
 * replacement exists, and re-arms nothing — reintroducing the exact orphan this
 * function was written to prevent. Hence `.neq("id", currentJobId)`.
 */
async function rescheduleExpiry(
  service: ReturnType<typeof createServiceClient>,
  session: SessionRow,
  currentJobId: string,
): Promise<void> {
  const { enqueue, JOB_TYPES } = await import("@/lib/jobs-queue");

  const { data: live } = await service
    .from("background_jobs")
    .select("id")
    .eq("type", JOB_TYPES.INTERVIEW_EXPIRY)
    .in("status", ["queued", "running"])
    .contains("payload", { sessionId: session.id })
    .neq("id", currentJobId)
    .limit(1);

  if ((live ?? []).length > 0) {
    skipJob(
      "interview_expiry",
      currentJobId,
      `session ${session.id} closes at ${session.expires_at} and another expiry job is already queued for it`,
    );
    return;
  }

  const queued = await enqueue({
    type: JOB_TYPES.INTERVIEW_EXPIRY,
    payload: { sessionId: session.id },
    companyId: session.company_id,
    runAfter: new Date(session.expires_at),
  });

  /*
   * THROWS if the re-arm fails, rather than logging and returning.
   *
   * Everywhere else in the interview flow a failed enqueue is non-fatal,
   * because the thing that mattered had already happened. Here the enqueue IS
   * the thing that matters: swallowing the failure consumes this job and leaves
   * the session with nothing scheduled — precisely the orphan state. Throwing
   * takes the normal retry-with-backoff path, and a job that exhausts its
   * attempts lands in 'dead' where it is visible instead of silent.
   */
  if (!queued.ok) {
    throw new Error(
      `interview_expiry: could not re-arm session ${session.id} for ${session.expires_at}: ${queued.error}`,
    );
  }

  console.log(
    `[interview_expiry] session ${session.id} rescheduled for ${session.expires_at} (job ${queued.id})`,
  );
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
