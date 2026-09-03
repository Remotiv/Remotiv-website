import { type BrandPreset, brandTokens, DEFAULT_PRESET } from "./brand";
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
/**
 * Which white-label page this is. REQUIRED on every page, not optional.
 *
 * ── Why this is not cosmetic ─────────────────────────────────
 *
 * The two designs reuse class names for DIFFERENT things. `.rail` is the
 * careers masthead's four-cell stat grid and the job page's right-hand column.
 * `.panel`, `.panel .top`, `.panel h1` and `.foot` all carry different values on
 * each page too.
 *
 * That would be harmless if only one stylesheet were ever loaded, and it isn't.
 * Measured: navigating from /careers/x to /jobs/y client-side leaves BOTH sheets
 * in the document.
 *
 * ── What the first version of this got wrong ─────────────────
 *
 * It prefixed only the job page, and left careers on the bare [data-wl-canvas]
 * "because careers' class names don't appear on the job page". Two things were
 * false in that sentence. The names DO appear — `.rail` on both — and, more
 * importantly, a prefix on one side is not a defence at all: specificity only
 * decides between two rules that declare the SAME property. Careers' `.rail`
 * set `margin: 52px -48px 0` and `border-top`; the job page's `.rail` set
 * neither, so there was nothing to outrank them and they applied. The result at
 * 2400px was the right column pulled 32px over the body text and two sidebar
 * cards with different padding.
 *
 * So BOTH pages carry their attribute, and both sheets are scoped to it. Neither
 * can reach the other no matter what property either one adds later, which is
 * the only version of this that stays fixed.
 */
type WhiteLabelPage = "job" | "careers";

export function WhiteLabelShell({
  children,
  page,
  preset = DEFAULT_PRESET,
}: {
  children: React.ReactNode;
  page?: WhiteLabelPage;
  /**
   * The company's chosen brand. Defaults to Plum, which is what every company
   * that has never set one renders as — and what the CSS fallback already is.
   */
  preset?: BrandPreset;
}) {
  /*
   * INLINE, on the same element the tokens are scoped to.
   *
   * An inline style beats `[data-wl-canvas]`'s specificity, so the literals in
   * white-label.css keep doing their job — they are the frame if this element
   * ever renders without a style — while these override them for the four
   * non-default presets. Server-rendered, so the correct brand is in the HTML
   * and there is no repaint to see.
   */
  return (
    <div data-wl-canvas data-wl-page={page} style={brandTokens(preset) as React.CSSProperties}>
      {children}
    </div>
  );
}
