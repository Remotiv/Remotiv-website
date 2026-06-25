"use client";

import { useEffect } from "react";

/**
 * Ref-counted body scroll lock.
 * Multiple components can call this simultaneously; the body stays
 * locked until every active caller has unmounted or set active=false.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    const current = Number(body.dataset.scrollLocks ?? "0");
    body.dataset.scrollLocks = String(current + 1);
    if (current === 0) {
      // Compensate for the scrollbar that `overflow: hidden` hides. Without
      // this, the page jumps wider (~15px on Win/Linux Chrome/Edge, and on
      // any platform where the scrollbar occupies layout space) the moment
      // a modal opens — visible as a horizontal flash on open/close.
      const scrollbarWidth =
        window.innerWidth - document.documentElement.clientWidth;
      body.style.overflow = "hidden";
      if (scrollbarWidth > 0) {
        body.style.paddingRight = `${scrollbarWidth}px`;
      }
    }
    return () => {
      const next = Number(body.dataset.scrollLocks ?? "1") - 1;
      if (next <= 0) {
        delete body.dataset.scrollLocks;
        body.style.overflow = "";
        body.style.paddingRight = "";
      } else {
        body.dataset.scrollLocks = String(next);
      }
    };
  }, [active]);
}
