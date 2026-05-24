"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Mirrors /browse-talent's toast contract verbatim:
//   - TOAST_DURATION_MS = 3500
//   - TOAST_MESSAGE = the exact coming-soon string
// On /pricing the plans are already visible on the page, so the CTA goes
// straight to the toast — no modal (the modal exists only to surface pricing
// on pages where it isn't already shown, e.g. browse-talent / ai-results).
//
// PORTAL: the toast is rendered into document.body via createPortal so that
// `position: fixed` always anchors to the viewport. Without the portal, the
// Pro tier card's `lg:scale-[1.03]` transform becomes a containing block for
// fixed-positioned descendants — the toast would render mid-page relative to
// the transformed card instead of bottom-left of the viewport. Starter (no
// transform) wasn't affected, which is what made the bug per-tier.
const TOAST_DURATION_MS = 3500;
const TOAST_MESSAGE = "🔒 Subscriptions coming soon. Check back later.";

export function TierCTA({ label, className }: { label: string; className: string }) {
  const [toast, setToast] = useState<string | null>(null);
  // SSR-safe mount guard: document.body isn't defined on the server, so the
  // portal must only run after the first client-side render.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      <button
        type="button"
        onClick={() => setToast(TOAST_MESSAGE)}
        className={className}
      >
        {label}
      </button>
      {mounted &&
        toast &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="fixed bottom-6 left-6 z-[1000] rounded-xl bg-[#111] px-4 py-3 font-sans text-[0.85rem] font-medium text-white shadow-[0_8px_32px_rgba(0,0,0,0.15)]"
          >
            {toast}
          </div>,
          document.body,
        )}
    </>
  );
}
