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
      body.style.overflow = "hidden";
    }
    return () => {
      const next = Number(body.dataset.scrollLocks ?? "1") - 1;
      if (next <= 0) {
        delete body.dataset.scrollLocks;
        body.style.overflow = "";
      } else {
        body.dataset.scrollLocks = String(next);
      }
    };
  }, [active]);
}
