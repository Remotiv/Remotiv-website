/**
 * Range-paged PostgREST reads. One copy, for everyone.
 *
 * ── Why this module exists ───────────────────────────────────
 *
 * There were three functions called `pageAll`, in three files, doing the same
 * job with three different failure behaviours: one logged and returned the
 * pages it had, one returned them without logging at all, one logged and
 * stopped at a row cap. The silent one was the worst, and it was the one
 * nobody would have found by reading either of the others. Consistency by
 * hand is what failed here, so the copies are gone.
 *
 * ── Why this file, specifically ──────────────────────────────
 *
 * IT MUST NEVER GAIN A "use server" DIRECTIVE.
 *
 * A `"use server"` module compiles EVERY export into a server action — a POST
 * endpoint anyone can call. Publishing a paging primitive that way would hand
 * the internet a parameterised database reader, which is a far worse problem
 * than the duplication this file removes. That is why it lives here and not
 * beside its callers: `(gated)/overview-actions.ts`, `weekly-report/actions.ts`
 * and `admin/analytics/actions.ts` are all `"use server"` modules, and a shared
 * helper cannot live in any of them. Parts of `src/lib` carry the directive too
 * (`slug.ts`, `screening.ts`, `jobs-queue.ts`), so "somewhere in lib" was not
 * good enough either — `src/lib/supabase/` is clean and is where PostgREST
 * range semantics belong.
 */

/** PostgREST returns at most 1000 rows per request by default. */
const PAGE = 1000;

export type PageAllOptions = {
  /** Where a failure came from, e.g. "overview". Prefixes the thrown message. */
  scope: string;
  /** What was being read, e.g. "applications". */
  label: string;
  /**
   * Stop after this many rows. Omit for unbounded.
   *
   * A deliberate bound, not an error: the caller has decided it would rather
   * have the first N rows than an unbounded read. Hitting it warns, because a
   * page of figures derived from a truncated set is exactly as wrong as one
   * derived from a failed read — it just fails a different way.
   */
  cap?: number;
};

/**
 * Read every row a query matches, a page at a time.
 *
 * ── A failed page throws ─────────────────────────────────────
 *
 * It does not return what it has. Callers aggregate these rows into counts,
 * funnels and reports, and none of them can tell a short read from a small
 * company — so a partial answer renders a complete-looking page whose every
 * number is wrong, plausible, and internally consistent. That is worse than an
 * error, because nothing about it invites a second look.
 *
 * The exception is an authorization set, where a short read narrows what
 * someone may see rather than corrupting a figure, and throwing would cost more
 * than it saves. `scopedApplicationIds` handles that case itself and
 * deliberately does not use this.
 */
export async function pageAll<T>(
  // PromiseLike, not Promise: a PostgREST query builder is thenable but has no
  // .catch/.finally, so it does not satisfy the Promise interface.
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  { scope, label, cap }: PageAllOptions,
): Promise<T[]> {
  const out: T[] = [];

  for (let from = 0; cap === undefined || from < cap; from += PAGE) {
    // Clamped, so a cap that is not a multiple of PAGE returns exactly `cap`
    // rows rather than rounding up to the next page boundary. The only cap in
    // use today divides exactly; this is so the next one need not.
    const to = (cap === undefined ? from + PAGE : Math.min(from + PAGE, cap)) - 1;

    const { data, error } = await build(from, to);
    if (error) {
      throw new Error(`[${scope}] ${label} failed at rows ${from}-${to}`, { cause: error });
    }

    const batch = (data ?? []) as T[];
    out.push(...batch);

    // A short page means the DATA ran out. Returning here rather than breaking
    // is what keeps the warning below honest: it must fire only when the cap
    // stopped the loop, never on the ordinary exit.
    if (batch.length < to - from + 1) return out;
  }

  // Only reachable with a cap set and every page full up to it.
  if (cap !== undefined) {
    console.warn(
      `[${scope}] ${label} hit the ${cap.toLocaleString("en-US")}-row cap — figures derived from it are truncated`,
    );
  }
  return out;
}
