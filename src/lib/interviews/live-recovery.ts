import "server-only";
import type { LiveOutcome } from "@/lib/interviews/live-ingest";
import { type LiveScoreRow, scoreLiveSession } from "@/lib/interviews/live-scoring";
import { requestLiveTranscription, settleLiveOutcome } from "@/lib/interviews/live-transcribe";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * What a person can do about an AI Video Interview that cannot be scored as it
 * stands. Server side only; the review page (commit 8) calls these.
 *
 *   retryTranscription          a failed candidate turn: ask the current
 *                               transcription source for its transcript again
 *   resolveNeedsCheck           a suspect-timing question, checked against the
 *                               audio: 'score' makes it eligible, 'exclude'
 *                               leaves it out (never zero)
 *   resolveStyleCheck           a question whose rationale kept describing
 *                               speaking style: 'score' counts it, 'exclude'
 *                               leaves it out (never zero). Separate from the
 *                               timing check: neither ever clears the other.
 *   resolveFailedTranscription  a failed turn that will not come back:
 *                               'exclude' leaves its question out (never zero)
 *
 * ── Who ──────────────────────────────────────────────────────
 *
 * The company's owner or admin, for their own company's sessions, only.
 * Recruiters and hiring managers see the result and act on nothing. A Remotiv
 * super admin views any company's review read-only (F4, app/admin/interviews)
 * and acts on nothing: there is no platform caller. Anyone else is refused
 * before anything is read or written.
 *
 * ── Logged, then done, then worked out again ─────────────────
 *
 * Every action is first written to live_interview_actions (migration 042,
 * append-only): who, their role, the decision and a required note; the time is
 * the database's. Then the change is made, the outcome is settled again (an
 * excluded failed turn counts as resolved), and the scorer runs: it works out
 * eligibility, scores what is newly eligible and the overall. Each step is
 * safe to repeat, so an action interrupted after its log line is completed by
 * running the scorer again.
 *
 * ── Transcription source ─────────────────────────────────────
 *
 * retryTranscription does not know which service transcribes. It marks the
 * turn pending and asks `transcriptSource` for the session's pending turns;
 * the default is whatever the session's transcripts come from today
 * (requestLiveTranscription). Changing the source changes that default only.
 */

type Service = ReturnType<typeof createServiceClient>;

/** A company member. There is no platform caller: a super admin never acts (F4). */
export type RecoveryCaller = {
  kind: "company";
  userId: string;
  name: string | null;
  role: string;
  companyId: string;
};

export type RecoveryRole = "owner" | "admin";

export type LiveRecoveryErrorCode =
  | "forbidden"
  | "not_live"
  | "bad_input"
  | "not_failed"
  | "no_check"
  | "db_error";

export class LiveRecoveryError extends Error {
  readonly code: LiveRecoveryErrorCode;
  constructor(code: LiveRecoveryErrorCode, sessionId: string) {
    super(`live recovery: ${code} (session ${sessionId})`);
    this.name = "LiveRecoveryError";
    this.code = code;
  }
}

/** Asks for the transcripts of a session's pending candidate turns. Returns how many were asked for. */
export type TranscriptSource = (service: Service, sessionId: string) => Promise<number>;

const currentTranscriptSource: TranscriptSource = async (service, sessionId) => {
  const { enqueue } = await import("@/lib/jobs-queue");
  return requestLiveTranscription(service, sessionId, enqueue as never);
};

export type RecoveryDeps = {
  service: Service;
  caller: RecoveryCaller;
  transcriptSource?: TranscriptSource;
  /** Re-scores the session after the action. Defaults to scoreLiveSession. */
  score?: (sessionId: string) => Promise<LiveScoreRow | null>;
};

const NOTE_MAX = 2000;

/** The role an action is logged under, or null when the caller may not act on this company's session. */
export function recoveryRole(
  caller: RecoveryCaller,
  sessionCompanyId: string,
): RecoveryRole | null {
  // Anything that is not a company member of this company is refused, whatever it claims to be.
  if (caller.kind !== "company" || caller.companyId !== sessionCompanyId) return null;
  return caller.role === "owner" || caller.role === "admin" ? caller.role : null;
}

type SessionRow = {
  id: string;
  company_id: string;
  kind: string | null;
  live_outcome: LiveOutcome | null;
};
type TurnRow = {
  id: string;
  session_id: string;
  sequence: number;
  speaker: string;
  transcript_status: string | null;
};

async function authorised(
  deps: RecoveryDeps,
  sessionId: string,
  note: string,
): Promise<{ session: SessionRow; role: RecoveryRole; note: string }> {
  const { data, error } = await deps.service
    .from("interview_sessions")
    .select("id, company_id, kind, live_outcome")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new LiveRecoveryError("db_error", sessionId);
  const session = data as SessionRow | null;
  // A missing session and someone else's read the same: the caller learns nothing.
  const role = session ? recoveryRole(deps.caller, session.company_id) : null;
  if (!session || !role) throw new LiveRecoveryError("forbidden", sessionId);
  if (session.kind !== "live") throw new LiveRecoveryError("not_live", sessionId);
  const clean = typeof note === "string" ? note.trim() : "";
  if (clean.length < 1 || clean.length > NOTE_MAX)
    throw new LiveRecoveryError("bad_input", sessionId);
  return { session, role, note: clean };
}

async function failedCandidateTurn(
  deps: RecoveryDeps,
  sessionId: string,
  turnId: string,
): Promise<TurnRow> {
  const { data, error } = await deps.service
    .from("interview_turns")
    .select("id, session_id, sequence, speaker, transcript_status")
    .eq("id", turnId)
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) throw new LiveRecoveryError("db_error", sessionId);
  const turn = data as TurnRow | null;
  if (turn?.speaker !== "candidate") throw new LiveRecoveryError("bad_input", sessionId);
  if (turn.transcript_status !== "failed") throw new LiveRecoveryError("not_failed", sessionId);
  return turn;
}

async function log(
  deps: RecoveryDeps,
  session: SessionRow,
  role: RecoveryRole,
  entry: {
    action:
      | "retry_transcription"
      | "resolve_needs_check"
      | "resolve_repeat_check"
      | "resolve_wording_check"
      | "resolve_style_check"
      | "resolve_failed_transcription";
    decision: "retry" | "score" | "exclude";
    note: string;
    question_position?: number;
    turn?: TurnRow;
  },
): Promise<void> {
  const { error } = await deps.service.from("live_interview_actions").insert({
    session_id: session.id,
    company_id: session.company_id,
    action: entry.action,
    decision: entry.decision,
    question_position: entry.question_position ?? null,
    turn_id: entry.turn?.id ?? null,
    turn_sequence: entry.turn?.sequence ?? null,
    note: entry.note,
    actor_user_id: deps.caller.userId,
    actor_name: deps.caller.name,
    actor_role: role,
  });
  if (error) throw new LiveRecoveryError("db_error", session.id);
  console.log(
    `[live-recovery] session ${session.id}: ${entry.action} ${entry.decision} by ${role} ${deps.caller.userId}`,
  );
}

/** Settle again and re-score. The settle asks for nothing: the scorer runs right here. */
async function afterwards(deps: RecoveryDeps, sessionId: string): Promise<LiveScoreRow | null> {
  await settleLiveOutcome(deps.service, sessionId, { onDecided: async () => {} });
  const score = deps.score ?? ((id: string) => scoreLiveSession(id, { service: deps.service }));
  return score(sessionId);
}

/** A failed candidate turn: back to pending, and its transcript asked for again. */
export async function retryTranscription(
  input: { sessionId: string; turnId: string; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  const turn = await failedCandidateTurn(deps, session.id, input.turnId);
  await log(deps, session, role, { action: "retry_transcription", decision: "retry", note, turn });
  const { error } = await deps.service
    .from("interview_turns")
    .update({ transcript_status: "pending", transcript_error: null })
    .eq("id", turn.id)
    .eq("transcript_status", "failed");
  if (error) throw new LiveRecoveryError("db_error", session.id);
  const result = await afterwards(deps, session.id);
  await (deps.transcriptSource ?? currentTranscriptSource)(deps.service, session.id);
  return result;
}

/** A suspect-timing question, checked by a person: scored as usual, or left out. */
export async function resolveNeedsCheck(
  input: { sessionId: string; position: number; decision: "score" | "exclude"; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  if (input.decision !== "score" && input.decision !== "exclude") {
    throw new LiveRecoveryError("bad_input", session.id);
  }
  const q = session.live_outcome?.questions.find((x) => x.position === input.position);
  if (!q?.needs_check) throw new LiveRecoveryError("no_check", session.id);
  await log(deps, session, role, {
    action: "resolve_needs_check",
    decision: input.decision,
    note,
    question_position: input.position,
  });
  return afterwards(deps, session.id);
}

/**
 * A question held by a repeat check (a repeat not asked as agreed: an
 * unexpected phrase before it, or altered wording), checked against the
 * recording by a person: scored as usual, or left out. Only a question the
 * outcome flags can be resolved here, and the decision clears no other check.
 */
export async function resolveRepeatCheck(
  input: { sessionId: string; position: number; decision: "score" | "exclude"; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  if (input.decision !== "score" && input.decision !== "exclude") {
    throw new LiveRecoveryError("bad_input", session.id);
  }
  const q = session.live_outcome?.questions.find((x) => x.position === input.position);
  if ((q?.repeat_check ?? null) === null) throw new LiveRecoveryError("no_check", session.id);
  await log(deps, session, role, {
    action: "resolve_repeat_check",
    decision: input.decision,
    note,
    question_position: input.position,
  });
  return afterwards(deps, session.id);
}

/**
 * A question held by a wording check (its base question first asked other
 * than as frozen), checked against the recording by a person: scored as usual,
 * or left out. Only a question the outcome flags can be resolved here, and the
 * decision clears no other check.
 */
export async function resolveWordingCheck(
  input: { sessionId: string; position: number; decision: "score" | "exclude"; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  if (input.decision !== "score" && input.decision !== "exclude") {
    throw new LiveRecoveryError("bad_input", session.id);
  }
  const q = session.live_outcome?.questions.find((x) => x.position === input.position);
  if ((q?.wording_check ?? null) === null) throw new LiveRecoveryError("no_check", session.id);
  await log(deps, session, role, {
    action: "resolve_wording_check",
    decision: input.decision,
    note,
    question_position: input.position,
  });
  return afterwards(deps, session.id);
}

/**
 * A question held for a style check (its rationale kept describing speaking
 * style after a retry), read by a person: counted, or left out. Only a
 * question the stored scores hold for a style check can be resolved here.
 */
export async function resolveStyleCheck(
  input: { sessionId: string; position: number; decision: "score" | "exclude"; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  if (input.decision !== "score" && input.decision !== "exclude") {
    throw new LiveRecoveryError("bad_input", session.id);
  }
  const { data, error } = await deps.service
    .from("live_interview_scores")
    .select("questions")
    .eq("session_id", session.id)
    .eq("company_id", session.company_id)
    .maybeSingle();
  if (error) throw new LiveRecoveryError("db_error", session.id);
  const stored = (data as { questions: { position: number; style_check?: boolean }[] } | null)
    ?.questions;
  if (!stored?.some((q) => q.position === input.position && q.style_check === true)) {
    throw new LiveRecoveryError("no_check", session.id);
  }
  await log(deps, session, role, {
    action: "resolve_style_check",
    decision: input.decision,
    note,
    question_position: input.position,
  });
  return afterwards(deps, session.id);
}

/** A failed turn a person gives up on: its question is left out, never zero. */
export async function resolveFailedTranscription(
  input: { sessionId: string; turnId: string; decision: "exclude"; note: string },
  deps: RecoveryDeps,
): Promise<LiveScoreRow | null> {
  const { session, role, note } = await authorised(deps, input.sessionId, input.note);
  if (input.decision !== "exclude") throw new LiveRecoveryError("bad_input", session.id);
  const turn = await failedCandidateTurn(deps, session.id, input.turnId);
  await log(deps, session, role, {
    action: "resolve_failed_transcription",
    decision: "exclude",
    note,
    turn,
  });
  return afterwards(deps, session.id);
}

/**
 * The signed-in caller: a company member of the current company. Throws when
 * there is none; a Remotiv admin is never a recovery caller (F4).
 */
export async function currentRecoveryCaller(): Promise<RecoveryCaller> {
  const { getCompanyContext } = await import("@/app/ai-dashboard/lib/company-guards");
  const ctx = await getCompanyContext();
  return {
    kind: "company",
    userId: ctx.user.id,
    name: ctx.memberName || null,
    role: ctx.role,
    companyId: ctx.companyId,
  };
}
