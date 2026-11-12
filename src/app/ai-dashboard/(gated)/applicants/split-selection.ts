/**
 * Who the Applicants Split panel shows (Applicants Split, commit 5c).
 *
 * Pure, so the rule is testable without a browser. The client calls it from
 * an effect that only ever sets state: an auto-selected row is NOT written to
 * the URL. Only a click on a row writes `?applicant=` (docs/design/
 * Applicants_Split_v9.md, state 11).
 */

/**
 * The real browser width at which the list and the panel sit side by side.
 * A media query, so it reads the unzoomed viewport: the shell's 0.82 zoom does
 * not change it (v9 section 5, "real browser width").
 */
export const SPLIT_MIN_WIDTH_QUERY = "(min-width: 1100px)";

/**
 * The applicant the panel should show, given what it showed before.
 *
 * - The current selection stays while it is on the page, or while the URL
 *   names it (a deep link or an earlier click: the URL wins, even when that
 *   person is not on this page).
 * - Otherwise a `?applicant=` in the URL is used.
 * - Otherwise the first row of the page, so the panel is never blank.
 * - An empty page selects nobody, and the panel is not drawn.
 */
export function autoSplitSelection(
  prev: string | null,
  pageIds: readonly string[],
  deepLinkId: string | null,
): string | null {
  if (prev && (prev === deepLinkId || pageIds.includes(prev))) return prev;
  if (deepLinkId) return deepLinkId;
  return pageIds[0] ?? null;
}
