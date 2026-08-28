/**
 * The four inline icons the careers page uses.
 *
 * Path data rather than an icon package: these are the only four on the page,
 * the design specifies a stroke width per use site, and pulling a dependency in
 * for four paths would ship a library to a public page that needs none.
 *
 * Deliberately NOT a "use client" module even though the client roles index
 * imports it. `Icon` takes no hooks and no handlers, so it works on both sides
 * of the boundary; marking it client-only would drag the plain path constants
 * across with it and make them unusable from the server page.
 */

/** → Row arrow, and the header "All roles" link. */
export const ARROW = "M4 12h15M13 6l6 6-6 6";
/** ↓ "See N open roles" — the CTA scrolls rather than navigates. */
export const CHEVRON_DOWN = "M12 5v14M6 13l6 6 6-6";
/** ↗ Any link that leaves for the company's own site. */
export const EXTERNAL = "M7 17 17 7M9 7h8v8";

export function Icon({ d }: { d: string }) {
  return (
    // Decorative: every icon sits beside its own text label, so aria-hidden is
    // the correct treatment and a <title> would be announced twice.
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
