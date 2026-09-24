"use client";

import { LifeBuoy, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { GUIDES } from "@/app/ai-dashboard/lib/tips";

/**
 * Help: the product guides, reopenable after their tip has been dismissed.
 *
 * ── Why a ninth hand-rolled drawer ───────────────────────────
 *
 * There is no shared Dialog in this dashboard; eight files hand-roll their own
 * `role="dialog"` and they genuinely differ — modal cards that trap a form,
 * right-hand drawers that go full width on a phone, one with a scrim that only
 * exists above 840px. Lifting one of them into a shared primitive would have to
 * be built from a single new use case and then imposed on eight callers,
 * including two files this pass is not allowed to touch. So this copies the
 * closest sibling instead: RolePermissionsDrawer, which is also a read-only
 * reference panel — same Escape handler, same scroll lock, same scrim rules,
 * same dark header over a scrolling body.
 *
 * It adds one thing that drawer lacks: focus goes back to whatever opened it.
 * The trigger is a sidebar row, and losing focus to <body> on Escape would drop
 * a keyboard user at the top of the page.
 *
 * The list holds only guides that have shipped. The closing line says more are
 * coming rather than listing tips that do not exist yet.
 */
export function HelpPanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        aria-label="Close help"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm min-[840px]:block"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className="flex h-full w-full shrink-0 flex-col bg-[var(--ai-surface)] shadow-2xl outline-none min-[840px]:w-[420px]"
      >
        {/* Dark header. Every <p> sets its own colour — the DS ships a global
            `p { color:#444 }` that beats an inherited white. */}
        <div className="relative shrink-0 bg-[var(--ai-sidebar)] px-4 py-5 min-[840px]:px-6 min-[840px]:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 z-[2] flex size-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white min-[840px]:right-4 min-[840px]:top-4 min-[840px]:size-8"
          >
            <X className="size-5 min-[840px]:size-4" strokeWidth={2.5} />
          </button>
          <div className="relative z-[1] pr-8">
            <p className="m-0 mb-2 flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
              <LifeBuoy className="size-3" strokeWidth={2.2} />
              Help
            </p>
            <h2 className="font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white">
              How this works
            </h2>
            <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
              Short guides to the parts of the dashboard that are easy to miss. Each one also
              appears once on the page it belongs to.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {GUIDES.map((guide) => (
            <section
              key={guide.key}
              className="mb-4 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-4 py-3.5 last:mb-2"
            >
              <p className="m-0 mb-1.5 flex flex-wrap items-center gap-2">
                <span className="font-heading text-[14.5px] font-extrabold tracking-[-0.02em] text-[var(--ai-t1)]">
                  {guide.title}
                </span>
                <span className="rounded-[5px] bg-[var(--ai-inset)] px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[var(--ai-t3)]">
                  {guide.where}
                </span>
              </p>
              {guide.body.map((para) => (
                <p
                  key={para}
                  className="m-0 mb-1.5 text-[12.5px] leading-relaxed text-[var(--ai-t2)] last:mb-0"
                >
                  {para}
                </p>
              ))}
            </section>
          ))}

          <p className="m-0 rounded-xl bg-[var(--ai-inset)] px-3.5 py-3 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            More guides appear here as the features they describe ship. Nothing is listed before it
            works.
          </p>
        </div>
      </div>
    </div>
  );
}
