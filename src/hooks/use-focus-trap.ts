"use client";

import type { RefObject } from "react";
import { useModalFocus } from "./use-modal-focus";

/**
 * Focus trap for modal-like UIs, kept for its existing callers (filter
 * drawers, pricing modal, hire-request wizard). Since Phase 6 it is a thin
 * wrapper over useModalFocus (the one implementation) with the same
 * semantics it always had: initial focus on the first focusable, Tab cycling,
 * focus restored on deactivate. It does NOT close on Escape, lock scroll or
 * inert the page - callers that want a true modal use useModalFocus directly.
 *
 * The container ref must point to an element that wraps all focusable
 * content, and `active` must be false until that element is rendered.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
): void {
  useModalFocus(containerRef, active, {
    initialFocus: "first",
    lockScroll: false,
    inertOutside: false,
  });
}
