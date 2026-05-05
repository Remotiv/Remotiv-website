"use client";

import { useEffect, useState } from "react";

/**
 * React hook that subscribes to a CSS media query and returns whether it
 * currently matches. SSR-safe: starts as `false` and updates after mount.
 *
 * Use this when a component needs to switch between mobile and desktop
 * markup at runtime (e.g. swapping a side drawer for a full-screen sheet).
 * Prefer Tailwind responsive classes for purely visual changes — this hook
 * is only worth the JS round-trip when the difference is structural.
 *
 * Tailwind's `lg:` breakpoint is 1024px, so the matching mobile query is
 * `(max-width: 1023px)`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
