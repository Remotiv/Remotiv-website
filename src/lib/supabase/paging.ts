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
 * Read every row a query matches, a page at a time, BY OFFSET.
 *
 * ── Read this before using it: the limit, in plain words ─────
 *
 * This is order-by-id plus `.range()`. It is only for reads where the table
 * is QUIET for the duration of the read. The #56 reproduction (2026-10-28,
 * staging, 2,500-row job) proved what that means: one row inserted with an
 * id that sorts before the cursor, between two pages, made the next page
 * start one row late. The result had the same COUNT as the truth and was not
 * the truth: one row repeated, one row never read. A delete before the cursor
 * does the same in the other direction. Nothing in the result reveals it.
 *
 * For a read that must be complete while rows can arrive or leave, use
 * `pageAllByKey` below, which pages by `id > last` and cannot be shifted. This
 * function STAYS as it is, deliberately: its call sites were written against
 * offset semantics, and none of them has been audited for keyset, including
 * #43's. Changing them is a call-site decision, one at a time, not a swap in
 * here.
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

/**
 * The shape `pageAllByKey` needs from a query: a filter builder it can add
 * `id > last` to, then order and limit. Structural, so a PostgREST builder
 * satisfies it and so can a fake table in a test. `.gt()` must come before
 * `.order()`: supabase-js's `.order()` returns a transform builder that has
 * no filter methods left on it.
 */
export type KeysetQuery = {
  gt(column: string, value: string): KeysetQuery;
  order(column: string, opts: { ascending: boolean }): KeysetPage;
};
export type KeysetPage = {
  limit(count: number): PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Read every row a query matches, a page at a time, BY KEY.
 *
 * ── What this guarantees that pageAll cannot ─────────────────
 *
 * Each page is `WHERE id > <last id seen> ORDER BY id LIMIT n`. The cursor is
 * a value, not a position, so a row inserted or deleted before it cannot
 * shift the next page: the #56 reproduction that loses a row under pageAll
 * returns the complete set here (paging.test.ts reproduces both, by ID SET,
 * because the counts cancel). The one thing it does not return is a row
 * inserted during the read with an id below the cursor, which was never part
 * of the set the read began on.
 *
 * `id` is a uuid generated by `gen_random_uuid()` on every table this pages:
 * random, not time-ordered. Nothing here assumes id order means creation
 * order; it needs only a stable total order, which any unique column gives.
 * The caller's `select` MUST include `id`, or the cursor cannot advance; a
 * page that fails to advance it throws rather than looping.
 *
 * Same contract as pageAll otherwise: a failed page THROWS, with the scope
 * and label in the message, and nothing partial is returned.
 */
export async function pageAllByKey<T extends { id: string }>(
  build: () => KeysetQuery,
  { scope, label, cap }: PageAllOptions,
): Promise<T[]> {
  const out: T[] = [];
  let last: string | null = null;

  for (;;) {
    const room = cap === undefined ? PAGE : Math.min(PAGE, cap - out.length);
    if (room <= 0) break;

    let q = build();
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.order("id", { ascending: true }).limit(room);
    if (error) {
      throw new Error(`[${scope}] ${label} failed after id ${last ?? "(start)"}`, { cause: error });
    }

    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < room) return out;

    const next = batch[batch.length - 1]?.id;
    if (typeof next !== "string" || next.length === 0 || (last !== null && next <= last)) {
      throw new Error(
        `[${scope}] ${label}: a full page did not advance the id cursor (select must include id)`,
      );
    }
    last = next;
  }

  if (cap !== undefined) {
    console.warn(
      `[${scope}] ${label} hit the ${cap.toLocaleString("en-US")}-row cap — figures derived from it are truncated`,
    );
  }
  return out;
}
