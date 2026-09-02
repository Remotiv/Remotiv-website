"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import { buildCandidateHtml, deliverEmail } from "@/lib/email/candidate/deliver";
import {
  buildPlaceholders,
  escapeHtml,
  renderCopy,
} from "@/lib/email/candidate/render";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import { REMINDER_LEAD_MS } from "@/lib/interviews/reminder";
import {
  interviewUrl,
  mintSessionToken,
  RETENTION_MONTHS,
  SESSION_EXPIRY_DAYS,
} from "@/lib/interviews/tokens";
import type {
  InterviewPanelState,
  InterviewSessionSummary,
} from "./interview-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./interview-types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

/** Same message for not-found and not-yours, as everywhere else. */
const NOT_YOURS = "Applicant not found in your workspace.";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Send a candidate their video interview.
 *
 * Manual, from the applicant drawer — nothing sends an interview automatically,
 * because deciding someone should record answers is a hiring judgement.
 *
 * Guarded like every other applicant mutation: the application is re-fetched
 * server-side, checked against the company, and then against the hiring team
 * for the job it belongs to. The id from the client proves nothing.
 */
export async function sendInterviewInvite(
  applicationId: string,
): Promise<MutationResult<{ expiresAt: string }>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_id, job_title_snapshot, jobs(title), company_id_snapshot",
    )
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  const app = appData as unknown as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    job_id: string | null;
    job_title_snapshot: string | null;
    jobs?: { title: string | null } | null;
  } | null;

  if (!app) return { success: false, error: NOT_YOURS };
  if (!(await canAccessJob(ctx, app.job_id ?? ""))) {
    return { success: false, error: NOT_YOURS };
  }

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) {
    return { success: false, error: "This applicant has no email address." };
  }
  if (!app.job_id) {
    return {
      success: false,
      error: "This application isn't attached to a job, so there's nothing to ask.",
    };
  }

  /*
   * ── The job's own switch ──
   *
   * async_interview_enabled is set in the job wizard's More options. Until
   * now nothing read it: the toggle stored a value and sending checked only
   * whether questions existed, so a company that had deliberately left async
   * interviews OFF could still send one from the drawer.
   *
   * Re-fetched here, server-side, from the live job row. The client is not
   * asked and its answer would not be believed. The drawer disables its button
   * on the same fact, but that is a courtesy to the recruiter — THIS is the
   * gate, and it is the only one that matters.
   *
   * `=== true` and not `!== false`: the column defaults to FALSE, so an
   * absent or null value must refuse. This is the opposite polarity to
   * allow_rerecord below, which defaults to true, and getting the two the
   * same way round would silently invert one of them.
   */
  const settings = await readJobInterviewSettings(service, app.job_id);
  if (!settings.asyncEnabled) {
    return {
      success: false,
      error:
        "Async video interviews are switched off for this job. Turn them on under More options in the job's settings, then send again.",
    };
  }

  /*
   * Read the questions ONCE, here, and freeze them onto the session below.
   *
   * This read stays on the LIVE table — it is the pre-send guard, and it runs
   * before any snapshot exists. Everything after the invite reads the frozen
   * copy instead, which is what stops a later job edit from reaching a
   * candidate who is already mid-interview.
   *
   * rubric, competency and weight are NOT selected. That is the marking
   * scheme, and this array becomes the candidate payload — see the
   * SnapshotQuestion comment in lib/interviews/session.ts. Do not add them.
   */
  const { data: questionRows } = await service
    .from("interview_questions")
    .select("id, position, question, prep_seconds, answer_seconds, required")
    .eq("job_id", app.job_id)
    .eq("company_id", ctx.companyId)
    .order("position", { ascending: true })
    .limit(50);

  const questionsSnapshot = (questionRows ?? []) as {
    id: string;
    position: number;
    question: string | null;
    prep_seconds: number | null;
    answer_seconds: number | null;
    required: boolean | null;
  }[];

  // No questions, no interview. Sending a link to an empty interview wastes
  // the candidate's time and looks broken from their side.
  if (questionsSnapshot.length === 0) {
    return {
      success: false,
      error: "Add interview questions to this job first — there's nothing to ask yet.",
    };
  }

  /*
   * One open session per application. Re-sending supersedes rather than
   * accumulating: two live links for one candidate means two half-finished
   * interviews and no way to say which is theirs.
   *
   * A SUBMITTED session is never superseded — submitted is final, and the
   * caller is told so rather than silently issuing a link that would let
   * someone re-record answers already with the hiring team.
   */
  const { data: existingData } = await service
    .from("interview_sessions")
    .select("id, status, submitted_at")
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .in("status", ["invited", "started", "submitted"])
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = ((existingData ?? []) as {
    id: string;
    status: string;
    submitted_at: string | null;
  }[])[0];

  if (existing?.status === "submitted") {
    return {
      success: false,
      error: "They've already submitted this interview. Answers can't be re-recorded.",
    };
  }

  if (existing) {
    await service
      .from("interview_sessions")
      .update({ status: "cancelled" })
      .eq("id", existing.id)
      .eq("company_id", ctx.companyId);
  }

  const { rawToken, tokenHash } = mintSessionToken();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_EXPIRY_DAYS * DAY_MS).toISOString();
  const deleteAfter = new Date(
    new Date(now).setMonth(new Date(now).getMonth() + RETENTION_MONTHS),
  ).toISOString();

  const jobTitle =
    (app.jobs?.title ?? "").trim() || (app.job_title_snapshot ?? "").trim() || "the role";

  const { data: created, error: sessionErr } = await service
    .from("interview_sessions")
    .insert({
      company_id: ctx.companyId,
      application_id: applicationId,
      job_id: app.job_id,
      token_hash: tokenHash,
      status: "invited",
      // Snapshotted from the job so a later toggle can't retroactively let
      // someone re-record an interview they were invited to under other rules.
      allow_rerecord: settings.allowRerecord,
      // The question set as it stands right now. Frozen for the same reason
      // as allow_rerecord, and for the stronger one that positions are the
      // key for answers and storage paths.
      questions_snapshot: questionsSnapshot,
      expires_at: expiresAt,
      invited_by: ctx.memberId,
      invited_by_name: ctx.memberName,
      delete_after: deleteAfter,
    })
    .select("id")
    .single();

  if (sessionErr || !created) {
    return {
      success: false,
      error: sessionErr?.message ?? "Couldn't create the interview.",
    };
  }

  const { data: companyData } = await service
    .from("companies")
    .select("name, candidate_reply_email")
    .eq("id", ctx.companyId)
    .maybeSingle();
  const company = companyData as {
    name: string | null;
    candidate_reply_email: string | null;
  } | null;
  const companyName = (company?.name ?? "").trim();

  /*
   * The invite goes out through the SAME path as every other candidate email —
   * renderCopy for substitution, buildCandidateHtml for the shell and the
   * unsubscribe footer, deliverEmail for sender identity, reply-to, the daily
   * cap and the log-before-send row. Nothing here talks to Resend directly.
   *
   * Event 'interview' rather than 'manual': it IS the lifecycle event, so it
   * lands in the Messages page's Automatic tab and shares the idempotency and
   * opt-out semantics of the rest of the lifecycle.
   */
  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });

  const link = interviewUrl(rawToken);
  const deadline = new Date(expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  const rendered = renderCopy(
    {
      subject: `Your video interview for {{job_title}} at {{company_name}}`,
      body: [
        "<p>Hi {{candidate_first_name}},</p>",
        "<p><strong>{{company_name}}</strong> would like you to answer a few questions on video for <strong>{{job_title}}</strong>. There's no call to schedule — you record the answers in your own time, from your phone or laptop.</p>",
        `<p><a href="${escapeHtml(link)}" style="color:#7E47FF;font-weight:700">Start your interview</a></p>`,
        `<p>The link works until <strong>${escapeHtml(deadline)}</strong>. There's a practice round first, and it isn't recorded.</p>`,
        "<p>Good luck.</p>",
      ].join("\n"),
    },
    values,
  );

  const html = buildCandidateHtml(rendered.body, companyName, ctx.companyId, to);

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId,
    event: "interview",
    to,
    subject: rendered.subject,
    html,
    companyName,
    replyTo: (company?.candidate_reply_email ?? "").trim() || null,
    sentByName: ctx.memberName,
  });

  if (!outcome.ok) {
    /*
     * The session exists but nobody can reach it, so it is cancelled rather
     * than left as a live token with no delivered link. Re-sending mints a
     * fresh one; leaving this open would accumulate dead sessions that the
     * one-open-session rule would then have to reason about.
     */
    await service
      .from("interview_sessions")
      .update({ status: "cancelled" })
      .eq("id", (created as { id: string }).id);
    return { success: false, error: outcome.message };
  }

  /*
   * ── WhatsApp, alongside the email ──
   *
   * ENQUEUED, never sent inline. This action already did the slow work
   * (session insert, question snapshot, email) and a recruiter is waiting on
   * the response; a second network call to Meta would add latency to a click
   * for a channel that is supplementary. The queue also gives it retries and a
   * dead letter for free.
   *
   * Deliberately non-fatal, on the same contract as the CV-scoring enqueue in
   * /api/apply: the interview HAS been created and the email HAS gone out, so
   * a queue outage costs a second notification, never the invitation itself.
   * Returning an error here would tell a recruiter the invite failed when it
   * did not.
   */
  try {
    const queued = await enqueue({
      type: JOB_TYPES.SEND_MESSAGE,
      payload: {
        applicationId,
        event: "interview",
        channel: "whatsapp",
        // The deadline the email already quoted, rendered identically so the
        // two channels cannot disagree about the date.
        deadline,
        /*
         * Who asked for this, carried so the dispatcher can tell an explicit
         * re-send from an automatic one — and so the log row lands OUTSIDE the
         * partial unique index that keeps automatic sends unique. Same value
         * the email above records. The reminder enqueue deliberately omits it:
         * nobody asked for that one.
         */
        sentByName: ctx.memberName,
      },
      companyId: ctx.companyId,
    });
    if (!queued.ok) {
      console.error("[interview] whatsapp enqueue failed (non-fatal):", queued.error);
    }
  } catch (err) {
    console.error("[interview] whatsapp enqueue threw (non-fatal):", err);
  }

  /*
   * ── The reminder and the expiry, scheduled off this session's own deadline ──
   *
   * Both are queued HERE, at send, with run_after set from expires_at — so
   * nothing polls interview_sessions looking for work that has come due, and
   * the queue's existing `run_after <= now()` claim is the entire scheduler.
   *
   * Non-fatal, like the WhatsApp enqueue above and for the same reason: the
   * interview exists and the invitation has been delivered. A queue outage
   * costs a nudge and a status label, never the invitation. Expiry is derived
   * on read in both places that matter (resolveSessionByToken for the
   * candidate, deriveStatus for the recruiter's list), so a lost expiry job
   * leaves a stale stored status and a missing notification — not a session
   * anyone can still record against.
   */
  const sessionId = (created as { id: string }).id;
  await scheduleInterviewJobs({
    sessionId,
    companyId: ctx.companyId,
    expiresAt,
    expiresAtMs: now + SESSION_EXPIRY_DAYS * DAY_MS,
    deadline,
  });

  revalidatePath("/ai-dashboard/applicants");
  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: { expiresAt } };
}

/**
 * Queue the reminder and the expiry for one freshly sent session.
 *
 * Not exported — a "use server" module compiles every export into a server
 * action, and scheduling background work is not something a browser may ask
 * for. Callable only from sendInterviewInvite, which has already done the
 * company and hiring-team checks.
 *
 * ── When the reminder is skipped entirely ──
 *
 * If the window is 24 hours or less, `run_after` would land at or before now
 * and the reminder would fire within one worker tick of the invitation — "your
 * interview closes tomorrow" arriving minutes after "here is your interview".
 * That is worse than no reminder, so none is queued and the reason is logged.
 *
 * Unreachable today: SESSION_EXPIRY_DAYS is 5, so the lead is always four days.
 * It is a guard against the value being lowered, or being made per-job, without
 * anyone re-deriving what that does to the reminder.
 */
async function scheduleInterviewJobs(input: {
  sessionId: string;
  companyId: string;
  expiresAt: string;
  expiresAtMs: number;
  deadline: string;
}): Promise<void> {
  const { sessionId, companyId, expiresAt, expiresAtMs, deadline } = input;

  try {
    const reminderAtMs = expiresAtMs - REMINDER_LEAD_MS;
    if (reminderAtMs <= Date.now()) {
      console.log(
        `[interview] no reminder for session ${sessionId} — the window is shorter than the ${
          REMINDER_LEAD_MS / (60 * 60 * 1000)
        }h reminder lead`,
      );
    } else {
      const queued = await enqueue({
        type: JOB_TYPES.INTERVIEW_REMINDER,
        // `deadline` is the invitation email's exact wording, so the reminder
        // cannot quote a different date to the same candidate; `expiresAt` is
        // the instant it was derived from, which is what lets the handler
        // notice that the deadline has since moved.
        payload: { sessionId, deadline, expiresAt },
        companyId,
        runAfter: new Date(reminderAtMs),
      });
      if (!queued.ok) {
        console.error("[interview] reminder enqueue failed (non-fatal):", queued.error);
      }
    }

    const expired = await enqueue({
      type: JOB_TYPES.INTERVIEW_EXPIRY,
      payload: { sessionId },
      companyId,
      runAfter: new Date(expiresAtMs),
    });
    if (!expired.ok) {
      console.error("[interview] expiry enqueue failed (non-fatal):", expired.error);
    }
  } catch (err) {
    console.error("[interview] scheduling enqueue threw (non-fatal):", err);
  }
}

/**
 * The two job columns the interview flow actually reads.
 *
 * One query, because the send path needs both and they are read at the same
 * moment — the gate and the value frozen onto the session.
 *
 * NOTE the deliberately different defaults. `allow_rerecord` defaults to TRUE
 * in the database, so a null must permit; `async_interview_enabled` defaults to
 * FALSE, so a null must refuse. Reading both with the same comparison is the
 * easy mistake here and it would either lock recruiters out of a feature they
 * enabled or hand them one they switched off.
 */
async function readJobInterviewSettings(
  service: ReturnType<typeof createServiceClient>,
  jobId: string,
): Promise<{ allowRerecord: boolean; asyncEnabled: boolean }> {
  const { data } = await service
    .from("jobs")
    .select("allow_rerecord, async_interview_enabled")
    .eq("id", jobId)
    .maybeSingle();
  const row = data as {
    allow_rerecord: boolean | null;
    async_interview_enabled: boolean | null;
  } | null;
  return {
    allowRerecord: row?.allow_rerecord !== false,
    asyncEnabled: row?.async_interview_enabled === true,
  };
}

/**
 * The interview state for one applicant, for the drawer.
 *
 * Never returns the token — not the raw one, which is not stored, and not the
 * hash, which would be just as good a credential if the hashing were ever
 * reversed by a bug. The drawer shows status and dates; re-sending mints a new
 * token rather than resurfacing the old link.
 */
export async function fetchInterviewPanel(
  applicationId: string,
): Promise<InterviewPanelState> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /** Nothing to show and nothing to offer — the guard cases all land here. */
  const NOTHING: InterviewPanelState = {
    session: null,
    asyncEnabled: false,
    jobId: null,
  };

  const { data: appData } = await service
    .from("job_applications")
    .select("id, job_id")
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();
  const app = appData as { job_id: string | null } | null;
  if (!app) return NOTHING;
  if (!(await canAccessJob(ctx, app.job_id ?? ""))) return NOTHING;

  /*
   * Read the job's switch even when a session already exists. An interview
   * sent before the toggle was turned off must still be visible and reviewable
   * — only the SEND is conditional, and hiding the record of one already taken
   * would lose a candidate's work to a settings change.
   */
  const asyncEnabled = app.job_id
    ? (await readJobInterviewSettings(service, app.job_id)).asyncEnabled
    : false;
  const base = { asyncEnabled, jobId: app.job_id };

  const { data } = await service
    .from("interview_sessions")
    .select(
      "id, status, expires_at, submitted_at, started_at, invited_by_name, created_at, questions_snapshot",
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false })
    .limit(1);

  const row = ((data ?? []) as {
    id: string;
    status: string;
    expires_at: string;
    submitted_at: string | null;
    started_at: string | null;
    invited_by_name: string | null;
    created_at: string;
    questions_snapshot: unknown;
  }[])[0];
  if (!row) return { ...base, session: null };

  // The interview score, if one exists. Company-gated on its own column.
  const { data: scoreRow } = await service
    .from("interview_session_scores")
    .select("status, overall_score, human_adjusted_score")
    .eq("session_id", row.id)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const sc = scoreRow as {
    status: string | null;
    overall_score: number | null;
    human_adjusted_score: number | null;
  } | null;

  const { count: answered } = await service
    .from("interview_answers")
    .select("id", { count: "exact", head: true })
    .eq("session_id", row.id);

  /*
   * "N of M answered" must count the questions THIS candidate was invited to,
   * not the job's current set — otherwise editing a job would silently change
   * the denominator on an interview already in progress, and a completed one
   * could read "3 of 5".
   *
   * The live count remains the fallback for sessions invited before the
   * snapshot column existed.
   */
  let total: number | null = Array.isArray(row.questions_snapshot)
    ? row.questions_snapshot.length
    : null;

  if (total === null) {
    const { count } = await service
      .from("interview_questions")
      .select("id", { count: "exact", head: true })
      .eq("job_id", app.job_id ?? "")
      .eq("company_id", ctx.companyId);
    total = count ?? 0;
  }

  const session: InterviewSessionSummary = {
    id: row.id,
    // Expiry is derived, not read: a session nothing has swept is still
    // expired once the deadline passes.
    status:
      row.status === "invited" && new Date(row.expires_at).getTime() < Date.now()
        ? "expired"
        : row.status,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    invitedByName: row.invited_by_name,
    sentAt: row.created_at,
    answered: answered ?? 0,
    total: total ?? 0,
    score: sc ? (sc.human_adjusted_score ?? sc.overall_score) : null,
    scoreStatus: sc?.status ?? null,
  };

  return { ...base, session };
}
