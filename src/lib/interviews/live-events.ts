import "server-only";
import { isLiveEventKind, validEventDetail } from "@/lib/interviews/live-event-codes";
import { hashSessionToken } from "@/lib/interviews/tokens";
import { MAX_SESSION_SECONDS, readLiveSettings } from "@/lib/interviews/types";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * What the candidate screen saw happen in a live interview, and when the
 * interview's end is stamped (AVI commit 10).
 *
 * ── Reports are a record, never an outcome ───────────────────
 *
 * handleLiveEvent stores one live_session_events row (migration 050) per
 * report from api/interview/live/event: codes only, timed by the database.
 * The outcome still comes only from the provider's export (live-ingest.ts):
 * no report makes an interview Completed, which needs the export's end_reason
 * completed AND completed_gracefully true (F15, D10).
 *
 * ── When live_ended_at is stamped ────────────────────────────
 *
 * live_ended_at (migration 044) ends the interview for video: nothing new is
 * reserved after it, and a piece already reserved can be confirmed for 30
 * minutes. Stamped, once, by the database's clock, ONLY by the server
 * (RB1, 28 Oct 2026):
 *
 *   the export saved        saveLiveExport (live-ingest.ts), the provider's
 *                           own record of the session
 *   a finalize call         a future authenticated server-to-server call from
 *                           the provider (not built yet; it will call
 *                           stampLiveEnded)
 *   the backstop            the interview's time limit (live_settings
 *                           max_session_seconds) plus END_GRACE_MS has passed
 *                           since started_at, which the start route set with
 *                           the server's clock: checked on every report, on
 *                           every video reserve and confirm (live-video.ts),
 *                           and swept from the worker tick (stampOverdueLiveEnds)
 *
 * NEVER by a browser report, whatever it says: provider_end_reported (the
 * screen's claim that the provider ended it), End pressed, a closed tab, a
 * dropped connection, a provider error, the time limit shown on the screen,
 * the conversation starting, video saved. Each is a row and nothing else, so
 * a forged or mistaken report can neither end the interview early nor close
 * its video window. Until the server confirms the end, the interview stays
 * open for video, and a piece still uploading is never cut off.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Tokens. Log lines carry the session id and the code.
 */

type Service = ReturnType<typeof createServiceClient>;

/** After the time limit, how long before the backstop ends the interview. */
export const END_GRACE_MS = 10 * 60_000;

/** Sessions the sweep looks at per tick. */
export const BACKSTOP_BATCH = 200;

export type EventResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, code: string, error: string): EventResult => ({
  status,
  body: { code, error },
});

type SessionRow = {
  id: string;
  company_id: string;
  kind: string | null;
  started_at: string | null;
  live_ended_at: string | null;
  provider_session_id: string | null;
  live_settings: unknown;
};

const SESSION_COLUMNS =
  "id, company_id, kind, started_at, live_ended_at, provider_session_id, live_settings";

/** When the backstop ends this interview, or null before it has started. */
export function liveEndDueAt(
  row: Pick<SessionRow, "id" | "started_at" | "live_settings">,
): number | null {
  if (!row.started_at) return null;
  const started = Date.parse(row.started_at);
  if (!Number.isFinite(started)) return null;
  const limit =
    readLiveSettings(row.live_settings, row.id)?.max_session_seconds ?? MAX_SESSION_SECONDS;
  return started + Math.min(limit, MAX_SESSION_SECONDS) * 1000 + END_GRACE_MS;
}

/**
 * Stamp the end, if it is not stamped yet. The value written is replaced by
 * the database's now() (044); writing it a second time would be refused, so
 * the update only matches an unstamped row. True when this call stamped it.
 */
export async function stampLiveEnded(
  service: Service,
  sessionId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  const { data, error } = await service
    .from("interview_sessions")
    .update({ live_ended_at: new Date(now()).toISOString() })
    .eq("id", sessionId)
    .eq("kind", "live")
    .is("live_ended_at", null)
    .select("id");
  if (error) {
    console.error(`[live-events] session ${sessionId}: end not stamped (${error.code ?? "error"})`);
    return false;
  }
  return ((data ?? []) as unknown[]).length > 0;
}

async function sessionFor(service: Service, token: string): Promise<SessionRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const { data } = await service
    .from("interview_sessions")
    .select(SESSION_COLUMNS)
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  const row = data as SessionRow | null;
  return row?.kind === "live" ? row : null;
}

export type LiveEventDeps = { service: Service; now?: () => number };

/**
 * One report from the candidate screen: { token, kind, detail? }. Recorded,
 * and nothing more: the end is stamped here only by the backstop.
 */
export async function handleLiveEvent(
  body: { token?: unknown; kind?: unknown; detail?: unknown },
  deps: LiveEventDeps,
): Promise<EventResult> {
  const now = deps.now ?? Date.now;
  const kind = body.kind;
  if (!isLiveEventKind(kind)) return fail(400, "bad_event", "That event isn't recognised.");
  const detail = body.detail ?? null;
  if (!validEventDetail(kind, detail)) {
    return fail(400, "bad_event", "That event detail isn't recognised.");
  }
  const session = await sessionFor(deps.service, String(body.token ?? ""));
  if (!session) return fail(404, "not_found", "This interview link isn't valid.");
  // Nothing to report before the conversation was set up (api/interview/live/start).
  if (!session.provider_session_id) {
    return fail(409, "not_started", "This interview hasn't started.");
  }

  // A report never ends the interview (RB1). Only the server-side backstop may stamp here.
  if (session.live_ended_at === null) {
    const due = liveEndDueAt(session);
    if (due !== null && due <= now()) await stampLiveEnded(deps.service, session.id, now);
  }

  const { error } = await deps.service.from("live_session_events").insert({
    session_id: session.id,
    company_id: session.company_id,
    kind,
    detail: detail as string | null,
  });
  if (error) {
    console.error(
      `[live-events] session ${session.id}: ${kind} not recorded (${error.code ?? "error"})`,
    );
    return fail(502, "not_recorded", "Couldn't record that. Please try again.");
  }
  console.log(`[live-events] session ${session.id}: ${kind}`);
  return { status: 200, body: { ok: true } };
}

/**
 * The backstop sweep, from the worker tick: every started live interview
 * past its time limit plus END_GRACE_MS with no end stamped gets one.
 * Returns how many it stamped. Counts only in the log.
 */
export async function stampOverdueLiveEnds(
  service: Service,
  now: () => number = Date.now,
): Promise<number> {
  // Coarse by the grace alone, then each session against its own limit.
  const { data, error } = await service
    .from("interview_sessions")
    .select("id, started_at, live_settings")
    .eq("kind", "live")
    .is("live_ended_at", null)
    .not("provider_session_id", "is", null)
    .lte("started_at", new Date(now() - END_GRACE_MS).toISOString())
    .limit(BACKSTOP_BATCH);
  if (error) {
    console.error(`[live-events] backstop read failed (${error.code ?? "error"})`);
    return 0;
  }
  let stamped = 0;
  for (const row of (data ?? []) as Pick<SessionRow, "id" | "started_at" | "live_settings">[]) {
    const due = liveEndDueAt(row);
    if (due !== null && due <= now() && (await stampLiveEnded(service, row.id, now))) stamped += 1;
  }
  if (stamped > 0) console.log(`[live-events] backstop ended ${stamped} live interviews`);
  return stamped;
}
