import type { ApplicantCounts, PipelineStage } from "@/app/ai-dashboard/lib/applicant-types";

/**
 * Which server counts the Applicants page is allowed to display, and when.
 *
 * ── Why this is a module and not three useStates ─────────────
 *
 * The page's population figures used to be `array.length`, so they could not
 * be stale: the array was the render. Fetching them makes each one a response
 * that arrives at a moment unrelated to the one it was asked for, and gives
 * the page three new ways to state a number it cannot support:
 *
 *   1. A LATE response for a filter the reader has moved off. The naive guard
 *      is to remember which filter is current and drop anything else — and
 *      that is not enough. Switch job A → job B → job A and BOTH outstanding
 *      A requests carry the current key, so the first one, which is the stale
 *      one, passes the check and overwrites the newer figures. Hence a
 *      monotonic sequence as well: only the response to the newest request
 *      counts, and a matching key alone buys nothing.
 *
 *   2. The PREVIOUS filter's figures presented as the new filter's. Keeping
 *      the last known numbers on screen is the right call — blanking the hero
 *      on every filter change is worse — but only if the page says they are
 *      being refreshed. So `updating` travels with them and the surface shows
 *      it. Numbers that are a second old are fine; numbers that are a second
 *      old and claim to be current are not.
 *
 *   3. A FAILED read rendered as zero. That is the whole reason #2 exists at
 *      all: an array length cannot fail, a count can, and "0 applicants" over
 *      a company with two thousand of them is believed instantly because
 *      nothing about it looks broken. Every field is `number | null` and null
 *      renders as an em dash. A true zero stays 0.
 *
 * Pure on purpose. There is no DOM test runner in this repo, so anything left
 * in the component could only be checked by matching source text — which
 * proves nothing about behaviour. The decisions that can be wrong live here,
 * and the component keeps the fetch and the ref holding the counter.
 */

/** The filter a set of counts was read for. Equal keys mean interchangeable. */
export type CountsKey = string;

/**
 * The filter identity, as a string.
 *
 * Only `jobId` is in it. `search` and the Flagged chip are deliberately NOT:
 * search runs client-side over the loaded rows and keying on it would fire a
 * batch of head-counts per keystroke, and the Flagged chip narrows the LIST
 * rather than the population the hero describes — its own badge is already a
 * server aggregate and stays that way.
 */
export function countsKey(jobId: string | null): CountsKey {
  return jobId ?? "all";
}

export type CountsState = {
  /** The filter the page is displaying now. */
  key: CountsKey;
  /** The sequence number of the newest request issued. Only it may settle. */
  expected: number;
  /** A request for `key` is outstanding. */
  pending: boolean;
  /** The newest counts that were accepted, kept on screen across a refetch. */
  shown: ApplicantCounts | null;
  /** The key `shown` was read for — unequal to `key` means it is stale. */
  shownKey: CountsKey | null;
  /** The newest accepted response for `key` was a failure. */
  failed: boolean;
};

/**
 * The state the page starts in, holding the server pass's own answer.
 *
 * `counts` is null when the server batch failed, which is `failed` rather than
 * an empty slate: the page knows the read did not work and must say so, not
 * sit in a first-paint state that looks like it is still loading.
 */
export function seedCounts(key: CountsKey, counts: ApplicantCounts | null): CountsState {
  return {
    key,
    expected: 0,
    pending: false,
    shown: counts,
    shownKey: counts ? key : null,
    failed: counts === null,
  };
}

/**
 * A request is going out. `seq` must come from a monotonic counter the caller
 * owns — the reducer cannot mint it and stay pure, and a counter derived from
 * `expected + 1` inside a React reducer would double-count under StrictMode's
 * double invocation.
 *
 * A key change does NOT clear `shown`. The old figures stay visible and
 * `updating` goes true, so the reader sees numbers being refreshed rather than
 * the hero collapsing to dashes every time they pick a role.
 */
export function requestCounts(state: CountsState, key: CountsKey, seq: number): CountsState {
  return {
    ...state,
    key,
    expected: seq,
    pending: true,
    // A previous failure is not evidence about this request.
    failed: false,
  };
}

/**
 * A response came back. Applied only if it answers the newest request.
 *
 * Both conditions are checked even though `seq === expected` implies the key:
 * the sequence is the mechanism, the key is the statement of intent, and a
 * future caller resetting the counter would otherwise silently reopen case 1
 * above.
 */
export function settleCounts(
  state: CountsState,
  response: { key: CountsKey; seq: number; counts: ApplicantCounts | null },
): CountsState {
  if (response.key !== state.key || response.seq !== state.expected) return state;

  if (!response.counts) {
    // The batch itself failed — no numbers at all. Last-known figures are
    // dropped: holding them would present one filter's counts as another's
    // with nothing on screen to say the read had failed.
    return { ...state, pending: false, failed: true, shown: null, shownKey: null };
  }

  return {
    ...state,
    pending: false,
    failed: false,
    shown: response.counts,
    shownKey: response.key,
  };
}

/** What the surfaces render. Null in any field means unknown, never none. */
export type CountsView = {
  total: number | null;
  newThisWeek: number | null;
  openRoles: number | null;
  stages: Record<PipelineStage, number | null>;
  /**
   * The figures are being refreshed, or are for a filter the reader has since
   * moved off. Either way the surface must say so.
   */
  updating: boolean;
};

const NO_STAGES: Record<PipelineStage, number | null> = {
  applied: null,
  screening: null,
  shortlisted: null,
  interview: null,
  offer: null,
  hired: null,
  rejected: null,
};

/**
 * Collapse the state into the numbers to draw.
 *
 * A failed read and a first paint both produce all-null, which is correct:
 * neither knows anything. They differ in the copy the page shows alongside,
 * not in the figures.
 */
export function countsView(state: CountsState): CountsView {
  const shown = state.failed ? null : state.shown;
  return {
    total: shown?.total ?? null,
    newThisWeek: shown?.newThisWeek ?? null,
    openRoles: shown?.openRoles ?? null,
    stages: shown?.stages ?? NO_STAGES,
    updating: state.pending || (shown !== null && state.shownKey !== state.key),
  };
}

/** A count for display: the number, or an em dash when it is not known. */
export function countLabel(n: number | null): string {
  return n === null ? "—" : String(n);
}

/**
 * The page lede's opening clause.
 *
 * Three outcomes, and the third is the point: an unknown total says NOTHING
 * about how many people have applied. "No one has applied yet" is a claim
 * about their pipeline and would be the exact lie the em dash elsewhere exists
 * to prevent, stated in prose where no dash can warn the reader. The sentence
 * that follows stands alone, so omitting the clause leaves readable copy.
 */
export function ledeCount(total: number | null): string {
  if (total === null) return "";
  if (total === 0) return "No one has applied yet. ";
  return `${total} ${total === 1 ? "person has" : "people have"} applied across your open roles. `;
}

/**
 * A stage's share of the total, or null when either side is unknown.
 *
 * Both sides have to be known for the ratio to mean anything, and the total is
 * the SUM of the stages rather than its own query — so a readable stage over an
 * unreadable total cannot happen, and a 0% bar never stands for "we don't
 * know". A zero total yields 0, not a division by zero.
 */
export function stagePercent(value: number | null, total: number | null): number | null {
  if (value === null || total === null) return null;
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}
