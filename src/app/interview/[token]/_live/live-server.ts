import type { LiveEventKind } from "@/lib/interviews/live-event-codes";
import type { JoinTicket } from "@/lib/interviews/live-provider/types";
import type { PieceMime, PieceSink } from "./video-pieces";

/**
 * The live screen's calls to Remotiv's server. The screen uses this
 * interface only, so the demo (preview-live) can swap in an in-memory one.
 *
 *   consent   api/interview/live/consent       the live-v1 agreement, saved
 *   start     api/interview/live/start         the join ticket, nothing else
 *   event     api/interview/live/event         what happened, as a record
 *   pieces    api/interview/live/video-*       the camera video (10a)
 *
 * The token goes in the body, never in a URL.
 */

export type ConsentAnswer = "saved" | "locked" | "closed" | "failed";

export type StartAnswer =
  | { ok: true; join: JoinTicket }
  | { ok: false; reason: "busy"; retryAfterSeconds: number }
  | {
      ok: false;
      reason: "unavailable" | "already_started" | "consent_required" | "locked" | "closed";
    };

export interface LiveServer {
  consent(): Promise<ConsentAnswer>;
  start(): Promise<StartAnswer>;
  /** A report, sent in the background and tried once more if it fails. */
  event(kind: LiveEventKind, detail?: string | null): void;
  /** A report that must survive the page closing (navigator.sendBeacon). */
  beacon(kind: LiveEventKind, detail?: string | null): void;
  pieces: PieceSink;
}

async function post(
  fetchImpl: typeof fetch,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // Unreadable: the status decides.
  }
  return { status: res.status, body: parsed };
}

export function startAnswerFrom(res: {
  status: number;
  body: Record<string, unknown>;
}): StartAnswer {
  if (res.status === 200 && res.body.join) return { ok: true, join: res.body.join as JoinTicket };
  const code = res.body.code;
  if (code === "busy") {
    const after = Number(res.body.retryAfterSeconds);
    return { ok: false, reason: "busy", retryAfterSeconds: Number.isFinite(after) ? after : 60 };
  }
  if (code === "already_started") return { ok: false, reason: "already_started" };
  if (code === "consent_required") return { ok: false, reason: "consent_required" };
  if (code === "consent_locked") return { ok: false, reason: "locked" };
  if (code === "not_open" || code === "not_found") return { ok: false, reason: "closed" };
  return { ok: false, reason: "unavailable" };
}

export function consentAnswerFrom(res: {
  status: number;
  body: Record<string, unknown>;
}): ConsentAnswer {
  if (res.status === 200 && res.body.ok === true) return "saved";
  if (res.body.code === "consent_locked") return "locked";
  if (res.body.code === "not_open" || res.body.code === "not_found") return "closed";
  return "failed";
}

export function httpLiveServer(token: string, fetchImpl: typeof fetch = fetch): LiveServer {
  const report = (kind: LiveEventKind, detail: string | null | undefined, tries: number) => {
    post(fetchImpl, "/api/interview/live/event", { token, kind, detail: detail ?? null })
      .then((res) => {
        if (res.status >= 500 && tries > 1) report(kind, detail, tries - 1);
      })
      .catch(() => {
        if (tries > 1) report(kind, detail, tries - 1);
      });
  };
  const fail = (what: string) => new Error(`${what} failed`);
  return {
    async consent() {
      try {
        return consentAnswerFrom(
          await post(fetchImpl, "/api/interview/live/consent", { token, agreed: true }),
        );
      } catch {
        return "failed";
      }
    },
    async start() {
      try {
        return startAnswerFrom(await post(fetchImpl, "/api/interview/live/start", { token }));
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
    event(kind, detail) {
      report(kind, detail, 2);
    },
    beacon(kind, detail) {
      const body = JSON.stringify({ token, kind, detail: detail ?? null });
      const sent =
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/interview/live/event", new Blob([body], { type: "text/plain" }));
      if (!sent) report(kind, detail, 1);
    },
    pieces: {
      async reserve(index: number, mime: PieceMime) {
        const res = await post(fetchImpl, "/api/interview/live/video-upload-url", {
          token,
          piece: index,
          mimeType: mime,
        });
        if (res.status === 200 && res.body.alreadyConfirmed === true)
          return { alreadyConfirmed: true };
        if (res.status === 200 && typeof res.body.url === "string") return { url: res.body.url };
        throw fail("reserve");
      },
      async upload(url, blob, mime) {
        const res = await fetchImpl(url, {
          method: "PUT",
          headers: { "content-type": mime },
          body: blob,
        });
        if (!res.ok) throw fail("upload");
      },
      async confirm(piece) {
        const res = await post(fetchImpl, "/api/interview/live/video-confirm", {
          token,
          piece: piece.index,
          mimeType: piece.mime,
          startedAtMs: piece.startedAtMs,
          durationMs: piece.durationMs,
          last: piece.last,
        });
        if (res.status !== 200) throw fail("confirm");
      },
    },
  };
}
