"use client";

import { type RefObject, useEffect, useId, useRef } from "react";
import {
  escapeTarget,
  focusAfterClose,
  nextFocusTarget,
  outsideOf,
  pushEntry,
  removeEntry,
  type StackEntry,
  topId,
} from "@/lib/a11y/modal-stack";

/**
 * The one modal focus primitive (Phase 6, A6-16).
 *
 * While `active` is true the hook:
 *   - records the opener (whatever had focus) and moves focus into the panel;
 *   - makes everything OUTSIDE the overlay inert, so neither the keyboard nor a
 *     screen reader's virtual cursor can reach the page behind, and restores
 *     each element's previous `inert` state exactly on close;
 *   - traps Tab / Shift+Tab inside the panel, with pull-back when focus has
 *     escaped (the first Tab after a click on the scrim);
 *   - closes on Escape;
 *   - locks body scroll;
 *   - on close, returns focus to the opener if it is still in the document,
 *     otherwise into the parent modal.
 *
 * ── Nested modals ────────────────────────────────────────────
 *
 * Open modals form a module-level stack. Only the TOP entry traps, answers
 * Escape and owns the inert set; a parent whose child is open is suspended
 * and keeps its own opener. Closing the child restores the parent's inert set
 * and returns focus to the button inside the parent that opened it. One
 * Escape reaches one layer. The rules are pure and tested in
 * lib/a11y/modal-stack.ts; this file only touches the DOM.
 *
 * ── The one rule for callers ─────────────────────────────────
 *
 * `active` MUST be false until the container is rendered. A component that
 * portals its dialog after a mount guard passes the guard's state here, not a
 * literal `true`. Passing `true` on the first render of a not-yet-portalled
 * dialog was the bug that left the apply modal without a trap (A6-3).
 *
 * Not for menus, popovers or non-modal drawers: those must not trap Tab or
 * inert the page. They keep their own light-touch handling.
 */
export type ModalFocusOptions = {
  /** Called on Escape. Omit for a modal that must be closed by its own button. */
  onClose?: () => void;
  /** Where focus lands on open. Default: the container itself (made focusable). */
  initialFocus?: "container" | "first" | RefObject<HTMLElement | null>;
  /**
   * The element whose OUTSIDE becomes inert and whose inside is trapped for
   * Tab. Defaults to the container. Pass the overlay root when a scrim button
   * sits beside the panel, so the scrim keeps working.
   */
  overlayRef?: RefObject<HTMLElement | null>;
  /** Default true. */
  lockScroll?: boolean;
  /** Default true. */
  inertOutside?: boolean;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Marks an element that must stay live while a modal is open (live regions, toasts). */
export const INERT_EXEMPT_ATTR = "data-inert-exempt";

type Record = {
  id: string;
  container: () => HTMLElement | null;
  overlay: () => HTMLElement | null;
  options: () => ModalFocusOptions;
};

let stack: StackEntry<HTMLElement>[] = [];
const records = new Map<string, Record>();
/** Elements made inert for the current top, with the attribute they had before. */
let inerted: { el: Element; prev: string | null }[] = [];
let prevBodyOverflow: string | null = null;
let listening = false;

function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.offsetParent !== null,
  );
}

function restoreInert(): void {
  for (const { el, prev } of inerted) {
    if (prev === null) el.removeAttribute("inert");
    else el.setAttribute("inert", prev);
  }
  inerted = [];
}

function applyInert(overlay: HTMLElement): void {
  const targets = outsideOf<Element>(overlay, document.body, {
    parent: (n) => n.parentElement,
    children: (n) => Array.from(n.children),
    isExempt: (n) =>
      n.hasAttribute(INERT_EXEMPT_ATTR) || n.tagName === "SCRIPT" || n.tagName === "STYLE",
  });
  for (const el of targets) {
    inerted.push({ el, prev: el.getAttribute("inert") });
    el.setAttribute("inert", "");
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const top = topId(stack);
  if (!top) return;
  const rec = records.get(top);
  if (!rec) return;
  const opts = rec.options();

  if (e.key === "Escape") {
    if (escapeTarget(stack) === top && opts.onClose) {
      e.preventDefault();
      e.stopPropagation();
      opts.onClose();
    }
    return;
  }
  if (e.key !== "Tab") return;
  const scope = rec.overlay() ?? rec.container();
  if (!scope) return;
  const target = nextFocusTarget(
    focusablesIn(scope),
    document.activeElement as HTMLElement | null,
    e.shiftKey,
  );
  if (target) {
    e.preventDefault();
    target.focus();
  }
}

/** Re-derive everything that depends on which modal is on top. */
function sync(): void {
  restoreInert();
  const top = topId(stack);
  const rec = top ? records.get(top) : undefined;
  if (rec) {
    const opts = rec.options();
    const scope = rec.overlay() ?? rec.container();
    if (scope && opts.inertOutside !== false) applyInert(scope);
    if (!listening) {
      document.addEventListener("keydown", onKeyDown, true);
      listening = true;
    }
    const wantsLock = [...records.values()].some((r) => r.options().lockScroll !== false);
    if (wantsLock && prevBodyOverflow === null) {
      prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
  } else {
    if (listening) {
      document.removeEventListener("keydown", onKeyDown, true);
      listening = false;
    }
    if (prevBodyOverflow !== null) {
      document.body.style.overflow = prevBodyOverflow;
      prevBodyOverflow = null;
    }
  }
}

function moveInitialFocus(
  container: HTMLElement,
  initial: ModalFocusOptions["initialFocus"],
): void {
  if (initial && typeof initial === "object" && initial.current) {
    initial.current.focus();
    return;
  }
  if (initial === "first") {
    const first = focusablesIn(container)[0];
    if (first) {
      first.focus();
      return;
    }
  }
  if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
  container.focus();
}

export function useModalFocus<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  options: ModalFocusOptions = {},
): void {
  const id = useId();
  // Options are read through a ref so a fresh onClose closure each render
  // does not re-register the modal (which would re-run initial focus).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) {
      console.warn(
        "[useModalFocus] active before the container rendered - pass the mount guard's state as `active`",
      );
      return;
    }

    const opener = document.activeElement as HTMLElement | null;
    records.set(id, {
      id,
      container: () => containerRef.current,
      overlay: () => optionsRef.current.overlayRef?.current ?? null,
      options: () => optionsRef.current,
    });
    stack = pushEntry(stack, { id, opener: opener && opener !== document.body ? opener : null });
    sync();
    moveInitialFocus(container, optionsRef.current.initialFocus);

    return () => {
      const where = focusAfterClose(stack, id, (el) => document.contains(el));
      stack = removeEntry(stack, id);
      records.delete(id);
      sync();
      if (where.kind === "opener") where.target.focus();
      else if (where.kind === "parent") records.get(where.parentId)?.container()?.focus();
    };
  }, [active, containerRef, id]);
}
