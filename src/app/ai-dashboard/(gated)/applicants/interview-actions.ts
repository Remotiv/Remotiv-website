"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  consumeInterviewAllowance,
  INTERVIEW_ALLOWANCE_UNAVAILABLE,
  type InterviewReservation,
  interviewLimitMessage,
  releaseInterviewAllowance,
} from "@/lib/interview-allowance";
import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import { escapeHtml } from "@/lib/email/candidate/render";
import { enqueue, JOB_TYPES } from "@/lib/jobs-queue";
import {
  deliverInvite,
  type InviteApplication,
  scheduleInterviewJobs,
} from "@/lib/interviews/invite-delivery";
import { liveInterviewsAvailableFor } from "@/lib/interviews/live-availability";
import { type LiveCallFields, liveCallBegan } from "@/lib/interviews/live-call";
import { restartEligibility } from "@/lib/interviews/live-restart";
import { gateLiveInterviewInvite } from "@/lib/interviews/live-settings";
import { mintSessionToken, RETENTION_MONTHS, SESSION_EXPIRY_DAYS } from "@/lib/interviews/tokens";
import { type InterviewKind, readInterviewKind } from "@/lib/interviews/types";
import type {
  InterviewPanelState,
  InterviewSessionSummary,
  LiveRestartStatus,
} from "./interview-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./interview-types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string; code?: "live_call_started" | "live_restarted" };

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
 * application guards, the question snapshot, the supersede rule, the dates —
 * and the same email delivery and scheduling (lib/interviews/invite-delivery),
 * so a fix to one reaches the other.
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
  const scoringSnapshot = await loadScoringSnapshot(service, jobId, ctx.companyId);
  // No questions, no interview. Sending a link to an empty interview wastes
  // the candidate's time and looks broken from their side.
  if (questionsSnapshot.length === 0) {
    return { success: false, error: NO_QUESTIONS };
  }

  /*
   * ── The monthly allowance, reserved before anything is created or sent ──
   *
   * One interview_sent credit per invitation, re-sends included. The session id
   * is minted here so the same UUID is the credit's reference and the row's id:
   * every credit points at exactly one session, and no two attempts share one.
   *
   * Reserved BEFORE the supersede, so a refused re-send leaves the candidate's
   * current link open rather than cancelling it and sending nothing.
   *
   * Refused means nothing happens: no session, no email, no retry. No decision
   * means the same, with a different message. Internal companies, companies
   * with no plan and plans with no interview limit are granted by the database.
   */
  const sessionId = randomUUID();
  let reservation: InterviewReservation;
  try {
    reservation = await consumeInterviewAllowance(service, ctx.companyId, sessionId);
  } catch {
    return { success: false, error: INTERVIEW_ALLOWANCE_UNAVAILABLE };
  }
  if (!reservation.allowed) {
    return { success: false, error: interviewLimitMessage(new Date()) };
  }

  /*
   * From here until the email provider accepts, every way out gives the same
   * credit back: a submitted interview, a failed insert, a refused or failed
   * email, or a throw. `accepted` is set the moment delivery succeeds, and after
   * that nothing releases, whatever fails later.
   */
  const { rawToken, tokenHash } = mintSessionToken();
  const dates = inviteDates();
  let accepted = false;
  let deadline: string;
  try {
    const superseded = await supersedeOpenSession(service, {
      applicationId,
      companyId: ctx.companyId,
      kind: "async",
      submittedError: "They've already submitted this interview. Answers can't be re-recorded.",
    });
    if (!superseded.ok) return { success: false, error: superseded.error };

    const { data: created, error: sessionErr } = await service
      .from("interview_sessions")
      .insert({
        // Supplied, not defaulted: the id the allowance credit already references.
        id: sessionId,
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
        // The marking scheme, frozen alongside the questions. Reviewer-only.
        scoring_snapshot: scoringSnapshot,
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
    accepted = true;
    deadline = delivered.deadline;
  } finally {
    if (!accepted) await releaseInterviewAllowance(service, reservation.usageId);
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

  /*
   * A restarted interview, or one whose restart was decided, is managed only
   * on its interview page (F10 C5): never cancelled, replaced or re-sent from
   * here. Refused before anything is written.
   */
  const restart = await liveRestartOf(service, applicationId, ctx.companyId);
  if (!restart.ok) return { success: false, error: SEND_FAILED };
  if (restart.latestSessionId) {
    return { ...LIVE_RESTARTED, error: restart.restarted ? RESTARTED_TEXT : DECIDED_TEXT };
  }

  const questionsSnapshot = await loadQuestionsSnapshot(service, jobId, ctx.companyId);
  const scoringSnapshot = await loadScoringSnapshot(service, jobId, ctx.companyId);
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
  if (!superseded.ok) {
    return { success: false, error: superseded.error, code: superseded.code };
  }

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
      // The marking scheme, frozen alongside the questions. Reviewer-only.
      scoring_snapshot: scoringSnapshot,
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
 * The marking scheme, frozen at invite - the half loadQuestionsSnapshot
 * deliberately leaves out.
 *
 * Written to interview_sessions.scoring_snapshot (migration 028), which no
 * candidate-facing read selects. The scorer marks every answer against this
 * and never against the live interview_questions rows, which a job save
 * deletes and reinserts; before this existed a reorder between invite and
 * scoring could grade an answer with a different question's rubric and weight
 * (Phase 4, AI-6). Positions match questions_snapshot's, which is how the
 * scorer joins the two halves.
 */
async function loadScoringSnapshot(service: Service, jobId: string, companyId: string) {
  const { data } = await service
    .from("interview_questions")
    .select("id, position, competency, rubric, weight")
    .eq("job_id", jobId)
    .eq("company_id", companyId)
    .order("position", { ascending: true })
    .limit(50);

  return ((data ?? []) as {
    id: string;
    position: number;
    competency: string | null;
    rubric: string | null;
    weight: number | null;
  }[]).map((q) => ({
    position: q.position,
    question_id: q.id,
    competency: (q.competency ?? "").trim() || null,
    rubric: (q.rubric ?? "").trim() || null,
    weight: typeof q.weight === "number" && q.weight > 0 ? q.weight : null,
  }));
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
 *
 * Nor is a live interview whose call has begun, finished, running or crashed
 * (liveCallBegan, F10 C1): nothing is cancelled and nothing is sent, and a
 * restart comes only through the restart decision. The cancel itself repeats
 * that check, so a candidate who joins between the read and the write is not
 * cancelled either. An async session, and a live invite nobody joined, are
 * superseded exactly as before.
 */
async function supersedeOpenSession(
  service: Service,
  input: {
    applicationId: string;
    companyId: string;
    kind: InterviewKind;
    submittedError: string;
  },
): Promise<{ ok: true } | { ok: false; error: string; code?: "live_call_started" }> {
  const { data: existingData } = await service
    .from("interview_sessions")
    .select("id, status, submitted_at, kind, started_at, provider_session_id, live_ended_at")
    .eq("application_id", input.applicationId)
    .eq("company_id", input.companyId)
    .eq("kind", input.kind)
    .in("status", ["invited", "started", "submitted"])
    .order("created_at", { ascending: false })
    .limit(1);

  const existing = ((existingData ?? []) as ({
    id: string;
    status: string;
    submitted_at: string | null;
  } & LiveCallFields)[])[0];

  if (existing?.status === "submitted") {
    return { ok: false, error: input.submittedError };
  }

  if (existing && input.kind === "live") {
    if (liveCallBegan(existing)) return LIVE_CALL_REFUSED;
    const { data: cancelled, error } = await service
      .from("interview_sessions")
      .update({ status: "cancelled" })
      .eq("id", existing.id)
      .eq("company_id", input.companyId)
      .eq("kind", "live")
      .is("provider_session_id", null)
      .is("started_at", null)
      .is("live_ended_at", null)
      // Never a restart, and never a first attempt that has one, in this update's own filter:
      // attempt is 1 or 2 (migration 020), and a first attempt gets a restart only once it is
      // 'abandoned', which is final (053). A row that changed since the read matches nothing.
      .neq("attempt", 2)
      .neq("status", "abandoned")
      .select("id");
    if (error) return { ok: false, error: SEND_FAILED };
    // Nothing cancelled: the candidate joined since the read, or the row changed. Either way, stop.
    if ((cancelled ?? []).length === 0) return LIVE_CALL_REFUSED;
    return { ok: true };
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

// TODO-COPY: placeholder - Waleed writes the final line.
const LIVE_CALL_REFUSED = {
  ok: false,
  error: "This AI Video Interview has already started, so a new link can't be sent.",
  code: "live_call_started",
} as const;

const SEND_FAILED = "Couldn't send - please try again.";

// TODO-COPY: placeholders - Waleed writes the final lines.
const RESTARTED_TEXT = "This interview was restarted - manage it from the interview page.";
const DECIDED_TEXT =
  "A restart decision was made for this interview - manage it from the interview page.";
const LIVE_RESTARTED = { success: false, code: "live_restarted" } as const;

/**
 * Whether this application's AI Video Interview was restarted, or its restart
 * decided (F10): the latest attempt to manage it from, or null, and whether a
 * restart exists (rather than only a decision on attempt 1). Company-scoped
 * at every read; a decision on another application's or company's session is
 * never found. ok:false when it could not be read: callers fail closed.
 */
async function liveRestartOf(
  service: Service,
  applicationId: string,
  companyId: string,
): Promise<{ ok: true; latestSessionId: string | null; restarted: boolean } | { ok: false }> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("id, attempt")
    .eq("application_id", applicationId)
    .eq("company_id", companyId)
    .eq("kind", "live");
  if (error) return { ok: false };
  const sessions = (data ?? []) as { id: string; attempt: number | null }[];
  const restart = sessions.find((s) => s.attempt === 2);
  if (restart) return { ok: true, latestSessionId: restart.id, restarted: true };
  if (sessions.length === 0) return { ok: true, latestSessionId: null, restarted: false };
  const { data: decided, error: dErr } = await service
    .from("live_interview_actions")
    .select("session_id")
    .eq("company_id", companyId)
    .eq("action", "decide_restart")
    .in(
      "session_id",
      sessions.map((s) => s.id),
    )
    .limit(1);
  if (dErr) return { ok: false };
  const row = ((decided ?? []) as { session_id: string }[])[0];
  return { ok: true, latestSessionId: row?.session_id ?? null, restarted: false };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Where this AI Video Interview's restart stands, read from its latest attempt
 * (F10 C6e), never a superseded first attempt. In this order: a restart
 * (attempt 2) first; then the stored decision on the first attempt, read as
 * recorded (a no_restart row), never inferred from a status; then whether the
 * first attempt can be decided, by live-restart.ts's own rule
 * (restartEligibility, migration 053); otherwise null, and the drawer shows the
 * interview as it always has. The decision's note is never read.
 *
 * Not shown, and left to the drawer's usual states: a restart that is
 * cancelled (only on its way to deletion) and a 'restart' decision with no
 * restart (the database creates both together, migration 053).
 */
async function liveRestartStatus(
  service: Service,
  companyId: string,
  subjectId: string,
  restart: { latestSessionId: string | null; restarted: boolean },
): Promise<LiveRestartStatus | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select(
      "id, kind, attempt, status, expires_at, started_at, provider_session_id, live_ended_at, live_outcome",
    )
    .eq("id", subjectId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error || !data) return null;
  const s = data as {
    kind: string | null;
    attempt: number | null;
    status: string;
    expires_at: string | null;
    started_at: string | null;
    provider_session_id: string | null;
    live_ended_at: string | null;
    live_outcome: { outcome?: unknown; final?: unknown } | null;
  };
  const nowMs = Date.now();

  if (restart.restarted) {
    if (s.live_ended_at || s.status === "submitted") {
      const final = s.live_outcome?.final === true && typeof s.live_outcome.outcome === "string";
      return {
        kind: "restart_finished",
        outcome: final ? (s.live_outcome?.outcome as string) : null,
      };
    }
    if (s.status === "started" || s.started_at || s.provider_session_id) {
      return { kind: "restart_in_progress" };
    }
    if (s.status === "invited" && s.expires_at && Date.parse(s.expires_at) > nowMs) {
      return { kind: "restart_sent", deadline: s.expires_at };
    }
    if (s.status === "invited" || s.status === "expired") return { kind: "restart_expired" };
    return null;
  }

  // The decision as recorded, when there is one: its value only, never its note.
  if (restart.latestSessionId) {
    const { data: decided, error: dErr } = await service
      .from("live_interview_actions")
      .select("decision")
      .eq("session_id", subjectId)
      .eq("company_id", companyId)
      .eq("action", "decide_restart")
      .limit(1);
    if (dErr) return null;
    const decision = ((decided ?? []) as { decision: string }[])[0]?.decision;
    return decision === "no_restart" ? { kind: "no_restart" } : null;
  }

  const verdict = restartEligibility(
    {
      kind: s.kind,
      attempt: s.attempt,
      status: s.status,
      live_ended_at: s.live_ended_at,
      live_outcome: s.live_outcome,
      decided: false,
    },
    nowMs,
  );
  if (verdict.eligible) return { kind: "decision_needed", availableAt: null };
  if (verdict.code === "too_soon" && s.live_ended_at) {
    return {
      kind: "decision_needed",
      availableAt: new Date(Date.parse(s.live_ended_at) + HOUR_MS).toISOString(),
    };
  }
  return null;
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
      "id, kind, status, expires_at, submitted_at, started_at, invited_by_name, created_at, questions_snapshot, job_id",
    )
    .eq("application_id", applicationId)
    .eq("company_id", ctx.companyId)
    // The newest session OF THIS KIND. Without the filter a job running both
    // options would show whichever invite went out last, under the wrong
    // heading.
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(1);

  const row = (
    (data ?? []) as {
      id: string;
      kind: string;
      status: string;
      expires_at: string;
      submitted_at: string | null;
      started_at: string | null;
      invited_by_name: string | null;
      created_at: string;
      questions_snapshot: unknown;
      job_id: string | null;
    }[]
  )[0];
  if (!row) return { ...base, session: null };

  // The interview score, if one exists. Company-gated on its own column.
  const { data: scoreRow } = await service
    .from("interview_session_scores")
    .select("status, overall_score, human_adjusted_score, verdict, summary")
    .eq("session_id", row.id)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  const sc = scoreRow as {
    status: string | null;
    overall_score: number | null;
    human_adjusted_score: number | null;
    verdict: string | null;
    summary: string | null;
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
    verdict: sc?.verdict ?? null,
    summary: sc?.summary ?? null,
  };
  if (kind === "live") {
    const restart = await liveRestartOf(service, applicationId, ctx.companyId);
    session.restart =
      restart.ok && restart.latestSessionId
        ? { latestSessionId: restart.latestSessionId, restarted: restart.restarted }
        : null;
    // The review page gates on the session's own job (live-review.ts gateLiveSession):
    // offer its link only where that gate opens. A restart keeps its first attempt's job.
    session.reviewable = row.job_id === app.job_id || (await canAccessJob(ctx, row.job_id ?? ""));
    // Set only when there is one, so an interview a restart has nothing to do with reads as before.
    const restartStatus = restart.ok
      ? await liveRestartStatus(service, ctx.companyId, restart.latestSessionId ?? row.id, restart)
      : null;
    if (restartStatus) session.restartStatus = restartStatus;
  }

  return { ...base, session };
}
