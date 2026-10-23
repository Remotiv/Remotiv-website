import type { InterviewListResult, InterviewTab } from "@/lib/interviews/review-types";
import type { Read } from "@/lib/supabase/read";

/**
 * What the Interviews list is allowed to display after a read that can fail.
 *
 * ── Why this is a module and not two useStates ───────────────
 *
 * There is no DOM test runner in this repo, so a decision left inside the
 * component can only be checked by matching source text — which proves nothing
 * about what it does. The rule that matters here is one line long and very easy
 * to get wrong in a hurry, so it lives where a test can execute it. Same split,
 * and the same reason, as applicants/counts-state.ts.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 * A failure NEVER clears what is on screen, and never gets rendered as if it
 * had worked. Those are two halves of one requirement:
 *
 *   - Blanking the page on a failed refresh takes away the view the reader was
 *     working through, to replace it with less information than they had.
 *   - Keeping the numbers without saying they are old states them as current,
 *     which is the failure mode this whole commit exists to remove.
 *
 * So `shown` survives and `failed` travels with it, and the surface says so.
 * The chips are labelled from `shown.applied` — the filter the SERVER resolved
 * — so stale numbers are at least stale numbers for the filter they describe,
 * rather than old numbers wearing the new filter's name.
 *
 * ── What this does not solve ─────────────────────────────────
 *
 * Responses are applied in the order they arrive, so two reads in flight can
 * still settle out of order and leave the older one showing. It is not the bug
 * being fixed and it is no longer a mislabelling: whatever settles last is
 * labelled with its own filter, so the strip agrees with its own rows either
 * way. The monotonic-sequence fix for it is in applicants/counts-state.ts if it
 * is ever worth having here.
 */

/** A read's full input. Held on failure so Retry can re-ask the same question. */
export type ListParams = {
  status: InterviewTab;
  jobId: string | null;
  query: string;
  page: number;
};

export type ListState = {
  /** The newest result that came back ok. Never cleared by a later failure. */
  shown: InterviewListResult | null;
  /**
   * The newest read failed. With `shown` set this means the figures are stale;
   * with `shown` null it means nothing has ever loaded.
   */
  failed: boolean;
  /** The params the failed read was attempted with. Null when nothing failed. */
  retry: ListParams | null;
};

/**
 * The state the page starts in, holding the server render's own answer.
 *
 * A failed server pass seeds `failed` rather than an empty slate: the page
 * knows the read did not work and has to say so, not sit in a first-paint state
 * that looks like it is still loading — and certainly not fall through to the
 * day-one empty state, which would tell a company with interviews that it has
 * none.
 */
export function seedList(initial: Read<InterviewListResult>, params: ListParams): ListState {
  return {
    shown: initial.ok ? initial.value : null,
    failed: !initial.ok,
    retry: initial.ok ? null : params,
  };
}

/**
 * A response came back.
 *
 * `params` is here so a failure can be retried with the question that failed
 * rather than with whatever the filters say by the time the reader clicks.
 *
 * Note what a failed RETRY does: nothing changes except the params held, so the
 * stale view holds rather than degrading a second time. A reader who clicks
 * Retry twice must not end up with less than they started with.
 */
export function applyLoad(
  state: ListState,
  result: Read<InterviewListResult>,
  params: ListParams,
): ListState {
  if (!result.ok) return { ...state, failed: true, retry: params };
  return { shown: result.value, failed: false, retry: null };
}
