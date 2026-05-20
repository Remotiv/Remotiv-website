"use client";

import { useEffect, type RefObject } from "react";

/**
 * Focus trap hook for modal-like UIs. While `active` is true:
 * - Focuses the first focusable element inside `containerRef` on mount
 * - Cycles Tab / Shift+Tab within the container
 * - Restores focus to the previously-focused element when deactivated
 *
 * The container ref must point to an element that wraps all focusable
 * content. Disabled or `inert` elements are skipped.
 *
 * Mirrors the pattern used inline by ProfileModal; centralized here so
 * PricingModal, the filter drawer, and any future modal can reuse it.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = (document.activeElement as HTMLElement | null) ?? null;

    const getFocusable = (): HTMLElement[] => {
      const selector =
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(container.querySelectorAll<HTMLElement>(selector))
        .filter((el) => !el.hasAttribute("inert") && el.offsetParent !== null);
    };

    // Set initial focus on first focusable element
    const initial = getFocusable()[0];
    initial?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusable();
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef]);
}
