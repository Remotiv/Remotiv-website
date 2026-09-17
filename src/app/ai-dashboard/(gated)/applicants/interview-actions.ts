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
import { liveInterviewsAvailableFor } from "@/lib/interviews/live-availability";
import { gateLiveInterviewInvite } from "@/lib/interviews/live-settings";
import {
  interviewUrl,
  mintSessionToken,
  RETENTION_MONTHS,
  SESSION_EXPIRY_DAYS,
} from "@/lib/interviews/tokens";
import { type InterviewKind, readInterviewKind } from "@/lib/interviews/types";
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
 *
 * ── Shared with sendLiveInterviewInvite ──────────────────────
 *
 * The two send paths are built from the same private helpers below — the
 * application guards, the question snapshot, the supersede rule, the dates,
 * the email delivery and the scheduling — so a fix to one reaches the other.
 * What stays per kind is the session row, the email copy, and WhatsApp (async
 * only). The order of steps here is the order this action has always run in.
 */
export async function sendInterviewInvite(
  applicationId: string,
): Promise<MutationResult<{ expiresAt: string }>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const target = await loadInviteTarget(service, ctx, applicationId);
  if (!target.ok) return { success: false, error: target.error };
  const { app, jobId } = target;

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
  const settings = await readJobInterviewSettings(service, jobId);
  if (!settings.asyncEnabled) {
    return {
      success: false,
      error:
        "Async video interviews are switched off for this job. Turn them on under More options in the job's settings, then send again.",
    };
  }

  const questionsSnapshot = await loadQuestionsSnapshot(service, jobId, ctx.companyId);
  // No questions, no interview. Sending a link to an empty interview wastes
  // the candidate's time and looks broken from their side.
  if (questionsSnapshot.length === 0) {
    return { success: false, error: NO_QUESTIONS };
  }

  const superseded = await supersedeOpenSession(service, {
    applicationId,
    companyId: ctx.companyId,
    kind: "async",
    submittedError: "They've already submitted this interview. Answers can't be re-recorded.",
  });
  if (!superseded.ok) return { success: false, error: superseded.error };

  const { rawToken, tokenHash } = mintSessionToken();
  const dates = inviteDates();

  const { data: created, error: sessionErr } = await service
    .from("interview_sessions")
    .insert({
      company_id: ctx.companyId,
      application_id: applicationId,
      job_id: jobId,
      token_hash: tokenHash,
      status: "invited",
      // Named, never defaulted. The column's default backfills rows that
      // predate it and is due to be dropped; a writer that omits kind must
      // fail a NOT NULL at that point rather than silently mint an async
      // session for the wrong option.
      kind: "async",
      // Snapshotted from the job so a later toggle can't retroactively let
      // someone re-record an interview they were invited to under other rules.
      allow_rerecord: settings.allowRerecord,
      // The question set as it stands right now. Frozen for the same reason
      // as allow_rerecord, and for the stronger one that positions are the
      // key for answers and storage paths.
      questions_snapshot: questionsSnapshot,
      expires_at: dates.expiresAt,
      invited_by: ctx.memberId,
      invited_by_name: ctx.memberName,
      delete_after: dates.deleteAfter,
    })
    .select("id")
    .single();

  if (sessionErr || !created) {
    return {
      success: false,
      error: sessionErr?.message ?? "Couldn't create the interview.",
    };
  }
  const sessionId = (created as { id: string }).id;

  const delivered = await deliverInvite(service, {
    ctx,
    applicationId,
    app,
    sessionId,
    rawToken,
    expiresAt: dates.expiresAt,
    copy: (link, deadline) => ({
      subject: `Your video interview for {{job_title}} at {{company_name}}`,
      body: [
        "<p>Hi {{candidate_first_name}},</p>",
        "<p><strong>{{company_name}}</strong> would like you to answer a few questions on video for <strong>{{job_title}}</strong>. There's no call to schedule — you record the answers in your own time, from your phone or laptop.</p>",
        `<p><a href="${escapeHtml(link)}" style="color:#7E47FF;font-weight:700">Start your interview</a></p>`,
        `<p>The link works until <strong>${escapeHtml(deadline)}</strong>. There's a practice round first, and it isn't recorded.</p>`,
        "<p>Good luck.</p>",
      ].join("\n"),
    }),
  });
  if (!delivered.ok) return { success: false, error: delivered.error };
  const { deadline } = delivered;

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
   *
   * ASYNC ONLY. The approved WhatsApp template describes recording answers in
   * your own time, which is not what an AI Video Interview is.
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
  await scheduleInterviewJobs({
    sessionId,
    companyId: ctx.companyId,
    expiresAt: dates.expiresAt,
    expiresAtMs: dates.expiresAtMs,
    deadline,
    reminder: true,
  });

  revalidatePath("/ai-dashboard/applicants");
  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: { expiresAt: dates.expiresAt } };
}

/**
 * Send a candidate an AI Video Interview.
 *
 * ── NOT usable in production yet ─────────────────────────────
 *
 * The candidate route has no live screen: a live link resolves to "This
 * interview isn't open yet" (resolveSessionByToken). Two locks keep this out
 * of a recruiter's hands until that exists:
 *
 *   · gateLiveInterviewInvite refuses any company not on the
 *     AI_VIDEO_INTERVIEW_COMPANY_IDS allowlist, which is empty in production,
 *     and the drawer does not render the button for one.
 *   · Even if that leaked, the candidate route refuses every session whose
 *     kind is not async, so nobody lands in the async recorder with a live
 *     session.
 *
 * ── What this does NOT do ────────────────────────────────────
 *
 * It creates no provider session and connects to nothing. That is the join
 * step, after consent, and the provider does not exist yet. It also does not
 * restart anything: attempt is always 1 here. The restart path comes with the
 * disconnect handling.
 *
 * Same guards, questions, supersede rule, dates and delivery as
 * sendInterviewInvite, from the same helpers.
 */
export async function sendLiveInterviewInvite(
  applicationId: string,
): Promise<MutationResult<{ expiresAt: string }>> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const target = await loadInviteTarget(service, ctx, applicationId);
  if (!target.ok) return { success: false, error: target.error };
  const { app, jobId } = target;

  /*
   * THE gate, and never around it: the allowlist, the job's toggle and the
   * interviewer name, all re-read server-side. Its output is the only source
   * of live settings — buildLiveSettings is private to that module.
   */
  const gate = await gateLiveInterviewInvite(service, { jobId, companyId: ctx.companyId });
  if (!gate.ok) return { success: false, error: gate.error };

  const questionsSnapshot = await loadQuestionsSnapshot(service, jobId, ctx.companyId);
  if (questionsSnapshot.length === 0) {
    return { success: false, error: NO_QUESTIONS };
  }

  // Live sessions only. An async interview this candidate was already sent is
  // never read, never cancelled.
  const superseded = await supersedeOpenSession(service, {
    applicationId,
    companyId: ctx.companyId,
    kind: "live",
    submittedError: "They've already completed this AI Video Interview.",
  });
  if (!superseded.ok) return { success: false, error: superseded.error };

  const { rawToken, tokenHash } = mintSessionToken();
  const dates = inviteDates();

  const { data: created, error: sessionErr } = await service
    .from("interview_sessions")
    .insert({
      company_id: ctx.companyId,
      application_id: applicationId,
      job_id: jobId,
      token_hash: tokenHash,
      status: "invited",
      kind: "live",
      // Frozen at invite (migration 018): a later job edit must not change an
      // interview already sent.
      live_settings: gate.settings,
      // A first attempt. Named, not defaulted, so the restart path — which
      // sets 2 and a predecessor — is the only writer that ever differs
      // (migration 020's trigger checks that one).
      attempt: 1,
      previous_attempt_id: null,
      // Re-recording means nothing in a live conversation. False, so no reader
      // offers it for this session.
      allow_rerecord: false,
      questions_snapshot: questionsSnapshot,
      expires_at: dates.expiresAt,
      invited_by: ctx.memberId,
      invited_by_name: ctx.memberName,
      delete_after: dates.deleteAfter,
      // provider and provider_session_id are deliberately absent: written at
      // join, which does not exist yet (migration 019).
    })
    .select("id")
    .single();

  if (sessionErr || !created) {
    return {
      success: false,
      error: sessionErr?.message ?? "Couldn't create the interview.",
    };
  }
  const sessionId = (created as { id: string }).id;

  // No avatar and no duration figure: Phase 1 has no avatar, and the longer
  // duration with follow-ups belongs on the welcome screen once it exists.
  // "In one go" because a reader used to the async invite's rhythm would
  // assume they can stop and come back.
  const delivered = await deliverInvite(service, {
    ctx,
    applicationId,
    app,
    sessionId,
    rawToken,
    expiresAt: dates.expiresAt,
    copy: (link, deadline) => ({
      subject: `Your AI Video Interview for {{job_title}} at {{company_name}}`,
      body: [
        "<p>Hi {{candidate_first_name}},</p>",
        "<p><strong>{{company_name}}</strong> would like you to take an AI Video Interview for <strong>{{job_title}}</strong>. It's a spoken interview on camera: an AI interviewer asks you questions out loud, and may ask up to two follow-up questions about an answer.</p>",
        "<p>Set aside time to do it in one go, somewhere quiet, before the deadline.</p>",
        `<p><a href="${escapeHtml(link)}" style="color:#7E47FF;font-weight:700">Start your interview</a></p>`,
        `<p>The link works until <strong>${escapeHtml(deadline)}</strong>. Have your camera and microphone ready.</p>`,
        "<p>Good luck.</p>",
      ].join("\n"),
    }),
  });
  if (!delivered.ok) return { success: false, error: delivered.error };

  // The expiry only. The reminder's copy and the WhatsApp template both
  // describe recording answers in your own time; neither is sent for a live
  // interview until it has its own.
  await scheduleInterviewJobs({
    sessionId,
    companyId: ctx.companyId,
    expiresAt: dates.expiresAt,
    expiresAtMs: dates.expiresAtMs,
    deadline: delivered.deadline,
    reminder: false,
  });

  revalidatePath("/ai-dashboard/applicants");
  revalidatePath("/ai-dashboard/messages");
  return { success: true, data: { expiresAt: dates.expiresAt } };
}

// ── Shared by both send paths ────────────────────────────────
//
// None of these is exported: a "use server" module compiles every export into
// a server action, and each of these assumes the caller has already resolved
// the company context.

type Service = ReturnType<typeof createServiceClient>;
type CompanyCtx = Awaited<ReturnType<typeof getCompanyContext>>;

type InviteApplication = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  job_id: string | null;
  job_title_snapshot: string | null;
  jobs?: { title: string | null } | null;
};

const NO_QUESTIONS = "Add interview questions to this job first — there's nothing to ask yet.";

/**
 * The application, re-fetched and checked: company, then hiring team, then an
 * address to send to, then a job to ask about. In that order, with those
 * messages — both send paths refuse identically.
 */
async function loadInviteTarget(
  service: Service,
  ctx: CompanyCtx,
  applicationId: string,
): Promise<{ ok: true; app: InviteApplication; jobId: string } | { ok: false; error: string }> {
  const { data: appData } = await service
    .from("job_applications")
    .select(
      "id, first_name, last_name, email, job_id, job_title_snapshot, jobs(title), company_id_snapshot",
    )
    .eq("id", applicationId)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();

  const app = appData as unknown as InviteApplication | null;

  if (!app) return { ok: false, error: NOT_YOURS };
  if (!(await canAccessJob(ctx, app.job_id ?? ""))) {
    return { ok: false, error: NOT_YOURS };
  }

  const to = (app.email ?? "").trim().toLowerCase();
  if (!to) {
    return { ok: false, error: "This applicant has no email address." };
  }
  if (!app.job_id) {
    return {
      ok: false,
      error: "This application isn't attached to a job, so there's nothing to ask.",
    };
  }
  return { ok: true, app, jobId: app.job_id };
}

/**
 * Read the questions ONCE and return them for freezing onto the session.
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
async function loadQuestionsSnapshot(service: Service, jobId: string, companyId: string) {
  const { data: questionRows } = await service
    .from("interview_questions")
    .select("id, position, question, prep_seconds, answer_seconds, required")
    .eq("job_id", jobId)
    .eq("company_id", companyId)
    .order("position", { ascending: true })
    .limit(50);

  return (questionRows ?? []) as {
    id: string;
    position: number;
    question: string | null;
    prep_seconds: number | null;
    answer_seconds: number | null;
    required: boolean | null;
  }[];
}

/**
 * One open session per (application, KIND). Re-sending supersedes rather than
 * accumulating: two live links for one candidate means two half-finished
 * interviews and no way to say which is theirs.
 *
 * Per kind because a job may run both options, and without the filter an AI
 * Video Interview invite for a shortlisted candidate would cancel the async
 * interview they had already been sent — or the reverse.
 *
 * A SUBMITTED session is never superseded — submitted is final, and the
 * caller is told so rather than silently issuing a link that would let
 * someone re-record answers already with the hiring team.
 */
async function supersedeOpenSession(
  service: Service,
  input: {
    applicationId: string;
    companyId: string;
    kind: InterviewKind;
    submittedError: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: existingData } = await service
    .from("interview_sessions")
    .select("id, status, submitted_at")
    .eq("application_id", input.applicationId)
    .eq("company_id", input.companyId)
    .eq("kind", input.kind)
    .in("status", ["invited", "started", "submitted"])
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = ((existingData ?? []) as {
    id: string;
    status: string;
    submitted_at: string | null;
  }[])[0];

  if (existing?.status === "submitted") {
    return { ok: false, error: input.submittedError };
  }

  if (existing) {
    await service
      .from("interview_sessions")
      .update({ status: "cancelled" })
      .eq("id", existing.id)
      .eq("company_id", input.companyId);
  }
  return { ok: true };
}

/** The link's deadline and the retention date, both from one `now`. */
function inviteDates(): { expiresAt: string; expiresAtMs: number; deleteAfter: string } {
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_EXPIRY_DAYS * DAY_MS).toISOString();
  const deleteAfter = new Date(
    new Date(now).setMonth(new Date(now).getMonth() + RETENTION_MONTHS),
  ).toISOString();
  return { expiresAt, expiresAtMs: now + SESSION_EXPIRY_DAYS * DAY_MS, deleteAfter };
}

/**
 * Email the invitation, and cancel the session if it cannot be delivered.
 *
 * The invite goes out through the SAME path as every other candidate email —
 * renderCopy for substitution, buildCandidateHtml for the shell and the
 * unsubscribe footer, deliverEmail for sender identity, reply-to, the daily
 * cap and the log-before-send row. Nothing here talks to Resend directly.
 *
 * Event 'interview' rather than 'manual': it IS the lifecycle event, so it
 * lands in the Messages page's Automatic tab and shares the idempotency and
 * opt-out semantics of the rest of the lifecycle.
 *
 * Returns the deadline exactly as the email rendered it, so every later
 * message about this session can quote the same wording.
 */
async function deliverInvite(
  service: Service,
  input: {
    ctx: CompanyCtx;
    applicationId: string;
    app: InviteApplication;
    sessionId: string;
    rawToken: string;
    expiresAt: string;
    copy: (link: string, deadline: string) => { subject: string; body: string };
  },
): Promise<{ ok: true; deadline: string } | { ok: false; error: string }> {
  const { ctx, app } = input;
  const to = (app.email ?? "").trim().toLowerCase();
  const jobTitle =
    (app.jobs?.title ?? "").trim() || (app.job_title_snapshot ?? "").trim() || "the role";

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

  const values = buildPlaceholders({
    firstName: app.first_name,
    lastName: app.last_name,
    jobTitle,
    companyName,
  });

  const link = interviewUrl(input.rawToken);
  const deadline = new Date(input.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

  const rendered = renderCopy(input.copy(link, deadline), values);

  const html = buildCandidateHtml(rendered.body, companyName, ctx.companyId, to);

  const outcome = await deliverEmail(service, {
    companyId: ctx.companyId,
    applicationId: input.applicationId,
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
      .eq("id", input.sessionId);
    return { ok: false, error: outcome.message };
  }
  return { ok: true, deadline };
}

/**
 * Queue the reminder and the expiry for one freshly sent session.
 *
 * Not exported — a "use server" module compiles every export into a server
 * action, and scheduling background work is not something a browser may ask
 * for. Callable only from the two send actions, which have already done the
 * company and hiring-team checks.
 *
 * `reminder` is explicit, not defaulted: the reminder's copy describes an
 * async interview, so the live send passes false and the async send true.
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
  reminder: boolean;
}): Promise<void> {
  const { sessionId, companyId, expiresAt, expiresAtMs, deadline } = input;

  try {
    const reminderAtMs = expiresAtMs - REMINDER_LEAD_MS;
    if (input.reminder && reminderAtMs <= Date.now()) {
      console.log(
        `[interview] no reminder for session ${sessionId} — the window is shorter than the ${
          REMINDER_LEAD_MS / (60 * 60 * 1000)
        }h reminder lead`,
      );
    } else if (input.reminder) {
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
 * The drawer's read of the job's interview switches: both options in one query.
 *
 * Separate from readJobInterviewSettings, which the async SEND uses and which
 * is left exactly as it was. Advisory only — each send re-reads its own switch
 * server-side, and the live send goes through gateLiveInterviewInvite.
 *
 * `=== true` for both: each column defaults to FALSE, so null means off.
 */
async function readJobPanelSettings(
  service: ReturnType<typeof createServiceClient>,
  jobId: string,
): Promise<{ asyncEnabled: boolean; liveEnabled: boolean }> {
  const { data } = await service
    .from("jobs")
    .select("async_interview_enabled, avatar_interview_enabled")
    .eq("id", jobId)
    .maybeSingle();
  const row = data as {
    async_interview_enabled: boolean | null;
    avatar_interview_enabled: boolean | null;
  } | null;
  return {
    asyncEnabled: row?.async_interview_enabled === true,
    liveEnabled: row?.avatar_interview_enabled === true,
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
  /**
   * Required, not defaulted. The drawer's panel IS the async panel today and
   * passes "async"; a live panel passes "live". A default here would be the
   * one place a caller could forget the kind and still get an answer — the
   * wrong session, for a job running both options.
   */
  kind: InterviewKind,
): Promise<InterviewPanelState> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  /** Nothing to show and nothing to offer — the guard cases all land here. */
  const NOTHING: InterviewPanelState = {
    session: null,
    asyncEnabled: false,
    liveEnabled: false,
    liveAvailable: false,
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
  const switches = app.job_id
    ? await readJobPanelSettings(service, app.job_id)
    : { asyncEnabled: false, liveEnabled: false };
  const base = {
    asyncEnabled: switches.asyncEnabled,
    liveEnabled: switches.liveEnabled,
    // The same allowlist the gate checks first. Empty in production, so the
    // drawer never offers the live send there.
    liveAvailable: liveInterviewsAvailableFor(ctx.companyId),
    jobId: app.job_id,
  };

  const { data } = await service
    .from("interview_sessions")
    .select(
      "id, kind, status, expires_at, submitted_at, started_at, invited_by_name, created_at, questions_snapshot",
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    // The newest session OF THIS KIND. Without the filter a job running both
    // options would show whichever invite went out last, under the wrong
    // heading.
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(1);

  const row = ((data ?? []) as {
    id: string;
    kind: string;
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
    kind: readInterviewKind(row.kind, row.id),
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
