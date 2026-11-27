"use client";

import { useEffect } from "react";

/**
 * Ref-counted body scroll lock: THE one lock for the page.
 *
 * Every caller takes it through acquireBodyScrollLock (or this hook) and
 * releases it through the function that returns: the body stays locked until
 * every active caller has released. Callers never save and restore the
 * body's overflow themselves - two callers doing that, released in the wrong
 * order, leave the page stuck (the job drawer and its confirm dialog, 26 Nov).
 *
 * The count lives on the body (data-scroll-locks), so it survives a caller
 * unmounting while another is open. The body's own overflow and padding from
 * before the FIRST lock are kept and put back when the LAST lock is released.
 */

type LockedBody = {
  style: { overflow: string; paddingRight: string };
  dataset: { scrollLocks?: string };
};

/** What the body had before its first lock, per body. */
const originals = new WeakMap<LockedBody, { overflow: string; paddingRight: string }>();

/** The scrollbar `overflow: hidden` hides, so the page does not jump wider. */
function scrollbarWidth(): number {
  return window.innerWidth - document.documentElement.clientWidth;
}

/**
 * Take one lock. The returned function releases it, once: a second call does
 * nothing, so a cleanup that runs twice cannot release someone else's lock.
 */
export function acquireBodyScrollLock(
  body: LockedBody = document.body,
  measure: () => number = scrollbarWidth,
): () => void {
  const current = Number(body.dataset.scrollLocks ?? "0");
  body.dataset.scrollLocks = String(current + 1);
  if (current === 0) {
    originals.set(body, { overflow: body.style.overflow, paddingRight: body.style.paddingRight });
    // Compensate for the scrollbar that `overflow: hidden` hides. Without
    // this, the page jumps wider (~15px on Win/Linux Chrome/Edge, and on
    // any platform where the scrollbar occupies layout space) the moment
    // a modal opens - visible as a horizontal flash on open/close.
    const width = measure();
    body.style.overflow = "hidden";
    if (width > 0) body.style.paddingRight = `${width}px`;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Number(body.dataset.scrollLocks ?? "1") - 1;
    if (next > 0) {
      body.dataset.scrollLocks = String(next);
      return;
    }
    delete body.dataset.scrollLocks;
    const original = originals.get(body);
    originals.delete(body);
    body.style.overflow = original?.overflow ?? "";
    body.style.paddingRight = original?.paddingRight ?? "";
  };
}

/** The lock while `active`, released on unmount or when `active` turns false. */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return acquireBodyScrollLock();
  }, [active]);
}
