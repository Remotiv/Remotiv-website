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
 * `/jobs` is the Remotiv-run board and keeps the site footer. `/jobs/<slug>` is
 * a white-label company page carrying the design's own `.foot`, which holds the
 * "Hiring powered by Remotiv · Privacy" line — legally load-bearing, per the
 * handoff, and duplicated if the site footer also renders.
 *
 * A plain prefix entry would take both, because the match above is `=== prefix
 * || startsWith(prefix + "/")` and the first half would catch the board.
 */
const HIDDEN_CHILD_PREFIXES = ["/jobs"];

export function FooterWrapper() {
  const pathname = usePathname();
  const shouldHide =
    HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    HIDDEN_CHILD_PREFIXES.some((prefix) => pathname.startsWith(`${prefix}/`));
  if (shouldHide) return null;
  return <Footer />;
}
