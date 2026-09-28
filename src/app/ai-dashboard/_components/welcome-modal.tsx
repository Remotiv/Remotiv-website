"use client";

import {
  CalendarCheck,
  ClipboardCheck,
  Lock,
  type LucideIcon,
  ScanSearch,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dismissTip } from "@/app/ai-dashboard/(gated)/tip-actions";
import { WELCOME_FEATURES, type WelcomeFeatureId } from "@/app/ai-dashboard/lib/tips";

/**
 * What the product does, once per member, on the way into the dashboard.
 *
 * ── Which of the eight it follows ────────────────────────────
 *
 * The centred one: `InviteModal` in the team client. Same scrim
 * (`bg-[rgba(20,16,32,0.4)]` with a blur), same 24px white card, same dark
 * hero header over a body, same body-scroll lock. The Help panel copied
 * RolePermissionsDrawer because a reference panel belongs at the edge; this
 * one interrupts, so it copies the modal that interrupts.
 *
 * Two deliberate departures from it, both because this one blocks:
 *
 *   No scrim button. InviteModal lets a click outside close it. Here the
 *   scrim is inert — a stray click behind the card should not spend the one
 *   time this is shown. Escape and the button are the ways out.
 *   One dismiss control. Not an X in the corner AND a button underneath: two
 *   controls doing one job is the thing the brief rules out.
 *
 * ── Focus ────────────────────────────────────────────────────
 *
 * Focus moves to the button on open and is trapped: Tab wraps inside the
 * dialog rather than walking the dashboard underneath, which is reachable to a
 * screen reader even while it is visually covered. On dismissal focus goes to
 * <main>, so the next Tab starts at the top of the page just uncovered rather
 * than back at the browser chrome.
 *
 * ── Rendered with the page, not after it ─────────────────────
 *
 * No mount gate, unlike TipCard. This is in the server HTML of the overview,
 * so it covers the dashboard in the first paint rather than a frame later —
 * a blocking modal that arrives late is a dashboard you can read and click
 * first. The session fallback can therefore only ever HIDE it, never reveal
 * it, which is the safe direction for a flash.
 */

const ICONS: Record<WelcomeFeatureId, LucideIcon> = {
  cv: ScanSearch,
  interviews: Video,
  scorecards: ClipboardCheck,
  booking: CalendarCheck,
  access: Lock,
};

const SESSION_KEY = "remotiv.tip.welcome";

function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    // Private windows and blocked site data. Absent storage is not a dismissal.
    return false;
  }
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function WelcomeModal() {
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /**
   * Three layers, only one of them durable — the Team tip's arrangement:
   * state closes it now, sessionStorage holds it closed across navigations in
   * this tab, and the row is the only thing that survives a reload. The write
   * is unawaited and caught: `dismissTip` cannot reject on the server, but the
   * fetch carrying it can, and a modal that reappeared because a request timed
   * out would be worse than one nobody recorded.
   *
   * Reads no state, so it is stable for the life of the component and the
   * Escape/trap effect below can depend on it without re-running.
   */
  const close = useCallback(() => {
    setOpen(false);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // Nothing to do: it is already closed for this render.
    }
    void dismissTip("welcome").catch(() => {});

    // Somewhere sensible: the page this was covering. tabIndex -1 makes it
    // focusable without adding a tab stop.
    const main = document.querySelector("main");
    if (main) {
      main.tabIndex = -1;
      main.focus();
    }
  }, []);

  // The only thing the session layer may do is close it — see the note above.
  useEffect(() => {
    if (dismissedThisSession()) setOpen(false);
  }, []);

  /*
   * Keyed on `open`, not mount. Dismissing returns null but does NOT unmount
   * this component, so a cleanup that ran only on unmount would leave
   * `body { overflow: hidden }` behind and hand the reader a dashboard they
   * cannot scroll — the exact failure this modal exists to get out of the way
   * of. Closing has to release what opening took.
   */
  useEffect(() => {
    if (!open) return;

    buttonRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped the panel
      // entirely — which it has on the very first Tab after a click on the scrim.
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-4 backdrop-blur-sm min-[630px]:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        className="flex max-h-[min(95vh,780px)] w-full max-w-[560px] flex-col overflow-hidden rounded-[24px] bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        {/* Dark hero. Every <p> sets its colour explicitly — the DS ships a
            global `p { color:#444 }` that beats an inherited white. */}
        <div className="shrink-0 bg-[var(--ai-sidebar)] px-6 pb-[18px] pt-5 min-[630px]:px-7">
          <h2
            id="welcome-modal-title"
            className="font-heading text-[22px] font-extrabold tracking-[-0.028em] text-white"
          >
            Welcome to Remotiv
          </h2>
          <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
            Five things this dashboard does that are easy to miss.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 min-[630px]:px-7">
          {WELCOME_FEATURES.map((feature) => {
            const Icon = ICONS[feature.id];
            return (
              <div key={feature.id} className="mb-3 flex gap-3 last:mb-0">
                <span className="mt-px flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
                  <Icon className="size-[17px]" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <p className="m-0 mb-0.5 font-heading text-[14px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
                    {feature.title}
                  </p>
                  <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ai-t2)]">
                    {feature.line}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-[var(--ai-line)] px-6 py-[15px] min-[630px]:flex-row min-[630px]:items-center min-[630px]:justify-between min-[630px]:px-7">
          <p className="m-0 text-[12px] leading-relaxed text-[var(--ai-t3)]">
            This list lives in Help, in the sidebar. Reopen it any time.
          </p>
          <button
            ref={buttonRef}
            type="button"
            onClick={close}
            className="shrink-0 rounded-xl bg-remotiv-purple px-[18px] py-[11px] text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)]"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
