import "server-only";
import { randomUUID } from "node:crypto";
import { getAnthropic } from "@/lib/anthropic";
import { CONSENT_NOT_SAVED, CONSENT_NOT_SAVED_MESSAGE } from "@/lib/interviews/consent";
import type { FrozenLiveQuestionSet } from "@/lib/interviews/frozen-questions";
import { liveInterviewsAvailableFor } from "@/lib/interviews/live-availability";
import {
  LiveConsentError,
  recordLiveConsent,
  requireLiveConsent,
} from "@/lib/interviews/live-consent-record";
import {
  buildCreateSessionInput,
  CreateSessionInputError,
} from "@/lib/interviews/live-provider/create-session";
import {
  createMockJoinProvider,
  isMockScriptId,
  type LiveJoinProvider,
  ProviderBusyError,
} from "@/lib/interviews/live-provider/join";
import type { CreateSessionInput, JoinTicket } from "@/lib/interviews/live-provider/types";
import {
  type PrepareErrorCode,
  PrepareLiveQuestionsError,
  prepareLiveQuestions,
} from "@/lib/interviews/live-question-freeze";
import type { LiveQuestionsClient } from "@/lib/interviews/live-questions";
import {
  type LiveProviderMode,
  liveProviderMode,
  liveScreenEnabled,
} from "@/lib/interviews/live-screen";
import { retentionOver } from "@/lib/interviews/session";
import { hashSessionToken } from "@/lib/interviews/tokens";
import { readLiveSettings } from "@/lib/interviews/types";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Starting a live interview (AVI commit 10): api/interview/live/start.
 *
 * ── The browser gets a ticket, never a key ───────────────────
 *
 * Everything happens here, on the server: the token is resolved, the saved
 * live-v1 consent read (requireLiveConsent), the frozen questions read, the
 * provider input built (buildCreateSessionInput: position and text only, the
 * CV cleaned), and the provider session created with the provider's API key,
 * which only the server holds. The answer carries the JoinTicket alone: for
 * VoxAgent, the short-lived ws_url and ws_token. No provider session id, no
 * key, no question text. The ticket is never stored and never logged.
 *
 * ── In order (#17, 25 Nov) ───────────────────────────────────
 *
 *   1. Entitlement, from the token alone (proveLiveStartEntitlement): the
 *      hashed token finds the session; it must be live, open, not expired,
 *      cancelled or past retention, its company on the AI Video Interview
 *      allowlist, the live screen switched on, its live-v1 consent saved, and
 *      its application still there and not being deleted. No id from the
 *      browser is ever read: the body carries the token and nothing else used.
 *   2. One start at a time (claimStart), BEFORE anything costly: the claim is
 *      a key in live_settings (start_claim), so expiry, re-send and the
 *      backstop never mistake it for a started call. Every other start is
 *      answered busy ("Please try again shortly") and makes no model call and
 *      no provider call.
 *   3. The questions, frozen once (prepareLiveQuestions), by the claim holder
 *      only, and only while its claim is still on the row: from the session's
 *      own invitation snapshot, never the job's current questions. A set
 *      already frozen (a start tried again, a restarted attempt's copy) is
 *      returned as it is. If it refuses, the claim is given back with the
 *      reason code kept on the session (live_settings.questions_freeze_failed)
 *      for the recruiter's review page, and the candidate sees "This interview
 *      isn't open yet", never the reason.
 *   4. The provider session, created with ONLY the frozen questions in order,
 *      the length, the follow-up limit and the first name (cv_text ""), and
 *      only while the claim has at least PROVIDER_TIMEOUT_MS + CLAIM_MARGIN_MS
 *      of its life left.
 *   5. The row claimed as started, by the start that holds the claim. A start
 *      retried within REJOIN_WINDOW_MS (15 seconds: a double click or a lost
 *      answer) gets the same conversation's join details again
 *      (provider.rejoinSession), never a new one; after that, a started
 *      session can never be started again from its link (no automatic
 *      restart, decisions 26 Oct and 30 Oct 2026: a dropped connection ends
 *      the attempt, a restart is the Owner's or Admin's call, F10). Nothing here
 *      uses the allowance: that was used once, at invite.
 *
 * ── Never for an applicant being deleted (#22, 25 Nov) ───────
 *
 * The applicant's delete closes every session in one transaction (071's
 * Close): the marker (deletion_started_at), delete_after now, and invited or
 * started becomes cancelled. So the session row itself says "being deleted",
 * and both writes that matter are conditional on it: the claim and the final
 * write land only on a row that still exists, is invited or started, and has
 * no delete_after due (stillOpen). A Close that commits first leaves those
 * writes nothing to match; one that waits behind the final write cancels a
 * session already started, which the delete pipeline then closes. The
 * applicant's marker is also read before the claim, before the provider is
 * asked, after it answers, and before a rejoin's join details go back
 * (deletionBegun), so a delete that began mid-start costs no provider session
 * where it can be seen in time. Whenever a check fails after the provider
 * answered: the provider session is cancelled, the claim given back, nothing
 * recorded, no join details sent, and the candidate sees "This interview isn't
 * open yet".
 *
 * ── A claim never sticks (CLAIM_STALE_MS, 2 minutes) ─────────
 *
 * A start that fails (the provider refuses, times out after
 * PROVIDER_TIMEOUT_MS, or the freeze refuses) gives its claim back at once,
 * so the candidate's next press starts. A start that dies holding it (the
 * server stopped) leaves it for two minutes, then the next press takes it
 * over. Two minutes because a start never asks the provider unless 45
 * seconds of its claim are left (30 for the provider, 15 for the final
 * write), so a start still running can never be overtaken while a provider
 * session it created is unrecorded; and a slow freeze (one scoring guide is
 * up to 30 seconds) gives up before the provider rather than run on. A
 * provider session created by a start that died is never joined: its join
 * details only ever reach the browser after the final write lands.
 *
 * ── Busy is normal ───────────────────────────────────────────
 *
 * At capacity: 503 busy with retryAfterSeconds, "Please try again shortly",
 * and nothing is written, so the candidate can start once a slot is free.
 * Any other provider failure answers the same sentence (B3).
 *
 * ── Locked ───────────────────────────────────────────────────
 *
 * Off unless LIVE_INTERVIEW_SCREEN_ENABLED is "1" (live-screen.ts). Refused
 * while the live consent text has a placeholder (requireLiveConsent). The
 * mock is refused in a production build, and there is no real provider yet.
 */

type Service = ReturnType<typeof createServiceClient>;

export type StartResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, code: string, error: string, extra = {}): StartResult => ({
  status,
  body: { code, error, ...extra },
});

/** The sentence for busy and for any provider failure: plain, not an error (B3). */
export const TRY_AGAIN_SHORTLY = "Please try again shortly. Your interview is still open.";

const OPEN_STATUSES = ["invited", "started"];

/** A start that claimed the session and then died: after this, another start may take over. */
export const CLAIM_STALE_MS = 120_000;
/** The longest a start waits for the provider to create its session. */
export const PROVIDER_TIMEOUT_MS = 30_000;
/** Kept back from a claim's life for the final write, after the provider answered. */
const CLAIM_MARGIN_MS = 15_000;
/**
 * A start retried this soon after it succeeded (a double click, an answer lost
 * on the way) gets the same conversation again. Kept short on purpose: it is
 * not a way back into an interview. A dropped connection ends the attempt,
 * and a restart is the Owner's or Admin's decision (30 Oct 2026, F10).
 */
export const REJOIN_WINDOW_MS = 15_000;
const CLAIM_KEY = "start_claim";
/** Where the freeze's refusal is kept for the recruiter (reason code and time, never more). */
export const FREEZE_FAILED_KEY = "questions_freeze_failed";

type SessionRow = {
  id: string;
  company_id: string;
  application_id: string | null;
  job_id: string | null;
  kind: string | null;
  status: string;
  expires_at: string;
  live_settings: unknown;
  live_ended_at: string | null;
  started_at: string | null;
  provider: string | null;
  provider_session_id: string | null;
  delete_after: string | null;
  purged_at: string | null;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
};

const SESSION_COLUMNS =
  "id, company_id, application_id, job_id, kind, status, expires_at, live_settings, live_ended_at, started_at, provider, provider_session_id, delete_after, purged_at, questions_snapshot, scoring_snapshot";

const NOT_FOUND = (): StartResult => fail(404, "not_found", "This interview link isn't valid.");
/**
 * Closed while this start ran (#22): the applicant's delete began, or the
 * session was closed. `not_ready` is the code the candidate's page shows as
 * "This interview isn't open yet" (live-server.ts), never the reason.
 */
const NOT_OPEN_YET = (): StartResult => fail(409, "not_ready", "This interview isn't open yet.");
const NOT_READY = (): StartResult => fail(409, "not_ready", "This interview isn't ready yet.");
const ALREADY_STARTED = (): StartResult =>
  fail(409, "already_started", "This interview has already started, so it can't start again.");

/** The freeze refusals worth trying again in a moment (not the interview's set-up). */
const TRANSIENT_FREEZE: ReadonlySet<PrepareErrorCode> = new Set<PrepareErrorCode>([
  "db_error",
  "guide_failed",
  "freeze_lost",
]);

/**
 * Past retention, this session's first transcript write would fail (RT063), so
 * it is refused here: before consent is saved and before a provider session,
 * which costs money, is created.
 */
function refusedForRetention(
  row: Pick<SessionRow, "id" | "delete_after" | "purged_at">,
  nowMs: number,
): StartResult | null {
  if (!retentionOver(row, nowMs)) return null;
  console.warn(`[live-start] session ${row.id}: past retention, refused`);
  return fail(409, "not_open", "This interview is closed.");
}

export type StartDeps = {
  service: Service;
  now?: () => number;
  /** Which provider; default liveProviderMode() (null in production). */
  mode?: LiveProviderMode | null;
  /** The provider itself; default the mock, playing the requested script. */
  provider?: LiveJoinProvider;
  /** The model for the freeze's job-level scoring guides; default the app's, made only if used. */
  questionsClient?: LiveQuestionsClient;
  newId?: () => string;
  /** Default PROVIDER_TIMEOUT_MS. */
  providerTimeoutMs?: number;
};

/** The app's model client, created only when the freeze needs a guide written. */
const lazyQuestionsClient: LiveQuestionsClient = {
  messages: {
    create: (request, options) =>
      (getAnthropic() as unknown as LiveQuestionsClient).messages.create(request, options),
  },
};

/** What the token proved: the session, its saved consent and the candidate's first name. */
export type LiveStartEntitlement = {
  row: SessionRow;
  consent: Awaited<ReturnType<typeof requireLiveConsent>>;
  firstName: string | null;
  /** Started moments ago (REJOIN_WINDOW_MS): the same conversation is joined again. */
  rejoin: boolean;
};

/** A claim this start holds on the session: its value and when it was taken. */
type Claim = { value: string; atMs: number };

/** Started, not ended, and within REJOIN_WINDOW_MS of starting. */
function rejoinable(row: SessionRow, nowMs: number): boolean {
  if (!row.provider_session_id || row.live_ended_at || row.status !== "started") return false;
  const at = row.started_at ? Date.parse(row.started_at) : Number.NaN;
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < REJOIN_WINDOW_MS;
}

/** This session's claim, if any and if it is its own (a restarted attempt copies its predecessor's). */
function claimOf(settings: unknown, sessionId: string): { value: string; atMs: number } | null {
  const raw = (settings as Record<string, unknown> | null)?.[CLAIM_KEY];
  if (typeof raw !== "string") return null;
  const [id, at] = raw.split("|");
  const atMs = Number(at);
  return id === sessionId && Number.isFinite(atMs) ? { value: raw, atMs } : null;
}

/**
 * Proves, from the candidate's token alone, that this start may go ahead.
 * Every refusal is decided here, before any question is frozen or any
 * provider is asked for anything. Read-only.
 */
export async function proveLiveStartEntitlement(
  token: string,
  deps: Pick<StartDeps, "service" | "now">,
): Promise<{ ok: true; entitlement: LiveStartEntitlement } | { ok: false; result: StartResult }> {
  const now = deps.now ?? Date.now;
  const no = (result: StartResult) => ({ ok: false as const, result });
  if (!token || token.length < 20 || token.length > 200) return no(NOT_FOUND());
  const { data, error: readErr } = await deps.service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  if (readErr) return no(fail(502, "unavailable", TRY_AGAIN_SHORTLY));
  const row = data as SessionRow | null;
  if (row?.kind !== "live") return no(NOT_FOUND());
  if (!liveScreenEnabled()) return no(fail(409, "not_open", "This interview isn't open yet."));
  const rejoin = rejoinable(row, now());
  if (!rejoin && (row.provider_session_id || row.live_ended_at)) return no(ALREADY_STARTED());
  if (!OPEN_STATUSES.includes(row.status) || Date.parse(row.expires_at) <= now()) {
    return no(fail(409, "not_open", "This interview is closed."));
  }
  const pastRetention = refusedForRetention(row, now());
  if (pastRetention) return no(pastRetention);

  let consent: Awaited<ReturnType<typeof requireLiveConsent>>;
  try {
    consent = await requireLiveConsent(deps.service, row.id);
  } catch (err) {
    if (err instanceof LiveConsentError && err.code === "not_ready") {
      return no(fail(409, "consent_locked", "This interview isn't open yet."));
    }
    if (err instanceof LiveConsentError && err.code !== "db_error") {
      return no(fail(403, "consent_required", "Please agree to the interview terms first."));
    }
    return no(fail(502, "unavailable", TRY_AGAIN_SHORTLY));
  }
  // The session's own company must be allowed AI Video Interviews now, not only at invite.
  if (!liveInterviewsAvailableFor(row.company_id)) {
    return no(fail(409, "not_open", "This interview isn't open yet."));
  }

  // The application, within the session's own company and job: the first name
  // only (#14: VoxAgent gets no CV, so the CV is not read), and never one being deleted.
  const { data: app, error: appErr } = await deps.service
    .from("job_applications")
    .select("first_name, deletion_started_at")
    .eq("id", row.application_id ?? "")
    .eq("job_id", row.job_id ?? "")
    .eq("company_id_snapshot", row.company_id)
    .maybeSingle();
  if (appErr) return no(fail(502, "unavailable", TRY_AGAIN_SHORTLY));
  const a = app as { first_name: string | null; deletion_started_at?: string | null } | null;
  if (!a) return no(NOT_READY());
  if (a.deletion_started_at) return no(fail(409, "not_open", "This interview is closed."));
  return { ok: true, entitlement: { row, consent, firstName: a.first_name, rejoin } };
}

/**
 * The conditions every start write carries (#22): the row is invited or
 * started (071's Close makes it cancelled) and no delete_after is due (the
 * Close sets it to now). A row deleted by Finish matches nothing anyway.
 */
function stillOpen<Q extends { in: (c: string, v: string[]) => Q; or: (f: string) => Q }>(
  query: Q,
  nowMs: number,
): Q {
  const at = new Date(nowMs).toISOString();
  return query.in("status", OPEN_STATUSES).or(`delete_after.is.null,delete_after.gt."${at}"`);
}

/**
 * Whether the applicant's delete has begun, or the session has been closed,
 * since the entitlement was proved (#22): read again at each step of a start.
 * "unknown" when a read failed: the start does not go on.
 */
async function deletionBegun(
  service: Service,
  row: Pick<SessionRow, "id" | "company_id" | "application_id">,
  nowMs: number,
  open: readonly string[] = OPEN_STATUSES,
): Promise<"clear" | "closed" | "unknown"> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("status, delete_after, purged_at")
    .eq("id", row.id)
    .maybeSingle();
  if (error) return "unknown";
  const now = data as Pick<SessionRow, "status" | "delete_after" | "purged_at"> | null;
  if (!now || !open.includes(now.status) || retentionOver(now, nowMs)) return "closed";
  // The applicant's marker, on the session's own company, as the entitlement reads it.
  const { data: app, error: appErr } = await service
    .from("job_applications")
    .select("deletion_started_at")
    .eq("id", row.application_id ?? "")
    .eq("company_id_snapshot", row.company_id)
    .maybeSingle();
  if (appErr) return "unknown";
  const a = app as { deletion_started_at: string | null } | null;
  return !a || a.deletion_started_at ? "closed" : "clear";
}

/**
 * Claims the session for this start before anything costly: one claim lands,
 * every other start is told to try again shortly. Written over no claim, or
 * over exactly a stale one (CLAIM_STALE_MS).
 */
async function claimStart(
  service: Service,
  sessionId: string,
  nowMs: number,
): Promise<Claim | "taken" | "failed" | "closed"> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("live_settings, provider_session_id, status, delete_after, purged_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return "failed";
  if (!data) return "closed";
  const row = data as Pick<
    SessionRow,
    "live_settings" | "provider_session_id" | "status" | "delete_after" | "purged_at"
  >;
  if (row.provider_session_id) return "taken";
  if (!OPEN_STATUSES.includes(row.status) || retentionOver(row, nowMs)) return "closed";
  const current = claimOf(row.live_settings, sessionId);
  if (current && nowMs - current.atMs < CLAIM_STALE_MS) return "taken";
  const raw = (row.live_settings as Record<string, unknown>)[CLAIM_KEY];
  const value = `${sessionId}|${nowMs}|${randomUUID()}`;
  const settings = { ...(row.live_settings as Record<string, unknown>), [CLAIM_KEY]: value };
  const write = stillOpen(
    service
      .from("interview_sessions")
      .update({ live_settings: settings })
      .eq("id", sessionId)
      .eq("kind", "live")
      .is("provider_session_id", null),
    nowMs,
  );
  const { data: landed, error: wErr } = await (typeof raw === "string"
    ? write.eq(`live_settings->>${CLAIM_KEY}`, raw)
    : write.is(`live_settings->>${CLAIM_KEY}`, null)
  ).select("id");
  if (wErr) return "failed";
  return ((landed ?? []) as unknown[]).length === 1 ? { value, atMs: nowMs } : "taken";
}

/**
 * Gives the claim back, so the candidate's next press can start, keeping
 * whatever else is on the row now (a set frozen under this claim stays). With
 * `extra`, those keys are written in the same update: the freeze's refusal
 * code, for the recruiter. Only while this start still holds the claim.
 */
async function releaseClaim(
  service: Service,
  sessionId: string,
  claim: Claim,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { data, error: readErr } = await service
    .from("interview_sessions")
    .select("live_settings")
    .eq("id", sessionId)
    .maybeSingle();
  const now = (data as { live_settings: unknown } | null)?.live_settings as Record<
    string,
    unknown
  > | null;
  if (readErr || !now || now[CLAIM_KEY] !== claim.value) {
    if (readErr) console.error(`[live-start] session ${sessionId}: start claim not released`);
    return;
  }
  const { [CLAIM_KEY]: _released, ...settings } = now;
  const { error } = await service
    .from("interview_sessions")
    .update({ live_settings: { ...settings, ...extra } })
    .eq("id", sessionId)
    .eq(`live_settings->>${CLAIM_KEY}`, claim.value)
    .is("provider_session_id", null)
    .select("id");
  if (error) console.error(`[live-start] session ${sessionId}: start claim not released`);
}

class ProviderTimeoutError extends Error {}

/**
 * The provider's answer, or a timeout after `ms`. A session the provider
 * creates after the timeout is cancelled as soon as it arrives: nobody holds
 * its join details, so it is never joined.
 */
async function createWithin(
  provider: LiveJoinProvider,
  input: CreateSessionInput,
  ms: number,
  sessionId: string,
): Promise<{ providerSessionId: string; join: JoinTicket }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const call = provider.createSession(input);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new ProviderTimeoutError());
    }, ms);
  });
  call
    .then((late) => {
      if (!timedOut) return;
      provider.cancelSession(late.providerSessionId).catch(() => {
        console.error(
          `[live-start] session ${sessionId}: a late provider session was not cancelled`,
        );
      });
    })
    .catch(() => {});
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A start retried just after it succeeded: the same conversation, never a new one. */
async function rejoinStarted(
  service: Service,
  row: SessionRow,
  provider: LiveJoinProvider,
  maxFollowUps: number,
  now: () => number,
): Promise<StartResult> {
  if (!provider.rejoinSession || provider.name !== row.provider || !row.provider_session_id) {
    return ALREADY_STARTED();
  }
  try {
    const join = await provider.rejoinSession(row.provider_session_id, maxFollowUps);
    // Never handed back for an applicant whose delete began meanwhile (#22).
    const check = await deletionBegun(service, row, now(), ["started"]);
    if (check !== "clear") {
      console.warn(`[live-start] session ${row.id}: closed during the rejoin, not joined again`);
      return check === "closed" ? NOT_OPEN_YET() : fail(503, "unavailable", TRY_AGAIN_SHORTLY);
    }
    console.log(`[live-start] session ${row.id}: joined again (${provider.name})`);
    return { status: 200, body: { join } };
  } catch {
    console.error(`[live-start] session ${row.id}: provider session not joined again`);
    return fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }
}

export async function startLiveInterview(
  body: { token?: unknown; mockScript?: unknown },
  deps: StartDeps,
): Promise<StartResult> {
  const now = deps.now ?? Date.now;

  // 1. Entitlement, from the token alone.
  const proof = await proveLiveStartEntitlement(String(body.token ?? ""), deps);
  if (!proof.ok) return proof.result;
  const { row, consent, firstName, rejoin } = proof.entitlement;

  const mode = deps.mode === undefined ? liveProviderMode() : deps.mode;
  if (mode === null) {
    console.error(`[live-start] session ${row.id}: no provider available`);
    return fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }
  const settings = readLiveSettings(row.live_settings, row.id);
  if (!settings) return NOT_READY();
  const script =
    isMockScriptId(body.mockScript) || body.mockScript === "busy" ? body.mockScript : "completed";
  const provider = deps.provider ?? createMockJoinProvider(script);
  if (rejoin) {
    return rejoinStarted(
      deps.service,
      row,
      provider,
      settings.max_follow_ups_per_base_question,
      now,
    );
  }

  // 2. One start at a time, claimed before anything costly, and never for an
  // applicant whose delete began since the entitlement (#22).
  const before = await deletionBegun(deps.service, row, now());
  if (before === "closed") return NOT_OPEN_YET();
  if (before === "unknown") return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  const claim = await claimStart(deps.service, row.id, now());
  if (claim === "closed") return NOT_OPEN_YET();
  if (claim === "failed") return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  if (claim === "taken") {
    // The claim's own conditions refuse a row the delete closed: not busy, closed.
    if ((await deletionBegun(deps.service, row, now())) === "closed") return NOT_OPEN_YET();
    return fail(503, "busy", TRY_AGAIN_SHORTLY, { retryAfterSeconds: 5 });
  }

  // 3. The questions, frozen once, from the session's own invitation snapshot.
  let frozen: FrozenLiveQuestionSet;
  try {
    frozen = (
      await prepareLiveQuestions(row.id, {
        service: deps.service,
        client: deps.questionsClient ?? lazyQuestionsClient,
        now,
        newId: deps.newId ?? (() => randomUUID()),
        claim: { key: CLAIM_KEY, value: claim.value },
      })
    ).set;
  } catch (err) {
    if (!(err instanceof PrepareLiveQuestionsError)) {
      await releaseClaim(deps.service, row.id, claim);
      throw err;
    }
    console.error(`[live-start] session ${row.id}: questions not frozen (${err.code})`);
    if (TRANSIENT_FREEZE.has(err.code) || err.code === "already_started") {
      await releaseClaim(deps.service, row.id, claim);
      return err.code === "already_started"
        ? ALREADY_STARTED()
        : fail(503, "unavailable", TRY_AGAIN_SHORTLY);
    }
    await releaseClaim(deps.service, row.id, claim, {
      [FREEZE_FAILED_KEY]: { code: err.code, at: new Date(now()).toISOString() },
    });
    return NOT_READY();
  }

  let input: CreateSessionInput;
  try {
    input = buildCreateSessionInput({
      remotivSessionId: row.id,
      interviewerName: settings.interviewer_name,
      interviewMinutes: Math.max(1, Math.round(settings.max_session_seconds / 60)),
      maxFollowUps: settings.max_follow_ups_per_base_question,
      questions: frozen,
      candidateFirstName: firstName,
      consent,
    });
  } catch (err) {
    await releaseClaim(deps.service, row.id, claim);
    if (!(err instanceof CreateSessionInputError)) throw err;
    console.error(`[live-start] session ${row.id}: provider input refused`);
    return NOT_READY();
  }

  // 4. The provider session, only with time left on the claim for it and the final write.
  const timeoutMs = deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  if (now() - claim.atMs > CLAIM_STALE_MS - timeoutMs - CLAIM_MARGIN_MS) {
    console.warn(`[live-start] session ${row.id}: preparation ran long, provider not asked`);
    await releaseClaim(deps.service, row.id, claim);
    return fail(503, "busy", TRY_AGAIN_SHORTLY, { retryAfterSeconds: 5 });
  }
  const beforeProvider = await deletionBegun(deps.service, row, now());
  if (beforeProvider !== "clear") {
    console.warn(`[live-start] session ${row.id}: closed before the provider was asked`);
    await releaseClaim(deps.service, row.id, claim);
    return beforeProvider === "closed"
      ? NOT_OPEN_YET()
      : fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }
  let created: { providerSessionId: string; join: JoinTicket };
  try {
    created = await createWithin(provider, input, timeoutMs, row.id);
  } catch (err) {
    await releaseClaim(deps.service, row.id, claim);
    if (err instanceof ProviderBusyError) {
      console.log(`[live-start] session ${row.id}: provider at capacity`);
      return fail(503, "busy", TRY_AGAIN_SHORTLY, { retryAfterSeconds: err.retryAfterSeconds });
    }
    console.error(
      `[live-start] session ${row.id}: provider session not created${err instanceof ProviderTimeoutError ? " (timed out)" : ""}`,
    );
    return fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }

  // Never joined: give the provider session back, so it holds no slot.
  const giveBack = () =>
    provider.cancelSession(created.providerSessionId).catch(() => {
      console.error(`[live-start] session ${row.id}: a losing provider session was not cancelled`);
    });

  // The applicant's delete may have begun while the provider answered (#22).
  const afterProvider = await deletionBegun(deps.service, row, now());
  if (afterProvider !== "clear") {
    console.warn(`[live-start] session ${row.id}: closed while the provider answered, not started`);
    await giveBack();
    await releaseClaim(deps.service, row.id, claim);
    return afterProvider === "closed"
      ? NOT_OPEN_YET()
      : fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }

  // 5. One conversation per session: claimed as started by the start holding
  // the claim, and only on a row the applicant's delete has not closed.
  const { data: claimed, error: claimErr } = await stillOpen(
    deps.service
      .from("interview_sessions")
      .update({
        provider: provider.name,
        provider_session_id: created.providerSessionId,
        status: "started",
        started_at: new Date(now()).toISOString(),
      })
      .eq("id", row.id)
      .eq("kind", "live")
      .is("provider_session_id", null)
      .eq(`live_settings->>${CLAIM_KEY}`, claim.value),
    now(),
  ).select("id");
  if (claimErr || ((claimed ?? []) as unknown[]).length === 0) {
    await giveBack();
    if (claimErr) {
      await releaseClaim(deps.service, row.id, claim);
      return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
    }
    // Lost to another start, or closed by a delete that landed first.
    if ((await deletionBegun(deps.service, row, now())) === "clear") return ALREADY_STARTED();
    console.warn(`[live-start] session ${row.id}: closed at the final write, not started`);
    await releaseClaim(deps.service, row.id, claim);
    return NOT_OPEN_YET();
  }
  console.log(`[live-start] session ${row.id}: started (${provider.name})`);
  return { status: 200, body: { join: created.join } };
}

/**
 * The candidate agreed to the live consent text: api/interview/live/consent.
 * Saved as live-v1 (recordLiveConsent), or the interview does not start.
 * Refused, and nothing written, while the text has a placeholder.
 */
export async function agreeToLiveInterview(
  body: { token?: unknown; agreed?: unknown },
  deps: { service: Service; now?: () => number },
): Promise<StartResult> {
  const token = String(body.token ?? "");
  if (!token || token.length < 20 || token.length > 200) {
    return fail(404, "not_found", "This interview link isn't valid.");
  }
  const { data } = await deps.service
    .from("interview_sessions")
    .select(
      "id, kind, status, expires_at, provider_session_id, live_ended_at, delete_after, purged_at",
    )
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  const row = data as Pick<
    SessionRow,
    | "id"
    | "kind"
    | "status"
    | "expires_at"
    | "provider_session_id"
    | "live_ended_at"
    | "delete_after"
    | "purged_at"
  > | null;
  if (row?.kind !== "live") return fail(404, "not_found", "This interview link isn't valid.");
  if (!liveScreenEnabled()) return fail(409, "not_open", "This interview isn't open yet.");
  if (
    row.provider_session_id ||
    row.live_ended_at ||
    !OPEN_STATUSES.includes(row.status) ||
    Date.parse(row.expires_at) <= (deps.now ?? Date.now)()
  ) {
    return fail(409, "not_open", "This interview is closed.");
  }
  const pastRetention = refusedForRetention(row, (deps.now ?? Date.now)());
  if (pastRetention) return pastRetention;
  const saved = await recordLiveConsent(
    deps.service,
    row.id,
    { agreed: body.agreed === true },
    deps.now,
  );
  if (saved.ok) return { status: 200, body: { ok: true } };
  if (saved.reason === "declined") return fail(400, "declined", "Please tick the box to continue.");
  if (saved.reason === "not_ready")
    return fail(409, "consent_locked", "This interview isn't open yet.");
  return fail(500, CONSENT_NOT_SAVED, CONSENT_NOT_SAVED_MESSAGE);
}
