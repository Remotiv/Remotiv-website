"use client";

import { usePathname } from "next/navigation";
import { Footer } from "./footer";

/** The segment and everything under it. */
const HIDDEN_PREFIXES = [
  "/admin",
  "/ai-dashboard", // hides footer on all /ai-dashboard/* product pages
  "/careers", // white-label company careers pages — they carry their own footer
  "/login",
  "/client", // hides footer on all /client/* pages
  "/client/login",
  "/interview", // public candidate interview — its own footer, no site chrome
  "/signin",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/auth", // covers /auth/callback and /auth/reset
  "/talent/login",
  "/talent/dashboard",
];

/**
 * Children of the segment, but NOT the segment itself.
 *
 * Empty since /jobs/[slug] branched. It held "/jobs" while every job detail
 * page was going to be white-label; now a job with no company_id keeps the
 * editorial Remotiv page, which has no footer of its own, so hiding the site
 * footer by path took the only one it had.
 *
 * White-label pages suppress it by the presence of their canvas instead — see
 * `body:has([data-wl-canvas]) > footer` in white-label.css. That condition is
 * exact where a path prefix could only guess.
 */
const HIDDEN_CHILD_PREFIXES: string[] = [];

export function FooterWrapper() {
  const pathname = usePathname();
  const shouldHide =
    HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    HIDDEN_CHILD_PREFIXES.some((prefix) => pathname.startsWith(`${prefix}/`));
  if (shouldHide) return null;
  return <Footer />;
}
