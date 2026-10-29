import "server-only";
import { retentionPassed } from "@/lib/interviews/async-score-purge";
import { LiveConsentError, requireLiveConsent } from "@/lib/interviews/live-consent-record";
import { liveEndDueAt, stampLiveEnded } from "@/lib/interviews/live-events";
import { INTERVIEW_BUCKET } from "@/lib/interviews/session";
import { hashSessionToken } from "@/lib/interviews/tokens";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The candidate's camera video in an AI Video Interview, stored by Remotiv
 * (migration 044, live_video_pieces). The two candidate-screen endpoints,
 * api/interview/live/video-upload-url and video-confirm, are thin wrappers
 * over reservePieceUpload and confirmPiece here.
 *
 * ── What the video holds ─────────────────────────────────────
 *
 * The candidate's camera and their own microphone only. Sarah's voice is NOT
 * in the video: the review page plays her turn audio (interview_turns)
 * separately. Never stored on the interview server.
 *
 * ── Pieces ───────────────────────────────────────────────────
 *
 * About two minutes each (three at most, 50 MB at most), each a complete file:
 * the screen stops and restarts the recorder per piece. Piece N is RESERVED
 * when it starts recording (the screen asks for its upload URL then), and
 * CONFIRMED once the file is checked here. Reserving at the start is what
 * makes the end of the interview a hard line (044):
 *
 *   interview open              reserve and confirm
 *   ended (live_ended_at)       nothing new is reserved; a piece reserved
 *                               before the end can still get a fresh upload
 *                               URL and be confirmed for 30 minutes
 *   30 minutes after the end    nothing
 *
 * The database enforces all of it again (044's triggers); the checks here
 * exist to answer with a clear code instead of a database error.
 *
 * ── Never replaced ───────────────────────────────────────────
 *
 * Uploads are CREATE-ONLY (upsert false): a URL signed for a piece cannot
 * overwrite a file already stored, so an old URL can never replace a
 * confirmed piece. A file that fails the checks is removed, so the same piece
 * can be uploaded again. A confirmed piece answers alreadyConfirmed / ok.
 *
 * ── Who may ──────────────────────────────────────────────────
 *
 * Only a live session's own link (its token), open as above, with the
 * candidate's saved live-v1 consent (requireLiveConsent). While the live
 * consent text still has a placeholder, requireLiveConsent refuses, so these
 * endpoints refuse everything: live stays locked.
 *
 * ── The backstop, here too (RB1, 28 Oct 2026) ────────────────
 *
 * No browser report ends the interview any more (live-events.ts), so until
 * the server confirms the end the interview stays open for video. To keep
 * that bounded, every reserve and confirm first applies the server-side
 * backstop: once the time limit plus the grace has passed since started_at,
 * the end is stamped (by the database's clock) before anything else, so no
 * new piece is reserved, and a piece already reserved still has its 30
 * minutes to be confirmed.
 *
 * ── Never logged ─────────────────────────────────────────────
 *
 * Tokens, paths, signed URLs. Log lines carry the session id and piece number.
 */

type Service = ReturnType<typeof createServiceClient>;

export const PIECE_MAX_BYTES = 50 * 1024 * 1024;
export const PIECE_MAX_MS = 180_000;
export const PIECE_MAX_INDEX = 199;
export const UPLOAD_WINDOW_MS = 30 * 60_000;
const SNIFF_TTL_SECONDS = 60;
const TERMINAL = new Set(["submitted", "expired", "cancelled", "abandoned"]);
const EXT = { "video/webm": "webm", "video/mp4": "mp4" } as const;
export type PieceMime = keyof typeof EXT;

export type VideoResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, code: string, error: string): VideoResult => ({
  status,
  body: { code, error },
});

export type LiveVideoDeps = {
  service: Service;
  now?: () => number;
  /** The first bytes of a stored object, for the container check. */
  fetchHead?: (signedUrl: string) => Promise<Uint8Array>;
};

const defaultFetchHead = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url, { headers: { Range: "bytes=0-15" } });
  if (!res.ok) throw new Error(String(res.status));
  return new Uint8Array(await res.arrayBuffer());
};

/** The exact object path 044 requires: {session}/v{index}.webm or .mp4. */
export function piecePath(sessionId: string, index: number, mime: PieceMime): string {
  return `${sessionId}/v${index}.${EXT[mime]}`;
}

function sniff(bytes: Uint8Array): PieceMime | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  return null;
}

type SessionRow = {
  id: string;
  company_id: string;
  kind: string | null;
  status: string;
  expires_at: string;
  live_ended_at: string | null;
  /** Set by the start route with the server's clock: where the backstop counts from. */
  started_at: string | null;
  /** Read only for its time limit (liveEndDueAt). */
  live_settings: unknown;
  /** Past it (retention over, or the application being deleted, B7), no video at all. */
  delete_after: string | null;
};

type PieceRow = {
  piece_index: number;
  status: "pending" | "confirmed";
  mime_type: PieceMime;
  media_path: string | null;
};

/** Where in its life the session is, for video. */
function phase(s: SessionRow, now: number): "open" | "window" | "closed" {
  if (retentionPassed(s.delete_after, now)) return "closed";
  if (s.live_ended_at) {
    return now <= Date.parse(s.live_ended_at) + UPLOAD_WINDOW_MS ? "window" : "closed";
  }
  if (TERMINAL.has(s.status)) return "closed"; // ended with no recorded end: no window (044 fallback)
  if (s.status !== "invited" && s.status !== "started") return "closed";
  if (Date.parse(s.expires_at) <= now) return "closed";
  return "open";
}

async function sessionFor(service: Service, token: string): Promise<SessionRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const { data } = await service
    .from("interview_sessions")
    .select(
      "id, company_id, kind, status, expires_at, live_ended_at, started_at, live_settings, delete_after",
    )
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  const row = data as SessionRow | null;
  return row?.kind === "live" ? row : null;
}

/** The session, its consent and its phase; or the refusal to answer with. */
async function gate(
  deps: LiveVideoDeps,
  token: string,
): Promise<{ session: SessionRow; phase: "open" | "window" | "closed" } | VideoResult> {
  const session = await sessionFor(deps.service, token);
  if (!session) return fail(404, "not_found", "This interview link isn't valid.");
  try {
    await requireLiveConsent(deps.service, session.id);
  } catch (err) {
    if (err instanceof LiveConsentError && err.code !== "db_error") {
      return fail(403, "consent_required", "Please agree to the interview terms first.");
    }
    return fail(502, "unavailable", "Couldn't check this interview. Please try again.");
  }
  const now = deps.now ?? Date.now;
  // The server-side backstop first: past the time limit plus the grace, the interview has ended.
  if (session.live_ended_at === null) {
    const due = liveEndDueAt(session);
    if (due !== null && due <= now()) {
      await stampLiveEnded(deps.service, session.id, now);
      const again = await sessionFor(deps.service, token);
      if (!again) return fail(404, "not_found", "This interview link isn't valid.");
      return { session: again, phase: phase(again, now()) };
    }
  }
  return { session, phase: phase(session, now()) };
}

function readPiece(body: {
  piece?: unknown;
  mimeType?: unknown;
}): { index: number; mime: PieceMime } | VideoResult {
  const index = Number(body.piece);
  if (!Number.isInteger(index) || index < 0 || index > PIECE_MAX_INDEX) {
    return fail(400, "bad_piece", "That piece number isn't allowed.");
  }
  const mime = body.mimeType as PieceMime;
  if (!(mime in EXT)) return fail(400, "bad_piece", "That recording type isn't allowed.");
  return { index, mime };
}

async function pieceRow(
  service: Service,
  sessionId: string,
  index: number,
): Promise<PieceRow | null> {
  const { data } = await service
    .from("live_video_pieces")
    .select("piece_index, status, mime_type, media_path")
    .eq("session_id", sessionId)
    .eq("piece_index", index)
    .maybeSingle();
  return (data as PieceRow | null) ?? null;
}

/**
 * The upload URL for piece N: reserves it while the interview is open, gives
 * a fresh URL for a reserved piece within the window, answers alreadyConfirmed
 * for a confirmed one. Create-only.
 */
export async function reservePieceUpload(
  body: { token?: unknown; piece?: unknown; mimeType?: unknown },
  deps: LiveVideoDeps,
): Promise<VideoResult> {
  const g = await gate(deps, String(body.token ?? ""));
  if ("status" in g) return g;
  const p = readPiece(body);
  if ("status" in p) return p;
  const { session } = g;

  let row = await pieceRow(deps.service, session.id, p.index);
  if (row?.status === "confirmed") return { status: 200, body: { alreadyConfirmed: true } };
  if (row && row.mime_type !== p.mime) {
    return fail(400, "bad_piece", "That piece was started with a different recording type.");
  }
  if (!row) {
    // Only an open interview reserves a new piece: after the end nothing new is recorded.
    if (g.phase !== "open") return fail(409, "not_open", "This interview isn't accepting video.");
    const { error } = await deps.service.from("live_video_pieces").insert({
      session_id: session.id,
      company_id: session.company_id,
      piece_index: p.index,
      mime_type: p.mime,
      media_path: piecePath(session.id, p.index, p.mime),
    });
    if (error && error.code !== "23505") {
      return fail(409, "not_open", "This interview isn't accepting video.");
    }
    row = await pieceRow(deps.service, session.id, p.index);
    if (!row) return fail(502, "unavailable", "Couldn't start that piece. Please try again.");
    if (row.status === "confirmed") return { status: 200, body: { alreadyConfirmed: true } };
  } else if (g.phase === "closed") {
    return fail(409, "not_open", "This interview isn't accepting video.");
  }
  if (!row.media_path) return fail(409, "not_open", "This piece can no longer be uploaded.");

  const { data, error } = await deps.service.storage
    .from(INTERVIEW_BUCKET)
    // Create-only: a stored file is never replaced, whoever holds a URL.
    .createSignedUploadUrl(row.media_path, { upsert: false });
  if (error || !data?.signedUrl) {
    return fail(502, "unavailable", "Couldn't start that upload. Please try again.");
  }
  return { status: 200, body: { url: data.signedUrl, path: `v${p.index}.${EXT[p.mime]}` } };
}

/** Check the uploaded file for piece N and confirm it. Confirming again is ok. */
export async function confirmPiece(
  body: {
    token?: unknown;
    piece?: unknown;
    mimeType?: unknown;
    startedAtMs?: unknown;
    durationMs?: unknown;
    last?: unknown;
  },
  deps: LiveVideoDeps,
): Promise<VideoResult> {
  const g = await gate(deps, String(body.token ?? ""));
  if ("status" in g) return g;
  const p = readPiece(body);
  if ("status" in p) return p;
  const startedMs = Number(body.startedAtMs);
  const durationMs = Number(body.durationMs);
  if (!Number.isInteger(startedMs) || startedMs < 0) {
    return fail(400, "bad_timing", "startedAtMs must be a whole number of milliseconds.");
  }
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > PIECE_MAX_MS) {
    return fail(400, "bad_timing", "A piece is at most three minutes.");
  }
  const { session } = g;
  const row = await pieceRow(deps.service, session.id, p.index);
  if (!row) return fail(404, "not_reserved", "That piece was never started.");
  if (row.status === "confirmed") return { status: 200, body: { ok: true } };
  if (row.mime_type !== p.mime || !row.media_path) {
    return fail(400, "bad_piece", "That piece was started with a different recording type.");
  }
  if (g.phase === "closed") {
    return fail(409, "window_closed", "The upload window for this interview has closed.");
  }

  const path = row.media_path;
  const name = path.slice(session.id.length + 1);
  const bucket = deps.service.storage.from(INTERVIEW_BUCKET);
  const { data: listed, error: listErr } = await bucket.list(session.id, {
    search: name,
    limit: 2,
  });
  if (listErr) return fail(502, "unavailable", "Couldn't check that upload. Please try again.");
  const object = (
    (listed ?? []) as { name: string; metadata: { size?: number; mimetype?: string } | null }[]
  ).find((o) => o.name === name);
  if (!object) return fail(404, "not_uploaded", "Nothing arrived for that piece. Upload it again.");

  const size = object.metadata?.size ?? 0;
  const mimetype = (object.metadata?.mimetype ?? "").split(";")[0].trim();
  const reject = async (status: number, code: string, error: string) => {
    // The bad file goes, so the same piece can be uploaded again (create-only).
    await bucket.remove([path]);
    return fail(status, code, error);
  };
  if (size <= 0) return reject(400, "empty", "That piece came through empty.");
  if (size > PIECE_MAX_BYTES) return reject(413, "too_large", "That piece is too large.");
  if (mimetype !== p.mime)
    return reject(415, "not_video", "That file isn't a video we can accept.");

  const { data: signed } = await bucket.createSignedUrl(path, SNIFF_TTL_SECONDS);
  if (!signed?.signedUrl)
    return fail(502, "unavailable", "Couldn't check that upload. Please try again.");
  let head: Uint8Array;
  try {
    head = await (deps.fetchHead ?? defaultFetchHead)(signed.signedUrl);
  } catch {
    // Our storage, not their file: left in place so a retry can confirm it.
    return fail(502, "unavailable", "Couldn't check that upload. Please try again.");
  }
  if (sniff(head) !== p.mime)
    return reject(415, "not_video", "That file isn't a video we can accept.");

  const { data: landed, error } = await deps.service
    .from("live_video_pieces")
    .update({
      status: "confirmed",
      confirmed_at: new Date((deps.now ?? Date.now)()).toISOString(),
      bytes: size,
      started_ms: startedMs,
      duration_ms: durationMs,
      is_last: body.last === true,
    })
    .eq("session_id", session.id)
    .eq("piece_index", p.index)
    .eq("status", "pending")
    .select("piece_index");
  if (error) {
    // 044 refused it: past the window, or the interview ended with no recorded end.
    return fail(409, "window_closed", "The upload window for this interview has closed.");
  }
  if (((landed ?? []) as unknown[]).length === 0) {
    // Another request confirmed it first.
    const again = await pieceRow(deps.service, session.id, p.index);
    if (again?.status === "confirmed") return { status: 200, body: { ok: true } };
    return fail(502, "unavailable", "Couldn't save that piece. Please try again.");
  }
  console.log(`[live-video] session ${session.id}: piece ${p.index} confirmed`);
  return { status: 200, body: { ok: true } };
}
