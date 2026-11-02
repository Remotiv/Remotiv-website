import "server-only";
import { randomUUID } from "node:crypto";
import { mintSessionToken } from "@/lib/interviews/tokens";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Restarting an AI Video Interview's first attempt (F10 C3): the decision, the
 * restart link and its deadline. Server side only; the C5 screen calls these.
 *
 *   restartEligibility     whether a first attempt can be decided, as 053's
 *                          trigger decides it, with a code for each refusal
 *   decideLiveRestart      restart or no restart, by a company Owner or Admin,
 *                          with a note. No restart is one action row. Restart
 *                          is live_restart_session: attempt 1 abandoned,
 *                          attempt 2 created from its frozen copy, invited
 *   reissueRestartLink     a new link for the same attempt 2, still invited
 *                          (an email that failed): never a new session
 *   extendRestartDeadline  at least 72 hours from now, once an email is delivered
 *
 * ── The database is the final judge ──────────────────────────
 *
 * Migration 053 (applied 31 Oct 2026) enforces every rule here again. These
 * functions check first so the screen gets a clear code, and map what the
 * database refuses to the same codes; its messages never reach the caller.
 *
 * ── Who ──────────────────────────────────────────────────────
 *
 * A company Owner or Admin, for their own company's sessions. A Remotiv super
 * admin acts on nothing here (F4), nor does a recruiter or hiring manager. The
 * caller gates the session to the viewer's company and hiring team first
 * (live-review.ts); every read here is scoped to the actor's company again.
 *
 * ── What is never logged ─────────────────────────────────────
 *
 * Tokens (raw or hashed), notes and anything about the candidate. Ids, roles
 * and codes only. The raw token is returned once, for the email, and nowhere
 * else.
 */

type Service = ReturnType<typeof createServiceClient>;

const HOUR_MS = 60 * 60 * 1000;
const RESTART_DEADLINE_MS = 72 * HOUR_MS;
const NOTE_MAX = 2000;
const RESTARTABLE_OUTCOMES = ["ending_unconfirmed", "technical_failure", "abandoned"];

export type RestartIneligibleCode =
  | "not_live"
  | "not_first_attempt"
  | "not_started"
  | "not_ended"
  | "too_soon"
  | "not_final"
  | "not_eligible_outcome"
  | "already_decided";

export type LiveRestartErrorCode =
  | RestartIneligibleCode
  | "role_not_allowed"
  | "bad_input"
  | "bad_note"
  | "not_found"
  | "past_retention"
  | "not_eligible"
  | "not_restart"
  | "not_invited"
  | "expired"
  | "not_extendable"
  | "db_error";

export type Refused = { ok: false; code: LiveRestartErrorCode };

/** The first attempt as 053's decision trigger reads it, and whether it is decided already. */
export type RestartSession = {
  kind: string | null;
  attempt: number | null;
  status: string;
  live_ended_at: string | null;
  live_outcome: { final?: unknown; outcome?: unknown } | null;
  decided: boolean;
};

/** A company member acting. memberId is company_members' id, as invited_by takes it. */
export type RestartActor = {
  userId: string;
  memberId: string | null;
  name: string | null;
  role: string;
  companyId: string;
};

/** A jsonb value as `->>` reads it: strings as they are, anything else as JSON text. */
function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Whether a first attempt can be decided, in 053's order: a live first
 * attempt, started, with a verified end; then a final restartable outcome, or
 * no export and an end at least an hour old; then not decided already. An
 * abandoned attempt is one already restarted.
 */
export function restartEligibility(
  session: RestartSession,
  nowMs: number,
): { eligible: true } | { eligible: false; code: RestartIneligibleCode } {
  const no = (code: RestartIneligibleCode) => ({ eligible: false as const, code });
  if (session.kind !== "live") return no("not_live");
  if (session.attempt !== 1) return no("not_first_attempt");
  if (session.status === "abandoned") return no("already_decided");
  if (session.status !== "started") return no("not_started");
  if (!session.live_ended_at) return no("not_ended");
  const outcome = session.live_outcome;
  if (outcome === null) {
    if (Date.parse(session.live_ended_at) > nowMs - HOUR_MS) return no("too_soon");
  } else if (jsonText(outcome.final) !== "true") {
    return no("not_final");
  } else if (!RESTARTABLE_OUTCOMES.includes(jsonText(outcome.outcome) ?? "")) {
    return no("not_eligible_outcome");
  }
  if (session.decided) return no("already_decided");
  return { eligible: true };
}

function actorAllowed(actor: RestartActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

/** A database refusal as a code: never its message. */
function refusal(
  error: { code?: string } | null,
  check: LiveRestartErrorCode = "not_eligible",
): LiveRestartErrorCode {
  if (error?.code === "23514") return check;
  if (error?.code === "23505") return "already_decided";
  if (error?.code === "P0002") return "not_found";
  return "db_error";
}

function refused(
  sessionId: string,
  step: string,
  code: LiveRestartErrorCode,
  dbCode?: string,
): Refused {
  console.warn(
    `[live-restart] session ${sessionId}: ${step} refused (${code}${dbCode ? `, db ${dbCode}` : ""})`,
  );
  return { ok: false, code };
}

type FirstAttemptRow = {
  id: string;
  company_id: string;
  kind: string | null;
  attempt: number | null;
  status: string;
  live_ended_at: string | null;
  live_outcome: RestartSession["live_outcome"];
  expires_at: string | null;
  delete_after: string | null;
};

async function readFirstAttempt(
  service: Service,
  sessionId: string,
  companyId: string,
): Promise<{ row: FirstAttemptRow; decided: boolean } | LiveRestartErrorCode> {
  const { data, error } = await service
    .from("interview_sessions")
    .select(
      "id, company_id, kind, attempt, status, live_ended_at, live_outcome, expires_at, delete_after",
    )
    .eq("id", sessionId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return "db_error";
  if (!data) return "not_found";
  const { data: decisions, error: dErr } = await service
    .from("live_interview_actions")
    .select("id")
    .eq("session_id", sessionId)
    .eq("action", "decide_restart")
    .limit(1);
  if (dErr) return "db_error";
  return { row: data as FirstAttemptRow, decided: ((decisions ?? []) as unknown[]).length > 0 };
}

/** live_restart_session's deadline: greatest(attempt 1's, now + 72 hours). */
function restartDeadlineMs(expiresAt: string | null, nowMs: number): number {
  const floor = nowMs + RESTART_DEADLINE_MS;
  return expiresAt ? Math.max(Date.parse(expiresAt), floor) : floor;
}

export type DecideResult =
  | { ok: true; decision: "no_restart" }
  | { ok: true; decision: "restart"; newSessionId: string; token: string; deadline: string }
  | Refused;

/**
 * Restart or no restart, decided once. Role and note are checked before
 * anything is read; eligibility before anything is written. `token` is the new
 * link's raw token, for the email only: only its hash is stored.
 */
export async function decideLiveRestart(input: {
  service: Service;
  sessionId: string;
  actor: RestartActor;
  decision: "restart" | "no_restart";
  note: string;
  now?: () => number;
}): Promise<DecideResult> {
  const { service, sessionId, actor, decision } = input;
  if (!actorAllowed(actor)) return refused(sessionId, "decision", "role_not_allowed");
  if (decision !== "restart" && decision !== "no_restart") {
    return refused(sessionId, "decision", "bad_input");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length < 1 || note.length > NOTE_MAX) return refused(sessionId, "decision", "bad_note");

  const nowMs = (input.now ?? Date.now)();
  const read = await readFirstAttempt(service, sessionId, actor.companyId);
  if (typeof read === "string") return refused(sessionId, "decision", read);
  const { row, decided } = read;
  const verdict = restartEligibility({ ...row, decided }, nowMs);
  if (!verdict.eligible) return refused(sessionId, "decision", verdict.code);

  if (decision === "no_restart") {
    const { error } = await service.from("live_interview_actions").insert({
      session_id: row.id,
      company_id: row.company_id,
      action: "decide_restart",
      decision: "no_restart",
      note,
      actor_user_id: actor.userId,
      actor_name: actor.name,
      actor_role: actor.role,
    });
    if (error) return refused(sessionId, "decision", refusal(error), error.code);
    console.log(`[live-restart] session ${row.id}: no_restart by ${actor.role} ${actor.userId}`);
    return { ok: true, decision: "no_restart" };
  }

  // The retention date stays the original invite's: a restart that would end after it is refused.
  if (
    row.delete_after &&
    restartDeadlineMs(row.expires_at, nowMs) >= Date.parse(row.delete_after)
  ) {
    return refused(sessionId, "decision", "past_retention");
  }
  const newSessionId = randomUUID();
  const { rawToken, tokenHash } = mintSessionToken();
  const { data, error } = await service.rpc("live_restart_session", {
    p_session_id: row.id,
    p_company_id: row.company_id,
    p_new_session_id: newSessionId,
    p_token_hash: tokenHash,
    p_note: note,
    p_actor_user_id: actor.userId,
    p_actor_name: actor.name,
    p_actor_role: actor.role,
    p_invited_by: actor.memberId,
    p_invited_by_name: actor.name,
  });
  if (error || typeof data !== "string") {
    return refused(sessionId, "restart", refusal(error), error?.code);
  }
  console.log(
    `[live-restart] session ${row.id}: restarted as ${newSessionId} by ${actor.role} ${actor.userId}`,
  );
  return { ok: true, decision: "restart", newSessionId, token: rawToken, deadline: data };
}

/**
 * A new link for the same restart, while it is still invited and before its
 * deadline: the old link stops working, no session is created, and the
 * deadline is not touched (extendRestartDeadline does that once the email is
 * delivered). Past the deadline it is `expired`, even before the expiry job
 * has marked it so.
 *
 * The deadline is in the UPDATE's own filter, so one passing between the read
 * and the write cannot slip through. It is compared on this server's clock,
 * not the database's: a database-clock comparison needs a function, which
 * needs a migration. So at the exact deadline, clock skew between this server
 * and the database can still re-issue a link the database would call just
 * expired, or refuse one just before; the candidate's own start check decides
 * on the day.
 *
 * Logged as a server log line, ids and role only: no table takes a re-issue
 * without a migration (live_session_events' kinds are the browser's reports,
 * live_interview_actions' actions are decisions). The email that carries the
 * link is logged where every candidate email is (communication_logs).
 */
export async function reissueRestartLink(input: {
  service: Service;
  restartSessionId: string;
  actor: RestartActor;
  now?: () => number;
}): Promise<{ ok: true; sessionId: string; token: string } | Refused> {
  const { service, restartSessionId: id, actor } = input;
  if (!actorAllowed(actor)) return refused(id, "re-issue", "role_not_allowed");
  const clock = input.now ?? Date.now;
  const read = await readRestart(service, id, actor.companyId);
  if (typeof read === "string") return refused(id, "re-issue", read);
  if (read.kind !== "live" || read.attempt !== 2) return refused(id, "re-issue", "not_restart");
  const before = restartLinkState(read, clock());
  if (before) return refused(id, "re-issue", before);

  const { rawToken, tokenHash } = mintSessionToken();
  const { data: landed, error: uErr } = await service
    .from("interview_sessions")
    .update({ token_hash: tokenHash })
    .eq("id", id)
    .eq("company_id", actor.companyId)
    .eq("kind", "live")
    .eq("attempt", 2)
    .eq("status", "invited")
    // The clock read again at the write, not the read's.
    .gt("expires_at", new Date(clock()).toISOString())
    .select("id");
  if (uErr) return refused(id, "re-issue", refusal(uErr, "not_invited"), uErr.code);
  // Started, ended or past its deadline since the read: the link it was sent stays.
  if (((landed ?? []) as unknown[]).length === 0) {
    const now = await readRestart(service, id, actor.companyId);
    const code = typeof now === "string" ? now : restartLinkState(now, clock());
    return refused(id, "re-issue", code ?? "not_invited");
  }
  console.log(`[live-restart] restart ${id}: link re-issued by ${actor.role} ${actor.userId}`);
  return { ok: true, sessionId: id, token: rawToken };
}

type RestartRow = {
  id: string;
  kind: string | null;
  attempt: number | null;
  status: string;
  expires_at: string | null;
};

async function readRestart(
  service: Service,
  id: string,
  companyId: string,
): Promise<RestartRow | LiveRestartErrorCode> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("id, kind, attempt, status, expires_at")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return "db_error";
  return (data as RestartRow | null) ?? "not_found";
}

/** Why a restart's link cannot be re-issued now, or null when it can. */
function restartLinkState(row: RestartRow, nowMs: number): LiveRestartErrorCode | null {
  if (row.status !== "invited") return "not_invited";
  if (!row.expires_at || Date.parse(row.expires_at) <= nowMs) return "expired";
  return null;
}

/**
 * At least 72 hours from now for an invited restart, never shorter. Called only
 * after its email was delivered (the first send or a re-send).
 */
export async function extendRestartDeadline(input: {
  service: Service;
  restartSessionId: string;
  companyId: string;
}): Promise<{ ok: true; deadline: string } | Refused> {
  const { service, restartSessionId: id, companyId } = input;
  const { data, error } = await service.rpc("live_restart_extend_deadline", {
    p_session_id: id,
    p_company_id: companyId,
  });
  if (error || typeof data !== "string") {
    return refused(id, "deadline", refusal(error, "not_extendable"), error?.code);
  }
  console.log(`[live-restart] restart ${id}: deadline extended`);
  return { ok: true, deadline: data };
}
