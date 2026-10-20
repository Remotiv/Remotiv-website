/**
 * PostgREST search-term sanitising, shared by the applicants list and the
 * topbar search.
 *
 * ── Lifted, not rewritten ────────────────────────────────────
 *
 * This is the exact expression the applicants list has always used
 * (`search.replace(/[%,()]/g, " ")`), moved here so there is ONE of it. A
 * second sanitiser is how two surfaces end up disagreeing about what a user
 * typed, and the one that gets forgotten is the one that breaks.
 *
 * ── What each character would otherwise do ───────────────────
 *
 * These are fed into a PostgREST `.or()` string, whose grammar is
 * `col.op.value,col.op.value` with `()` for grouping. So:
 *
 *   `,`  ends the current filter and starts another. A comma in the value
 *        turns one filter into two, and the second is almost certainly not a
 *        valid one — a 400, or a filter nobody asked for.
 *   `(`  and `)` group filters. Unbalanced ones break the parse; balanced
 *        ones would let a typed string restructure the query's logic.
 *   `%`  is the SQL LIKE wildcard. Not injection, but a lone `%` matches
 *        every row and turns a keystroke into a full scan.
 *
 * All four become spaces rather than being stripped, so "Smith,Jones" reads
 * as two words instead of silently fusing into "SmithJones".
 *
 * ── What is NOT handled, deliberately reported ───────────────
 *
 *   `_`  is LIKE's single-character wildcard and passes through. "a_c" will
 *        match "abc". Harmless, occasionally surprising.
 *   `*`  PostgREST rewrites to `%` inside like/ilike, so it is a wildcard by
 *        another name and also passes through.
 *
 * Neither is a safety problem — both stay inside the value of a single
 * `ilike`, and neither can escape into the filter grammar. They are noted
 * because widening this regex would change what the applicants list matches,
 * and that is a product decision rather than a cleanup.
 */
export function sanitiseSearchTerm(raw: string): string {
  return raw.replace(/[%,()]/g, " ");
}

/**
 * How many words of a typed term are sent as filters.
 *
 * A pasted paragraph would otherwise become one `or=` parameter per word, and
 * the request URL is what breaks first. Dropping the tail WIDENS the search
 * rather than narrowing it — fewer ANDed terms match more rows — so the result
 * is always a superset of what was asked for, never a subset. That is the
 * direction a search box should fail in: too many results are visible, a
 * silently missing candidate is not.
 */
export const SEARCH_TOKEN_MAX = 6;

/**
 * A typed term as the words a server-side search ANDs together.
 *
 * ── Why words, and not the whole string ──────────────────────
 *
 * The client used to match a CONCATENATED `"${fullName} ${email}"` blob, so
 * `includes()` spanned the gap between fields. Three separate `ilike`s cannot:
 * no single column contains "sarah smith", so the term that matched a blob
 * matches no column. Splitting into words and requiring EVERY word to match
 * SOME column restores it — a suffix of one field and a prefix of the next are
 * each wholly inside a column, which is why every blob match survives.
 *
 * It is also deliberately WIDER than the blob was. Word order stops mattering,
 * so "Smith Sarah" now finds Sarah Smith, which the blob did not. The change is
 * visible as extra results, never as missing ones.
 *
 * ── Sanitise FIRST, then split. Not the other way round ──────
 *
 * This is correctness, not tidiness. `,` is the separator in PostgREST's
 * `or=(col.op.val,col.op.val)` grammar, so a comma surviving into a word would
 * split one filter into two. sanitiseSearchTerm turns `% , ( )` into spaces,
 * which is exactly where the word boundaries then fall — so "Smith,Jones"
 * arrives as two ANDed words, which is what a reader typing it meant.
 *
 * `_` and `*` still pass through as wildcards, per the note above.
 */
export function searchTokens(raw: string): string[] {
  return sanitiseSearchTerm(raw)
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, SEARCH_TOKEN_MAX);
}
