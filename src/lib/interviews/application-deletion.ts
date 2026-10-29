import "server-only";
import { removeSessionObjects } from "@/lib/interviews/purge";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Delete one application's AI interviews (B7): every session of that
 * application in that company, async and live, every restart attempt, with
 * their recordings. Called by BOTH applicant deletions (the company's and the
 * super admin's) before the application row goes, so deleting an applicant
 * deletes their interviews, as the privacy page promises.
 *
 * ── Exactly this application ─────────────────────────────────
 *
 * Sessions are selected by application_id AND company_id, and every write is
 * filtered by both again. Never by email or name: another application of the
 * same person, or another company's, is never touched.
 *
 * ── Closed first ─────────────────────────────────────────────
 *
 * Before any file is touched, the sessions are closed with existing states
 * only: delete_after is set to now (retention over: the live video gate, the
 * transcription and scoring requests and the export save all refuse a session
 * past it), and an open session (invited, started) becomes cancelled, which
 * every candidate route already refuses. A terminal session keeps its status
 * (an abandoned one may not change it, migration 020). Their queued
 * transcription and scoring jobs are marked failed, "session deleted".
 *
 * ── Files, then rows ─────────────────────────────────────────
 *
 * Each session's folder is emptied with the purge's own removeSessionObjects.
 * If any file is left, nothing else is deleted: the rows stay, so a retry
 * finds the same sessions and finishes the job. Only then are the sessions
 * deleted, in ONE statement (a restart points at its first attempt), and the
 * schema's cascades take their answers, turns, scores, review actions, page
 * events and video pieces. The access logs (signed_url_logs,
 * admin_access_logs) are not touched: ids only, kept by design (047). A file
 * that arrives late, from an upload URL signed before the close, is in a
 * folder no row references: the purge's orphan sweep removes it after its
 * 24-hour grace.
 *
 * Every step is safe to repeat.
 */

type Service = ReturnType<typeof createServiceClient>;

/** What the person deleting is told while a file is left; nothing else was deleted. */
export const FILES_LEFT = "Some files could not be deleted yet - try again.";
const NOT_DONE = "The interviews could not be deleted yet - try again.";
/** A queued job's last_error once its session is being deleted. */
export const SESSION_DELETED = "session deleted";

const OPEN_STATUSES = ["invited", "started"];

export type InterviewSessionRef = {
  id: string;
  kind: string;
  provider: string | null;
  provider_session_id: string | null;
};

export type ApplicationInterviewsDeps = {
  /**
   * B1/B6 HOOK, NOT WIRED: the interview provider's own copy of a live
   * session. When the provider adapter exists, delete it here
   * (provider.deleteSession(provider_session_id)) for each live session with
   * one. Nothing calls a provider today.
   */
  deleteProviderCopy?: (session: InterviewSessionRef) => Promise<void>;
  now?: () => number;
};

export type ApplicationInterviewsResult =
  | { ok: true; sessions: number }
  | { ok: false; error: string };

export async function deleteApplicationInterviews(
  service: Service,
  companyId: string,
  applicationId: string,
  deps: ApplicationInterviewsDeps = {},
): Promise<ApplicationInterviewsResult> {
  if (!companyId || !applicationId) return { ok: false, error: NOT_DONE };
  return deleteSessions(service, companyId, applicationId, deps);
}

/**
 * The same for a company's sessions that belong to no application (sent
 * before invites required one), for company deletion (company-deletion.ts).
 */
export async function deleteUnlinkedCompanyInterviews(
  service: Service,
  companyId: string,
  deps: ApplicationInterviewsDeps = {},
): Promise<ApplicationInterviewsResult> {
  if (!companyId) return { ok: false, error: NOT_DONE };
  return deleteSessions(service, companyId, null, deps);
}

/** The sessions of this application (or, for null, of no application) in this company. */
async function deleteSessions(
  service: Service,
  companyId: string,
  applicationId: string | null,
  deps: ApplicationInterviewsDeps,
): Promise<ApplicationInterviewsResult> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const whose =
    applicationId === null
      ? `company ${companyId} (no application)`
      : `application ${applicationId}`;

  const select = service
    .from("interview_sessions")
    .select("id, kind, provider, provider_session_id")
    .eq("company_id", companyId);
  const { data, error } = await (applicationId === null
    ? select.is("application_id", null)
    : select.eq("application_id", applicationId));
  if (error) return { ok: false, error: NOT_DONE };
  const sessions = (data ?? []) as InterviewSessionRef[];
  if (sessions.length === 0) return { ok: true, sessions: 0 };
  const ids = sessions.map((s) => s.id);

  // 1. Closed, with existing states only.
  const closed = await service
    .from("interview_sessions")
    .update({ delete_after: nowIso })
    .in("id", ids)
    .eq("company_id", companyId);
  if (closed.error) return { ok: false, error: NOT_DONE };
  const cancelled = await service
    .from("interview_sessions")
    .update({ status: "cancelled" })
    .in("id", ids)
    .eq("company_id", companyId)
    .in("status", OPEN_STATUSES);
  if (cancelled.error) return { ok: false, error: NOT_DONE };

  // 2. Their queued jobs, failed: by session (live turns, scorecards) and by answer (async).
  const { data: answers, error: aErr } = await service
    .from("interview_answers")
    .select("id")
    .in("session_id", ids);
  if (aErr) return { ok: false, error: NOT_DONE };
  const answerIds = ((answers ?? []) as { id: string }[]).map((a) => a.id);
  const failQueued = (type: string, key: string, values: string[]) =>
    service
      .from("background_jobs")
      .update({ status: "failed", last_error: SESSION_DELETED, updated_at: nowIso })
      .eq("type", type)
      .eq("status", "queued")
      .in(`payload->>${key}`, values);
  for (const [type, key, values] of [
    ["transcribe", "sessionId", ids],
    ["transcribe", "answerId", answerIds],
    ["ai_scorecard", "sessionId", ids],
  ] as const) {
    if (values.length === 0) continue;
    const { error: jErr } = await failQueued(type, key, values);
    if (jErr) return { ok: false, error: NOT_DONE };
  }

  // 3. B1/B6: the provider's copy of each live session (no provider call today).
  if (deps.deleteProviderCopy) {
    for (const s of sessions) {
      if (s.kind === "live" && s.provider_session_id) await deps.deleteProviderCopy(s);
    }
  }

  // 4. Every file, or nothing else.
  let left = 0;
  for (const id of ids) {
    try {
      if (!(await removeSessionObjects(service, id)).complete) left += 1;
    } catch {
      left += 1;
    }
  }
  if (left > 0) {
    console.error(
      `[application-deletion] ${whose}: files left in ${left} session folder(s); rows kept for a retry`,
    );
    return { ok: false, error: FILES_LEFT };
  }

  // 5. The sessions, in one statement; the cascades take the rest.
  const { error: dErr } = await service
    .from("interview_sessions")
    .delete()
    .in("id", ids)
    .eq("company_id", companyId);
  if (dErr) return { ok: false, error: NOT_DONE };
  console.log(`[application-deletion] ${whose}: ${ids.length} interview session(s) deleted`);
  return { ok: true, sessions: ids.length };
}
