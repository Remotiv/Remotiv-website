"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One interview, one live tab.
 *
 * ── What actually goes wrong with two ────────────────────────
 *
 * Less than it sounds, because the server is already idempotent: the upload
 * targets a deterministic key with upsert, /api/interview/confirm upserts on
 * (session_id, position), it refuses anything once the session leaves `ready`,
 * and it refuses a second write to an answered position unless the job allows
 * re-recording. So two tabs cannot produce duplicate rows, orphaned objects or
 * a post-submission answer.
 *
 * What they CAN produce is two live MediaRecorders on one camera — which fails
 * outright with NotReadableError on some platforms, drains a phone on all of
 * them — and a stale tab whose progress display disagrees with the truth. A
 * candidate looking at the wrong tab does not know which take they kept.
 *
 * ── Detect and warn, not block ───────────────────────────────
 *
 * Reopening the link from the email is a reasonable thing to do, and the first
 * tab may be dead, crashed or on a phone that has since locked. Blocking the
 * second tab would strand exactly the person trying to recover. So the newer
 * tab is told, and offered the takeover; the older tab yields when it is taken.
 * Either tab can claim it back, so no one can get stuck in a dead end.
 *
 * ── Scope ────────────────────────────────────────────────────
 *
 * BroadcastChannel is same-origin and same-browser only. Two DIFFERENT devices,
 * or one normal and one private window, cannot see each other and are not
 * covered — that is a limit worth stating rather than papering over, and the
 * server-side guards above are what actually keep those honest.
 */

export type TabRole =
  /** This tab owns the interview. */
  | "active"
  /** Opened while another tab was already live. */
  | "duplicate"
  /** Was live, and another tab took over. */
  | "superseded";

type Message =
  | { t: "hello"; id: string }
  | { t: "here"; id: string }
  | { t: "take"; id: string };

/**
 * Channel name derived from the token, so two different interviews open at once
 * never speak to each other.
 *
 * A cheap non-cryptographic digest rather than the token itself: the channel
 * name is readable by any same-origin script, and while such a script could
 * already read the URL, there is no reason to copy a bearer credential into a
 * second place.
 */
function channelFor(token: string): string {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `remotiv-iv-${(h >>> 0).toString(36)}`;
}

/** How long a new tab waits for an existing one to answer. */
const HELLO_GRACE_MS = 500;

export function useTabLock(token: string): {
  role: TabRole;
  /** Claim the interview for this tab. Every other tab yields. */
  takeOver: () => void;
  /** False when the browser has no BroadcastChannel — nothing is enforced. */
  supported: boolean;
} {
  const [role, setRole] = useState<TabRole>("active");
  const [supported, setSupported] = useState(true);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const idRef = useRef<string>("");

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      setSupported(false);
      return;
    }

    const id =
      globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    idRef.current = id;

    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(channelFor(token));
    } catch {
      setSupported(false);
      return;
    }
    channelRef.current = channel;

    channel.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (!msg || msg.id === id) return;

      if (msg.t === "hello") {
        // Somebody new arrived. Answer only if this tab still holds the
        // interview — a superseded tab must not make the newcomer think the
        // seat is taken.
        setRole((r) => {
          if (r === "active") channel.postMessage({ t: "here", id } as Message);
          return r;
        });
        return;
      }

      if (msg.t === "here") {
        // An existing tab answered our hello. Only a tab that has not already
        // been claimed steps aside, so a takeover cannot be undone by a late
        // reply arriving after it.
        setRole((r) => (r === "active" ? "duplicate" : r));
        return;
      }

      if (msg.t === "take") {
        setRole((r) => (r === "active" ? "superseded" : r));
      }
    };

    channel.postMessage({ t: "hello", id } as Message);

    // If nothing answers inside the grace window this tab is simply the only
    // one, and the default `active` already says so — no timer bookkeeping.
    const settle = window.setTimeout(() => {}, HELLO_GRACE_MS);

    return () => {
      window.clearTimeout(settle);
      channel.onmessage = null;
      channel.close();
      channelRef.current = null;
    };
  }, [token]);

  const takeOver = useCallback(() => {
    channelRef.current?.postMessage({ t: "take", id: idRef.current } as Message);
    setRole("active");
  }, []);

  return { role, takeOver, supported };
}
