import "server-only";
import { CONSENT_NOT_SAVED, CONSENT_NOT_SAVED_MESSAGE } from "@/lib/interviews/consent";
import { readFrozenQuestionSet } from "@/lib/interviews/frozen-questions";
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
  type LiveProviderMode,
  liveProviderMode,
  liveScreenEnabled,
} from "@/lib/interviews/live-screen";
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
 * ── Once ─────────────────────────────────────────────────────
 *
 * The provider session is claimed on the row (provider, provider_session_id,
 * status started, started_at) only while none exists, so two tabs or two
 * clicks start one conversation; the losing start's provider session is
 * cancelled, so it holds no slot. A session that has started can never be
 * started again from its link (no automatic restart, decision 26 Oct 2026).
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
  provider_session_id: string | null;
  questions_snapshot: unknown;
  scoring_snapshot: unknown;
};

const SESSION_COLUMNS =
  "id, company_id, application_id, job_id, kind, status, expires_at, live_settings, live_ended_at, provider_session_id, questions_snapshot, scoring_snapshot";

export type StartDeps = {
  service: Service;
  now?: () => number;
  /** Which provider; default liveProviderMode() (null in production). */
  mode?: LiveProviderMode | null;
  /** The provider itself; default the mock, playing the requested script. */
  provider?: LiveJoinProvider;
};

export async function startLiveInterview(
  body: { token?: unknown; mockScript?: unknown },
  deps: StartDeps,
): Promise<StartResult> {
  const now = deps.now ?? Date.now;
  const token = String(body.token ?? "");
  if (!token || token.length < 20 || token.length > 200) {
    return fail(404, "not_found", "This interview link isn't valid.");
  }
  const { data, error: readErr } = await deps.service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  if (readErr) return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  const row = data as SessionRow | null;
  if (row?.kind !== "live") return fail(404, "not_found", "This interview link isn't valid.");
  if (!liveScreenEnabled()) return fail(409, "not_open", "This interview isn't open yet.");
  if (row.provider_session_id || row.live_ended_at) {
    return fail(
      409,
      "already_started",
      "This interview has already started, so it can't start again.",
    );
  }
  if (!OPEN_STATUSES.includes(row.status) || Date.parse(row.expires_at) <= now()) {
    return fail(409, "not_open", "This interview is closed.");
  }

  let consent: Awaited<ReturnType<typeof requireLiveConsent>>;
  try {
    consent = await requireLiveConsent(deps.service, row.id);
  } catch (err) {
    if (err instanceof LiveConsentError && err.code === "not_ready") {
      return fail(409, "consent_locked", "This interview isn't open yet.");
    }
    if (err instanceof LiveConsentError && err.code !== "db_error") {
      return fail(403, "consent_required", "Please agree to the interview terms first.");
    }
    return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  }

  const mode = deps.mode === undefined ? liveProviderMode() : deps.mode;
  if (mode === null) {
    console.error(`[live-start] session ${row.id}: no provider available`);
    return fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }

  const settings = readLiveSettings(row.live_settings, row.id);
  const frozen = readFrozenQuestionSet(row);
  if (!settings || !frozen) return fail(409, "not_ready", "This interview isn't ready yet.");

  const { data: app, error: appErr } = await deps.service
    .from("job_applications")
    .select("first_name, last_name, cv_text")
    .eq("id", row.application_id ?? "")
    .eq("job_id", row.job_id ?? "")
    .eq("company_id_snapshot", row.company_id)
    .maybeSingle();
  if (appErr) return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  if (!app) return fail(409, "not_ready", "This interview isn't ready yet.");
  const a = app as { first_name: string | null; last_name: string | null; cv_text: string | null };

  let input: CreateSessionInput;
  try {
    input = buildCreateSessionInput({
      remotivSessionId: row.id,
      interviewerName: settings.interviewer_name,
      interviewMinutes: Math.max(1, Math.round(settings.max_session_seconds / 60)),
      questions: frozen,
      candidateFirstName: a.first_name,
      candidateLastName: a.last_name,
      cvText: a.cv_text,
      consent,
    });
  } catch (err) {
    if (!(err instanceof CreateSessionInputError)) throw err;
    console.error(`[live-start] session ${row.id}: provider input refused`);
    return fail(409, "not_ready", "This interview isn't ready yet.");
  }

  const script =
    isMockScriptId(body.mockScript) || body.mockScript === "busy" ? body.mockScript : "completed";
  const provider = deps.provider ?? createMockJoinProvider(script);
  let created: { providerSessionId: string; join: JoinTicket };
  try {
    created = await provider.createSession(input);
  } catch (err) {
    if (err instanceof ProviderBusyError) {
      console.log(`[live-start] session ${row.id}: provider at capacity`);
      return fail(503, "busy", TRY_AGAIN_SHORTLY, { retryAfterSeconds: err.retryAfterSeconds });
    }
    console.error(`[live-start] session ${row.id}: provider session not created`);
    return fail(503, "unavailable", TRY_AGAIN_SHORTLY);
  }

  // One conversation per session: claimed only while none exists.
  const { data: claimed, error: claimErr } = await deps.service
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
    .in("status", OPEN_STATUSES)
    .select("id");
  if (claimErr) return fail(502, "unavailable", TRY_AGAIN_SHORTLY);
  if (((claimed ?? []) as unknown[]).length === 0) {
    // Another start won: this provider session is never joined, so give it back.
    await provider.cancelSession(created.providerSessionId).catch(() => {
      console.error(`[live-start] session ${row.id}: a losing provider session was not cancelled`);
    });
    return fail(
      409,
      "already_started",
      "This interview has already started, so it can't start again.",
    );
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
    .select("id, kind, status, expires_at, provider_session_id, live_ended_at")
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  const row = data as Pick<
    SessionRow,
    "id" | "kind" | "status" | "expires_at" | "provider_session_id" | "live_ended_at"
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
