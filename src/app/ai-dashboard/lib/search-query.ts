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
