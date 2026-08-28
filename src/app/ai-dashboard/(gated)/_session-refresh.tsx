"use client";

import { useEffect } from "react";

const ENDPOINT = "/ai-dashboard/api/session/refresh";

/*
 * Wake up four minutes before expiry.
 *
 * Bounded on both sides by the endpoint's own five-minute margin: later than
 * that and the endpoint returns early without rotating anything, earlier than
 * auth-js's 90-second margin and a page render would already be attempting a
 * refresh it cannot persist. Four minutes sits between the two.
 */
const LEAD_MS = 4 * 60 * 1000;
const MIN_DELAY_MS = 30 * 1000;
// Browsers throttle long background timers hard, so a timer this far out is not
// something to rely on. The visibility handler is what actually wakes a tab
// that has been sitting; the cap just keeps the fallback honest.
const MAX_DELAY_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;

/**
 * Keeps the session alive for as long as a dashboard tab is open.
 *
 * Nothing else does. The browser client auto-refreshes, but it is only ever
 * constructed on the four auth pages — no Supabase client exists in the browser
 * anywhere under (gated), so a signed-in user's token used to simply run out.
 */
export function SessionRefresh() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;

    const scheduleIn = (delay: number) => {
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void ping(), delay);
    };

    const ping = () => {
      /*
       * One request at a time, and every caller shares it.
       *
       * Mount, tab focus and the timer can all land together. Without this, a
       * tab regaining focus mid-flight starts a second rotation against a
       * refresh token the first request is already spending — and the loser of
       * that race gets a revoked family, signing the user out.
       */
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          const res = await fetch(ENDPOINT, { method: "POST" });
          if (!res.ok) return;

          const { expiresAt } = (await res.json()) as { expiresAt: number | null };
          if (expiresAt === null) return;

          const untilRefresh = expiresAt * 1000 - Date.now() - LEAD_MS;
          scheduleIn(Math.min(Math.max(untilRefresh, MIN_DELAY_MS), MAX_DELAY_MS));
        } catch {
          // Offline, or the request was cut short. There is nothing to tell the
          // user — the session is still valid for minutes yet — so come back
          // shortly rather than abandoning the tab for the rest of its life.
          scheduleIn(RETRY_DELAY_MS);
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    };

    // A non-ok answer deliberately schedules nothing. It means signed out or
    // refused, and the next navigation is what should deal with that, not a
    // retry loop against an endpoint that has already said no.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void ping();
    };

    void ping();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
