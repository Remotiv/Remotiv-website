/**
 * Shapes and tuning for the topbar search.
 *
 * A plain module so the client component can import the constants: the search
 * action carries "use server" and may only export async functions, and the
 * results module reaches the service client.
 */

/**
 * Nothing runs below this. Two characters against a name column matches most
 * of a company and tells the searcher nothing, while costing a query on every
 * keystroke of a word they have not finished typing.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * How long a fast typist may pause before a query fires.
 *
 * 220ms sits under the ~250ms at which a pause starts to feel like lag, and
 * above the 100-150ms gap between keystrokes of someone typing quickly — so a
 * ten-character name costs one query rather than nine.
 */
export const SEARCH_DEBOUNCE_MS = 220;

/** Per group. The "see all" link is what covers the rest. */
export const GROUP_LIMIT = 5;

export type SearchKind = "applicant" | "job" | "member";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  /** Name, or job title. */
  title: string;
  /** Email, or the job's meta line. Never anything the lists don't show. */
  subtitle: string;
  href: string;
  /** Small trailing label — pipeline stage, job status, team role. */
  badge: string | null;
  /**
   * Set on an applicant who has an interview session, so the row can offer it
   * directly. Interviews are not a group of their own — see the module comment
   * on searchWorkspace.
   */
  interviewHref: string | null;
};

export type SearchGroup = {
  kind: SearchKind;
  label: string;
  hits: SearchHit[];
  /** True when the group was truncated at GROUP_LIMIT. */
  more: boolean;
  /** Where "see all" goes — the real list, pre-filtered by the same query. */
  allHref: string;
};

export type SearchResults = {
  /** Echoed back so a stale response can be discarded by the caller. */
  query: string;
  groups: SearchGroup[];
  total: number;
};

export const EMPTY_RESULTS: SearchResults = {
  query: "",
  groups: [],
  total: 0,
};
