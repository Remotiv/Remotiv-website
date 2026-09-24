"use client";

import { Lock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { dismissTip } from "@/app/ai-dashboard/(gated)/tip-actions";
import { getGuide, type TipKey } from "@/app/ai-dashboard/lib/tips";

/**
 * A tip, in the flow of the page it explains.
 *
 * ── Why a flat card and not a coachmark ──────────────────────
 *
 * Same reason the wizard's PromiseBox is not a tooltip: a floating bubble
 * anchored to a control has to be dismissed before the page can be used, moves
 * when the layout does, and is unreachable on a phone. This sits in the column
 * and pushes the page down, so it is read once and closed, or ignored.
 *
 * Its construction follows the review client's `Notice` — light, bordered, sky
 * tint, in the flow — rather than PromiseBox's dark ink card, because this page
 * already opens with a dark hero and two dark bands in a row read as one. It
 * takes PromiseBox's anatomy (heading, then the explanation) since a tip needs
 * a heading, and adds the one thing neither has: a way to close it.
 *
 * ── Dismissal without a table ────────────────────────────────
 *
 * Three layers, deliberately, because only one of them is durable:
 *
 *   state          — hides immediately, every time, whatever the server says.
 *   sessionStorage — holds across navigations in this tab, so the tip cannot
 *                    come back on the next visit to the page within a session.
 *   the row        — the only one that survives a reload, and the only one that
 *                    can fail. `dismissTip` never rejects on the server, but the
 *                    fetch that carries it can, so the call is caught too.
 *
 * Nothing waits on the write, and nothing reads its result: the card is already
 * gone by then.
 *
 * Mount-gated rather than rendered straight from `dismissed`. sessionStorage
 * cannot be read while rendering on the server, and reading it during the first
 * client render would disagree with the HTML and trip hydration. The cost is
 * that the card arrives a frame after paint; the alternative is a card that
 * flashes on screen and vanishes.
 */

function sessionKey(tipKey: TipKey): string {
  return `remotiv.tip.${tipKey}`;
}

function dismissedThisSession(tipKey: TipKey): boolean {
  try {
    return sessionStorage.getItem(sessionKey(tipKey)) === "1";
  } catch {
    // Private windows and blocked site data. Absent storage is not a dismissal.
    return false;
  }
}

/**
 * Rendered only when the page has already decided this tip is due — the stored
 * dismissal is read server-side, where the member id lives. This component owns
 * the session layer and nothing else.
 */
export function TipCard({ tipKey }: { tipKey: TipKey }) {
  const guide = getGuide(tipKey);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (dismissedThisSession(tipKey)) return;
    setOpen(true);
  }, [tipKey]);

  if (!guide || !open) return null;

  function handleDismiss() {
    setOpen(false);
    try {
      sessionStorage.setItem(sessionKey(tipKey), "1");
    } catch {
      // Nothing to do: the card is already closed for this render.
    }
    // Best-effort and unawaited. The catch is for the transport, not the action.
    void dismissTip(tipKey).catch(() => {});
  }

  return (
    <div className="mb-5 flex gap-3 rounded-[14px] border border-[rgba(76,141,217,0.26)] bg-[var(--ai-sky-tint)] px-4 py-3.5">
      <Lock className="mt-[3px] size-[17px] shrink-0 text-[var(--ai-sky-ink)]" strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="m-0 mb-1 font-heading text-[14.5px] font-extrabold tracking-[-0.02em] text-[var(--ai-sky-ink)]">
          {guide.title}
        </p>
        {guide.body.map((para) => (
          <p
            key={para}
            className="m-0 mb-1 text-[13px] leading-relaxed text-[var(--ai-sky-ink)] last:mb-0"
          >
            {para}
          </p>
        ))}
        <p className="m-0 mt-1.5 text-[11.5px] leading-relaxed text-[var(--ai-sky-ink)] opacity-70">
          Reopen this any time from Help, in the sidebar.
        </p>
        <button
          type="button"
          onClick={handleDismiss}
          className="mt-2.5 rounded-[9px] border border-[rgba(76,141,217,0.4)] bg-[var(--ai-surface)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--ai-sky-ink)] transition-colors hover:bg-white"
        >
          Got it
        </button>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={`Dismiss tip: ${guide.title}`}
        className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--ai-sky-ink)] opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="size-4" strokeWidth={2.4} />
      </button>
    </div>
  );
}
