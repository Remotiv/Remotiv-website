import {
  LIVE_INTERVIEW_CONSENT_VERSION,
  liveConsentGiven,
  liveConsentReady,
} from "@/lib/interviews/live-consent";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Live interview consent, on the server: saved before anything starts, and
 * required, as saved, before the provider session can be created.
 *
 * ── Saved, or the interview does not start ───────────────────
 *
 * recordLiveConsent writes consent_at and consent_version 'live-v1' on the
 * live session, first time only, and then reads the row back: it reports
 * success only when the stored row carries live-v1. A declined screen writes
 * nothing. A failed write, a refused one or a row that does not read back as
 * live-v1 is a failure, and the caller must not start the interview. Nothing
 * is recorded while the consent text still has a placeholder in it
 * (live-consent.ts): it cannot have been shown.
 *
 * ── Required as stored, not as claimed ───────────────────────
 *
 * requireLiveConsent reads the session row and returns a LiveConsentProof
 * only when it carries live-v1; buildCreateSessionInput
 * (live-provider/create-session.ts) refuses anything but such a proof for
 * the same session. The proof cannot be made any other way, so a caller that
 * skipped the read, or passed a flag of its own, cannot create a provider
 * session.
 *
 * The async interview is unchanged: its consent stays "v2" and its
 * recording routes do not read consent_at.
 *
 * No `server-only` import: the service is passed in, and the provider tests
 * load create-session.ts without the server stubs.
 */

type Service = ReturnType<typeof createServiceClient>;

export type LiveConsentFailure =
  | "declined"
  | "not_ready"
  | "not_live"
  | "not_found"
  | "save_failed";

export type LiveConsentRecordResult = { ok: true } | { ok: false; reason: LiveConsentFailure };

export type LiveConsentProof = {
  readonly session_id: string;
  readonly consent_at: string;
  readonly consent_version: typeof LIVE_INTERVIEW_CONSENT_VERSION;
};

const proofs = new WeakSet<object>();

/** True only for a proof requireLiveConsent returned, untouched since. */
export function isLiveConsentProof(value: unknown): value is LiveConsentProof {
  return typeof value === "object" && value !== null && proofs.has(value);
}

export class LiveConsentError extends Error {
  readonly code: "no_consent" | "not_ready" | "not_live" | "db_error";
  constructor(code: LiveConsentError["code"], sessionId: string) {
    super(`live consent: ${code} (session ${sessionId})`);
    this.name = "LiveConsentError";
    this.code = code;
  }
}

type ConsentRow = {
  id: string;
  kind: string | null;
  consent_at: string | null;
  consent_version: string | null;
};

async function readRow(service: Service, sessionId: string): Promise<ConsentRow | null | "error"> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("id, kind, consent_at, consent_version")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return "error";
  return (data as ConsentRow | null) ?? null;
}

/** Save the candidate's consent to the live text. Success only when the stored row says live-v1. */
export async function recordLiveConsent(
  service: Service,
  sessionId: string,
  input: { agreed: boolean },
  now: () => number = Date.now,
): Promise<LiveConsentRecordResult> {
  if (input.agreed !== true) return { ok: false, reason: "declined" };
  if (!liveConsentReady()) return { ok: false, reason: "not_ready" };
  const before = await readRow(service, sessionId);
  if (before === "error") return { ok: false, reason: "save_failed" };
  if (!before) return { ok: false, reason: "not_found" };
  if (before.kind !== "live") return { ok: false, reason: "not_live" };
  if (!liveConsentGiven(before)) {
    // First time only: the moment they agreed is the first one.
    const { error } = await service
      .from("interview_sessions")
      .update({
        consent_at: new Date(now()).toISOString(),
        consent_version: LIVE_INTERVIEW_CONSENT_VERSION,
      })
      .eq("id", sessionId)
      .eq("kind", "live")
      .is("consent_at", null);
    if (error) return { ok: false, reason: "save_failed" };
  }
  const after = await readRow(service, sessionId);
  if (after === "error" || !after || !liveConsentGiven(after)) {
    return { ok: false, reason: "save_failed" };
  }
  return { ok: true };
}

/** The stored consent, as a proof the provider-session builder accepts. Throws without it. */
export async function requireLiveConsent(
  service: Service,
  sessionId: string,
): Promise<LiveConsentProof> {
  if (!liveConsentReady()) throw new LiveConsentError("not_ready", sessionId);
  const row = await readRow(service, sessionId);
  if (row === "error") throw new LiveConsentError("db_error", sessionId);
  if (!row) throw new LiveConsentError("no_consent", sessionId);
  if (row.kind !== "live") throw new LiveConsentError("not_live", sessionId);
  if (!liveConsentGiven(row)) throw new LiveConsentError("no_consent", sessionId);
  const proof: LiveConsentProof = Object.freeze({
    session_id: row.id,
    consent_at: row.consent_at as string,
    consent_version: LIVE_INTERVIEW_CONSENT_VERSION,
  });
  proofs.add(proof);
  return proof;
}
