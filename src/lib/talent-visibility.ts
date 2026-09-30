/**
 * One definition of "this profile is publicly visible", for both talent pools.
 *
 * ── Why this file exists ─────────────────────────────────────
 *
 * Before it, six public paths each decided for themselves and all six decided
 * wrong: the sitemap, the AI match cache rehydration, the profile OG image,
 * fetchProfileDetail (no check at all), the unlock RPC, and the freelancer
 * marketplace, which used a different predicate from the profile page serving
 * the same rows. A row moved to `shortlisted` or `placed` fell between the
 * page's rule and the marketplace's.
 *
 * ── The two predicates ───────────────────────────────────────
 *
 *   talent_profiles       approved_at is not null
 *                         and is_paused = false
 *                         and is_archived = false
 *
 *   hire_remote_profiles  approved_at is not null
 *                         and status in ('approved','shortlisted','placed')
 *
 * The talent one restates migration 014's stated rule, which is also the
 * partial index `idx_talent_profiles_public_visible`, so the index still
 * covers every query that goes through here.
 *
 * The freelancer one is a WHITELIST, deliberately. A blacklist of paused and
 * archived makes every future or unrecognised status public by default, which
 * is the shape of the bug this file closes. A whitelist fails closed: an
 * unknown status is hidden until someone adds it here on purpose. It also
 * matches how the sister table treats the same labels, where `is_shortlisted`
 * and `is_placed` are orthogonal to visibility.
 *
 * ── This is not the only copy ────────────────────────────────
 *
 * The unlock RPC is a Postgres function and cannot import TypeScript, so the
 * same rule is written a second time in
 * `src/lib/supabase/migrations/034_unlock_requires_public_profile.sql`.
 * Two expressions, one meaning. `talent-visibility.test.ts` compares them and
 * fails if they drift, which is the only thing keeping them honest.
 */

/** The visible `hire_remote_profiles.status` values, in one place. */
export const PUBLIC_REMOTE_STATUSES = ["approved", "shortlisted", "placed"] as const;

/** PostgREST-safe rendering of the whitelist, e.g. `("approved","shortlisted",...)`. */
const REMOTE_STATUS_IN = `(${PUBLIC_REMOTE_STATUSES.map((s) => `"${s}"`).join(",")})`;

/**
 * The subset of a PostgREST filter builder this module needs.
 *
 * Not written as `<T extends Filterable<T>>`: that constraint is recursive, and
 * against Supabase's own generated builder types it makes tsc give up with
 * TS2589 ("type instantiation is excessively deep"). So the generic stays free
 * and the cast is confined to these two functions, which is the right place for
 * it - callers keep their exact builder type on the way in and out.
 */
type Filterable = {
  not(column: string, operator: string, value: unknown): Filterable;
  eq(column: string, value: unknown): Filterable;
  in(column: string, values: readonly unknown[]): Filterable;
};

/**
 * Restrict a `talent_profiles` query to publicly visible rows.
 *
 * Call this on EVERY path a non-owner can reach. Returns the builder so it
 * chains: `publicTalent(supabase.from("talent_profiles").select(COLS))`.
 */
export function publicTalent<T>(query: T): T {
  return (query as Filterable)
    .not("approved_at", "is", null)
    .eq("is_paused", false)
    .eq("is_archived", false) as T;
}

/** Restrict a `hire_remote_profiles` query to publicly visible rows. */
export function publicRemote<T>(query: T): T {
  return (query as Filterable)
    .not("approved_at", "is", null)
    .in("status", PUBLIC_REMOTE_STATUSES) as T;
}

/**
 * The same rule as a raw PostgREST query-string fragment, for the one caller
 * that builds its URL by hand rather than through the builder.
 */
export const PUBLIC_REMOTE_FILTER = `&approved_at=not.is.null&status=in.${REMOTE_STATUS_IN}`;

/** The fields the in-memory predicates read. Nullable exactly as the columns are. */
export type TalentVisibilityFields = {
  approved_at: string | null;
  is_paused: boolean | null;
  is_archived: boolean | null;
};

export type RemoteVisibilityFields = {
  approved_at: string | null;
  status: string | null;
};

/**
 * Is this already-fetched `talent_profiles` row publicly visible?
 *
 * For the two cases a filter cannot serve: deciding whether a row that was
 * fetched WITHOUT the filter should be shown (the owner-gated unavailable
 * state), and dropping rows from a cached ranking. Null flags count as hidden,
 * so a column that somehow has no value fails closed.
 */
export function isTalentPublic(row: TalentVisibilityFields | null | undefined): boolean {
  if (!row) return false;
  return row.approved_at !== null && row.is_paused === false && row.is_archived === false;
}

/** Is this already-fetched `hire_remote_profiles` row publicly visible? */
export function isRemotePublic(row: RemoteVisibilityFields | null | undefined): boolean {
  if (!row) return false;
  if (row.approved_at === null) return false;
  return (PUBLIC_REMOTE_STATUSES as readonly string[]).includes(row.status ?? "");
}

/** The columns a caller must select for `isTalentPublic` to be answerable. */
export const TALENT_VISIBILITY_COLUMNS = "approved_at, is_paused, is_archived";

/** The columns a caller must select for `isRemotePublic` to be answerable. */
export const REMOTE_VISIBILITY_COLUMNS = "approved_at, status";
