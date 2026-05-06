"use client";

import { useEffect, useRef } from "react";

/**
 * Focus trap for modals + dialogs.
 *
 * Behavior when `open` is true:
 *   - Records the element that had focus before the modal opened
 *   - Moves focus to the first focusable element inside the container
 *   - Tab / Shift+Tab cycle within the container (no escape into the page
 *     beneath)
 *   - Escape calls onClose (if supplied)
 *
 * On close (or unmount), focus returns to the element that had it before.
 * Pair with role="dialog" + aria-modal="true" on the same container so
 * screen readers announce the dialog context.
 *
 * Usage:
 *   const ref = useFocusTrap(open, onClose);
 *   return <div ref={ref} role="dialog" aria-modal="true">...</div>;
 *
 * Caveat: only wires up the keyboard side of trapping. The visual backdrop
 * + click-outside-to-close still belong to the modal component itself.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose?: () => void,
) {
  const containerRef = useRef<T>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    // Defer focus-shift one tick so any in-render focus calls (e.g. the
    // modal's auto-focused first input) win — we only step in if nothing
    // inside the container has focus yet.
    const focusable = getFocusableElements(containerRef.current);
    queueMicrotask(() => {
      const active = document.activeElement;
      const inside = containerRef.current?.contains(active);
      if (!inside) {
        focusable[0]?.focus();
      }
    });

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusables = getFocusableElements(containerRef.current);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    const previouslyFocused = previouslyFocusedRef.current;
    return () => {
      document.removeEventListener("keydown", handleKey);
      // Defer the focus-restore so React has time to unmount before we
      // try to focus an element that might no longer be in the tree.
      queueMicrotask(() => {
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus();
        }
      });
    };
  }, [open, onClose]);

  return containerRef;
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  );
}
