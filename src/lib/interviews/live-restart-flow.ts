import "server-only";
import type { CompanyContext } from "@/app/ai-dashboard/lib/company-roles";
import { escapeHtml } from "@/lib/email/candidate/render";
import {
  type InviteApplication,
  scheduleInterviewJobs,
  sendInviteEmail,
} from "@/lib/interviews/invite-delivery";
import {
  decideLiveRestart,
  extendRestartDeadline,
  type LiveRestartErrorCode,
  type RestartActor,
  reissueRestartLink,
} from "@/lib/interviews/live-restart";
import {
  canActOnLiveReview,
  gateLiveSession,
  type LiveReviewDeps,
} from "@/lib/interviews/live-review";
import type {
  LiveRestartCode,
  LiveRestartDecideResult,
  LiveRestartResendResult,
  LiveRestartSend,
  LiveRestartWarning,
} from "@/lib/interviews/live-review-types";
import { countingLiveScore } from "@/lib/interviews/live-scoring";
import { JOB_TYPES } from "@/lib/jobs-queue";

/**
 * The restart decision on the live review page, and its link (F10 C5). The
 * server actions in interviews/live-actions.ts are thin; every rule is here.
 *
 *   decideRestart     restart or no restart on the latest attempt, a first one
 *   resendRestartLink a new link for the same attempt 2, while it is invited
 *
 * ── The gates, in order, before anything is written ──────────
 *
 * The session through the review page's own gate (company, then hiring team),
 * then the role (owner or admin), then the latest attempt. live-restart.ts and
 * migration 053 check everything again.
 *
 * ── Sending the link: the email quotes only the database's deadline ──
 *
 * The first send quotes attempt 2's deadline as live_restart_session returned
 * it (at least 72 hours from the restart). A re-send first extends the
 * deadline in the database (live_restart_extend_deadline: at least 72 hours
 * from now) and quotes what it returns; only then is the token replaced. If
 * that extension fails, nothing is sent and the old link keeps working.
 *
 * Once an email is delivered the deadline is extended again, for 72 hours
 * after delivery, and the expiry scheduled at the database's deadline. If that
 * second extension fails, the quoted deadline still stands (the database
 * holds it), but it may be slightly less than 72 hours after the actual
 * delivery: the result says not_extended_after_delivery and never claims the
 * 72 hours were kept.
 *
 * A failed email cancels nothing, extends nothing and schedules nothing:
 * attempt 2 stays invited and its link can be sent again (F10 decision 6).
 *
 * ── The link's record (F10-LOG, migration 055) ───────────────
 *
 * Each step that happened leaves one row in live_restart_link_events, written
 * with the gated actor (ctx.user.id, ctx.role, after gateForAction), never
 * anything the request carries:
 *
 *   reissued  right after a re-send replaced the token, before its email
 *   sent      right after the email provider accepted the email
 *   failed    right after it did not
 *
 * The C5 order is unchanged; the rows sit between its steps. A row that cannot
 * be written undoes nothing and holds nothing back (the email may already have
 * gone): one line of ids and codes, and recordWarning on the result. The page
 * then has no record of this send and says delivery can't be confirmed.
 *
 * Accepted: if a re-send's 'reissued' row AND its 'sent' or 'failed' row both
 * fail to be written, the latest row is an earlier 'sent', and the page shows
 * that earlier acceptance although its link was replaced. Two failed writes in
 * one action; the action's own result carries the warning.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Tokens, notes, email addresses and names. Ids and codes only.
 */

const HOUR_MS = 60 * 60 * 1000;
const PROMISE_MS = 72 * HOUR_MS;

export type RestartFlowDeps = LiveReviewDeps & {
  now?: () => number;
  sendEmail?: typeof sendInviteEmail;
  schedule?: typeof scheduleInterviewJobs;
};

type Service = LiveReviewDeps["service"];

/** C3's codes as the page's codes: one per thing the person can do something about. */
const CODE: Partial<Record<LiveRestartErrorCode, LiveRestartCode>> = {
  too_soon: "too_soon",
  not_final: "not_final",
  not_eligible_outcome: "not_eligible_outcome",
  already_decided: "already_decided",
  role_not_allowed: "role_not_allowed",
  bad_note: "note_invalid",
  not_found: "not_found",
  past_retention: "past_retention",
  expired: "expired",
  not_invited: "not_invited",
  db_error: "db_error",
};

function refused(sessionId: string, step: string, code: LiveRestartCode) {
  console.warn(`[live-restart-flow] session ${sessionId}: ${step} refused (${code})`);
  return { ok: false as const, code };
}

function actorOf(ctx: CompanyContext): RestartActor {
  return {
    userId: ctx.user.id,
    memberId: ctx.memberId,
    name: ctx.memberName,
    role: ctx.role,
    companyId: ctx.companyId,
  };
}

/** The session, gated as the review page gates it, if this viewer may act on it now. */
async function gateForAction(
  ctx: CompanyContext,
  sessionId: string,
  step: string,
  deps: RestartFlowDeps,
) {
  const session = await gateLiveSession(ctx, sessionId, deps);
  if (!session) return refused(sessionId, step, "not_found");
  if (!canActOnLiveReview(ctx.role)) return refused(sessionId, step, "role_not_allowed");
  let latest: string | null;
  try {
    latest = (await countingLiveScore(deps.service, ctx.companyId, session.id))?.session_id ?? null;
  } catch {
    return refused(sessionId, step, "db_error");
  }
  if (latest !== session.id) return refused(sessionId, step, "not_latest");
  return { ok: true as const, session };
}

/** Restart or no restart, with a note. A restart then sends its link. */
export async function decideRestart(
  ctx: CompanyContext,
  request: { sessionId: string; decision: "restart" | "no_restart"; note: string },
  deps: RestartFlowDeps,
): Promise<LiveRestartDecideResult> {
  const gate = await gateForAction(ctx, request.sessionId, "decision", deps);
  if (!gate.ok) return gate;
  const decided = await decideLiveRestart({
    service: deps.service,
    sessionId: gate.session.id,
    actor: actorOf(ctx),
    decision: request.decision,
    note: request.note,
    now: deps.now,
  });
  if (!decided.ok) {
    return refused(gate.session.id, "decision", CODE[decided.code] ?? "not_eligible");
  }
  if (decided.decision === "no_restart") return { ok: true, decision: "no_restart" };
  // The deadline live_restart_session wrote: the database already holds it.
  const sent = await sendRestartLink(
    ctx,
    decided.newSessionId,
    decided.token,
    decided.deadline,
    deps,
  );
  return {
    ok: true,
    decision: "restart",
    restarted: true,
    restartSessionId: decided.newSessionId,
    ...sent,
  };
}

/**
 * A new link for the same attempt 2, still invited and before its deadline.
 * Never a new session.
 *
 * The deadline is extended in the database first, and the email quotes what
 * it returns; if that fails nothing is sent and the token is not replaced.
 *
 * Accepted: the new token replaces the old one before its email is confirmed,
 * so if this email fails, the link sent earlier no longer works either; the
 * next re-send is the way back (the page always offers it while invited).
 */
export async function resendRestartLink(
  ctx: CompanyContext,
  restartSessionId: string,
  deps: RestartFlowDeps,
): Promise<LiveRestartResendResult> {
  const gate = await gateForAction(ctx, restartSessionId, "re-send", deps);
  if (!gate.ok) return gate;
  const { session } = gate;
  if (session.attempt !== 2) return refused(session.id, "re-send", "not_eligible");
  if (session.status !== "invited") return refused(session.id, "re-send", "not_invited");
  const nowMs = (deps.now ?? Date.now)();
  // Refused before the old link stops working: nothing changes for a link that cannot be sent.
  if (!session.expires_at || Date.parse(session.expires_at) <= nowMs) {
    return refused(session.id, "re-send", "expired");
  }
  if (pastRetention(session.expires_at, session.delete_after, nowMs)) {
    return refused(session.id, "re-send", "past_retention");
  }
  const ahead = await extendRestartDeadline({
    service: deps.service,
    restartSessionId: session.id,
    companyId: ctx.companyId,
  });
  if (!ahead.ok) return refused(session.id, "re-send", "deadline_not_extended");
  const reissued = await reissueRestartLink({
    service: deps.service,
    restartSessionId: session.id,
    actor: actorOf(ctx),
    now: deps.now,
  });
  if (!reissued.ok) {
    return refused(session.id, "re-send", CODE[reissued.code] ?? "not_eligible");
  }
  const recorded = await recordLinkEvent(deps.service, ctx, session.id, "reissued");
  const sent = await sendRestartLink(ctx, session.id, reissued.token, ahead.deadline, deps);
  return { ok: true, restartSessionId: session.id, ...sent, ...notRecorded(recorded) };
}

type LinkEvent = "reissued" | "sent" | "failed";

/**
 * One row of the restart's link record, as the gated actor. Never throws: a
 * row that cannot be written is one line of ids and codes, and false.
 */
async function recordLinkEvent(
  service: Service,
  ctx: CompanyContext,
  restartSessionId: string,
  event: LinkEvent,
): Promise<boolean> {
  try {
    const { error } = await service.from("live_restart_link_events").insert({
      session_id: restartSessionId,
      company_id: ctx.companyId,
      event,
      actor_user_id: ctx.user.id,
      actor_role: ctx.role,
    });
    if (!error) return true;
  } catch {
    // Reported below, as for an error the database returned.
  }
  console.warn(
    `[live-restart-flow] restart ${restartSessionId}: link event not recorded (${event})`,
  );
  return false;
}

function notRecorded(recorded: boolean) {
  return recorded ? {} : { recordWarning: "event_not_recorded" as const };
}

/** The deadline a re-send's extension sets: at least 72 hours from now, never earlier than it is. */
function promisedMs(expiresAt: string | null, nowMs: number): number {
  const floor = nowMs + PROMISE_MS;
  return expiresAt ? Math.max(Date.parse(expiresAt), floor) : floor;
}

function pastRetention(expiresAt: string | null, deleteAfter: string | null, nowMs: number) {
  return !!deleteAfter && promisedMs(expiresAt, nowMs) >= Date.parse(deleteAfter);
}

/**
 * Email the restart's link quoting `quoted`, a deadline the database already
 * holds; then, only once it is delivered, extend the deadline again and
 * schedule the expiry. Used by the first send and every re-send. Never
 * cancels the session.
 */
async function sendRestartLink(
  ctx: CompanyContext,
  restartSessionId: string,
  token: string,
  quoted: string,
  deps: RestartFlowDeps,
): Promise<LiveRestartSend> {
  const { service } = deps;
  const failed = (code: Extract<LiveRestartSend, { emailFailed: true }>["code"]) => {
    console.warn(`[live-restart-flow] restart ${restartSessionId}: link not sent (${code})`);
    return { emailFailed: true as const, code };
  };

  const { data: row, error } = await service
    .from("interview_sessions")
    .select("id, application_id")
    .eq("id", restartSessionId)
    .eq("company_id", ctx.companyId)
    .maybeSingle();
  if (error) return failed("db_error");
  const session = row as { id: string; application_id: string | null } | null;
  if (!session?.application_id) return failed("not_found");

  const { data: appData, error: appErr } = await service
    .from("job_applications")
    .select("id, first_name, last_name, email, job_id, job_title_snapshot, jobs(title)")
    .eq("id", session.application_id)
    .eq("company_id_snapshot", ctx.companyId)
    .maybeSingle();
  if (appErr) return failed("db_error");
  const app = appData as unknown as InviteApplication | null;
  if (!app) return failed("not_found");

  const sent = await (deps.sendEmail ?? sendInviteEmail)(service, {
    ctx: { companyId: ctx.companyId, memberName: ctx.memberName },
    applicationId: app.id,
    app,
    rawToken: token,
    expiresAt: quoted,
    copy: restartEmail,
  });
  const record = notRecorded(
    await recordLinkEvent(service, ctx, restartSessionId, sent.ok ? "sent" : "failed"),
  );
  if (!sent.ok) {
    console.warn(
      `[live-restart-flow] restart ${restartSessionId}: email not delivered (${sent.code})`,
    );
    return { ...failed("email_failed"), ...record };
  }

  // Delivered: 72 hours after delivery, in the database. It only ever moves later, so the
  // quoted deadline stays honoured whatever happens here.
  const deliveredAt = (deps.now ?? Date.now)();
  let deadline: string;
  let warning: LiveRestartWarning | null = null;
  const extended = await extendRestartDeadline({
    service,
    restartSessionId,
    companyId: ctx.companyId,
  });
  if (extended.ok) {
    deadline = extended.deadline;
  } else {
    // The quoted deadline stands; the expiry is still scheduled at the database's deadline.
    deadline = (await currentDeadline(service, ctx.companyId, restartSessionId)) ?? quoted;
    warning = "not_extended_after_delivery";
    const short = Math.max(0, Math.round((deliveredAt + PROMISE_MS - Date.parse(deadline)) / 1000));
    console.warn(
      `[live-restart-flow] restart ${restartSessionId}: extension after delivery failed; the emailed deadline stands, ${short}s short of 72 hours after delivery`,
    );
  }

  await scheduleExpiryOnce(service, ctx.companyId, restartSessionId, deadline, sent.deadline, deps);
  console.log(`[live-restart-flow] restart ${restartSessionId}: link sent`);
  return { emailFailed: false, deadline, warning, ...record };
}

/** The restart's deadline as the database holds it now, or null when it cannot be read. */
async function currentDeadline(
  service: Service,
  companyId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("expires_at")
    .eq("id", sessionId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return null;
  return (data as { expires_at: string | null } | null)?.expires_at ?? null;
}

/**
 * The expiry for this restart, once. scheduleInterviewJobs enqueues a fresh job
 * every call (no job id), so a re-send after a delivered link would add a
 * second one. When one is already queued or running it is kept: it fires at
 * the earlier deadline, finds the window still open and re-arms itself for
 * the deadline as the row states it then (expiry.ts, rescheduleExpiry).
 *
 * Accepted: two re-sends at the same instant can both find none and queue two.
 * Harmless: the expiry's update succeeds once (expireSession), and an early
 * job that re-arms first checks for another and converges to one.
 */
async function scheduleExpiryOnce(
  service: Service,
  companyId: string,
  sessionId: string,
  deadline: string,
  emailedDeadline: string,
  deps: RestartFlowDeps,
): Promise<void> {
  const { data: queued, error } = await service
    .from("background_jobs")
    .select("id")
    .eq("type", JOB_TYPES.INTERVIEW_EXPIRY)
    .in("status", ["queued", "running"])
    .contains("payload", { sessionId })
    .limit(1);
  if (!error && ((queued ?? []) as unknown[]).length > 0) {
    console.log(`[live-restart-flow] restart ${sessionId}: expiry already queued; it re-arms`);
    return;
  }
  await (deps.schedule ?? scheduleInterviewJobs)({
    sessionId,
    companyId,
    expiresAt: deadline,
    expiresAtMs: Date.parse(deadline),
    deadline: emailedDeadline,
    // The reminder's copy describes an async interview: never for a live one.
    reminder: false,
  });
}

/**
 * The restart email.
 * TODO-COPY: placeholder subject and body - Waleed writes the final copy.
 */
function restartEmail(link: string, deadline: string) {
  return {
    subject: "Your new AI Video Interview link for {{job_title}} at {{company_name}}",
    body: [
      "<p>Hi {{candidate_first_name}},</p>",
      "<p><strong>{{company_name}}</strong> would like you to take your AI Video Interview for <strong>{{job_title}}</strong> again. Your earlier link no longer works.</p>",
      `<p><a href="${escapeHtml(link)}" style="color:#7E47FF;font-weight:700">Start your interview</a></p>`,
      `<p>The link works until <strong>${escapeHtml(deadline)}</strong>. Have your camera and microphone ready.</p>`,
      "<p>Good luck.</p>",
    ].join("\n"),
  };
}
