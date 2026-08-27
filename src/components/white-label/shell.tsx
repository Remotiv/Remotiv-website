import "./white-label.css";

/**
 * The scope root for the white-label public pages.
 *
 * Carries `data-wl-canvas`, which does three jobs at once:
 *
 *   1. it is the selector every token, the container and the focus ring hang
 *      off in white-label.css, so none of them can reach the marketing site or
 *      the dashboard;
 *   2. it is what `html:has([data-wl-canvas])` in globals.css and the root
 *      layout's critical CSS look for, to release the sitewide `#f8f4f1`
 *      background lock for these routes only;
 *   3. it makes the scope visible in devtools — a reader inspecting one of
 *      these pages can see immediately which rule set is in play.
 *
 * An ATTRIBUTE rather than a class, deliberately: a class named `wl` or
 * `careers` invites reuse, and reuse is what would let the background override
 * fire on a page that is not white-label.
 *
 * ── Why this is not a layout ─────────────────────────────────
 *
 * The two routes live in different top-level segments — /careers/[slug] and
 * /jobs/[slug] — so a single Next layout cannot wrap both without moving one
 * of them or introducing a route group. Both are larger changes than this
 * needs. A component each page renders is the smaller answer, and it keeps the
 * scope explicit at the page rather than implied by folder position.
 *
 * ── What this deliberately does NOT do ───────────────────────
 *
 * No <Navbar>. The design has its own sticky company header (.chead, 64px,
 * showing the company's mark and name) and the two cannot both be right. The
 * pages must not render the Remotiv navbar; there is nothing here to suppress
 * because nothing here adds it.
 *
 * The site footer comes from the ROOT layout, which this component sits inside
 * and cannot reach — that one is handled in footer-wrapper.tsx.
 */
export function WhiteLabelShell({ children }: { children: React.ReactNode }) {
  return <div data-wl-canvas>{children}</div>;
}
