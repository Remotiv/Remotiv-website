/**
 * Where the applicant drawer's tab strip has to be scrolled for a given tab to
 * be fully readable.
 *
 * ── Why a function, and not `activeTab.scrollIntoView()` ────────────
 *
 * scrollIntoView walks ANCESTORS. The strip sits inside a drawer that has its
 * own scroll body, which sits inside the page, so asking the browser to reveal
 * a tab can also scroll the body or the page behind it: the tab arrives in view
 * and the pane the reader was reading has moved out from under them.
 *
 * ── Why not getBoundingClientRect either ────────────────────────────
 *
 * `.ai-shell` carries an unconditional `zoom: 0.82`, so rects come back in
 * VISUAL px while `scrollLeft`, `clientWidth` and `offsetLeft` are LAYOUT px.
 * The usual `rect.left - containerRect.left + scrollLeft` idiom mixes the two
 * and scrolls by 0.82 of the intended distance. Every input here is layout px,
 * and none of them is a rect.
 */

/**
 * The width of the strip's right-edge fade, and therefore the clearance a
 * revealed tab needs on either side.
 *
 * One constant for both on purpose: a tab scrolled to sit exactly on the right
 * edge would be under the fade and read as disabled. Whatever the fade covers,
 * the scroll has to clear.
 */
export const TAB_FADE_PX = 24;

const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max);

export function tabScrollLeft(view: {
  /** Where the strip is scrolled to now. */
  readonly scrollLeft: number;
  /** The strip's visible width. */
  readonly clientWidth: number;
  /** The strip's full content width. */
  readonly scrollWidth: number;
  /** The tab's left edge, in the strip's own content coordinates. */
  readonly itemLeft: number;
  readonly itemWidth: number;
}): number {
  const max = Math.max(0, view.scrollWidth - view.clientWidth);
  const start = view.itemLeft - TAB_FADE_PX;
  const end = view.itemLeft + view.itemWidth + TAB_FADE_PX;

  // A tab too wide to clear both edges at once aligns its START. A label
  // starts at its left edge, so a left-aligned partial tab can still be read
  // and a right-aligned one cannot. This runs first because the "already
  // clear" test below can never pass for such a tab.
  if (view.itemWidth + TAB_FADE_PX * 2 > view.clientWidth) return clamp(start, max);

  // Already clear of both edges: answer the CURRENT position, not a centred
  // one. Switching between two tabs that are both on screen should not slide
  // the strip under the reader's finger.
  if (start >= view.scrollLeft && end <= view.scrollLeft + view.clientWidth) {
    return clamp(view.scrollLeft, max);
  }

  if (start < view.scrollLeft) return clamp(start, max);

  return clamp(end - view.clientWidth, max);
}
